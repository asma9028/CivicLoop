import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    incidentUpload: {
      findUnique: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

vi.mock('../config/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../middleware/auth.js', () => ({
  optionalAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!Object.hasOwn(req, 'user')) return res.status(401).json({ error: 'Authentication required' });
    next();
  },
}));

import { uploadsRouter } from './uploads.js';

const storageDirectory = fileURLToPath(new URL('../../uploads/', import.meta.url));
const temporaryFiles: string[] = [];

async function createImageWithMetadata() {
  return sharp({
    create: { width: 10, height: 8, channels: 3, background: { r: 20, g: 90, b: 140 } },
  }).jpeg().withExif({ IFD0: { Artist: 'synthetic fixture' } }).toBuffer();
}

async function requestUploadRoute(
  route: string,
  options: { method?: string; user?: { id: string; role: string }; body?: BodyInit } = {},
) {
  const app = express();
  app.use((req, _res, next) => {
    if (options.user) Object.assign(req, { user: options.user });
    next();
  });
  app.use('/api/uploads', uploadsRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Invalid upload' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: options.method ?? 'GET',
      body: options.body,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

import multer from 'multer';

describe('upload privacy and authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.incidentUpload.createMany.mockResolvedValue({ count: 1 });
  });

  afterEach(async () => {
    for (const filename of temporaryFiles.splice(0)) {
      try {
        await unlink(path.join(storageDirectory, filename));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  });

  it('stores only metadata-stripped image bytes', async () => {
    const formData = new FormData();
    formData.append('images', new Blob([await createImageWithMetadata()], { type: 'image/jpeg' }), 'evidence.jpg');

    const response = await requestUploadRoute('/api/uploads/', {
      method: 'POST',
      user: { id: 'citizen-1', role: 'CITIZEN' },
      body: formData,
    });
    const payload = await response.json() as { files: string[] };
    const storedName = payload.files[0]?.slice('/api/uploads/'.length);
    expect(response.status).toBe(201);
    expect(storedName).toBeTruthy();
    temporaryFiles.push(storedName!);

    const storedMetadata = await sharp(await readFile(path.join(storageDirectory, storedName!))).metadata();
    expect(storedMetadata.exif).toBeUndefined();
    expect(prismaMock.incidentUpload.createMany).toHaveBeenCalledWith({
      data: [{
        storedName,
        contentType: 'image/jpeg',
        uploadedByUserId: 'citizen-1',
      }],
    });
  });

  it('does not expose a private image to an unrelated citizen', async () => {
    const storedName = `${randomUUID()}.jpg`;
    prismaMock.incidentUpload.findUnique.mockResolvedValue({
      contentType: 'image/jpeg',
      uploadedByUserId: 'owner-1',
      isPublic: false,
      incident: {
        isPublic: false,
        reporterId: 'owner-1',
        departmentId: 'department-1',
        department: { status: 'ACTIVE' },
      },
    });

    const response = await requestUploadRoute(`/api/uploads/${storedName}`, {
      user: { id: 'citizen-2', role: 'CITIZEN' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Image not found' });
  });

  it('re-encodes legacy images before serving them', async () => {
    const storedName = `${randomUUID()}.jpg`;
    temporaryFiles.push(storedName);
    await mkdir(storageDirectory, { recursive: true });
    await writeFile(path.join(storageDirectory, storedName), await createImageWithMetadata(), { flag: 'wx' });
    prismaMock.incidentUpload.findUnique.mockResolvedValue({
      contentType: 'image/jpeg',
      uploadedByUserId: 'citizen-1',
      isPublic: true,
      incident: {
        isPublic: true,
        reporterId: 'citizen-1',
        departmentId: 'department-1',
        department: { status: 'ACTIVE' },
      },
    });

    const response = await requestUploadRoute(`/api/uploads/${storedName}`);
    const servedMetadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/jpeg');
    expect(servedMetadata.exif).toBeUndefined();
  });

  it('fails closed when a legacy image cannot be processed', async () => {
    const storedName = `${randomUUID()}.jpg`;
    temporaryFiles.push(storedName);
    await mkdir(storageDirectory, { recursive: true });
    await writeFile(path.join(storageDirectory, storedName), Buffer.from('synthetic invalid image'));
    prismaMock.incidentUpload.findUnique.mockResolvedValue({
      contentType: 'image/jpeg',
      uploadedByUserId: 'citizen-1',
      isPublic: true,
      incident: {
        isPublic: true,
        reporterId: 'citizen-1',
        departmentId: 'department-1',
        department: { status: 'ACTIVE' },
      },
    });
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await requestUploadRoute(`/api/uploads/${storedName}`);
      const body = await response.text();

      expect(response.status).toBe(500);
      expect(body).toContain('Unable to safely process this image');
      expect(body).not.toContain('synthetic invalid image');
    } finally {
      logError.mockRestore();
    }
  });

  it('preserves the authentication requirement for uploads', async () => {
    const formData = new FormData();
    formData.append('images', new Blob([await createImageWithMetadata()], { type: 'image/jpeg' }), 'evidence.jpg');

    const response = await requestUploadRoute('/api/uploads/', { method: 'POST', body: formData });

    expect(response.status).toBe(401);
    expect(prismaMock.incidentUpload.createMany).not.toHaveBeenCalled();
  });

  it('rejects malformed image content before creating upload records', async () => {
    const formData = new FormData();
    formData.append('images', new Blob([Buffer.from('not an image')], { type: 'image/jpeg' }), 'evidence.jpg');

    const response = await requestUploadRoute('/api/uploads/', {
      method: 'POST',
      user: { id: 'citizen-1', role: 'CITIZEN' },
      body: formData,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('safely processed') });
    expect(prismaMock.incidentUpload.createMany).not.toHaveBeenCalled();
  });

  it('preserves the 5 MB upload limit', async () => {
    const formData = new FormData();
    formData.append(
      'images',
      new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/jpeg' }),
      'oversized.jpg',
    );

    const response = await requestUploadRoute('/api/uploads/', {
      method: 'POST',
      user: { id: 'citizen-1', role: 'CITIZEN' },
      body: formData,
    });

    expect(response.status).toBe(413);
    expect(prismaMock.incidentUpload.createMany).not.toHaveBeenCalled();
  });
});
