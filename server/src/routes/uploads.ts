import { Router } from 'express';
import multer from 'multer';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { prisma } from '../config/prisma.js';
import { hasActiveAuthorityDepartment } from '../utils/authorization.js';
import { processSafeImage } from '../utils/image-privacy.js';
import { logSafeError } from '../utils/safe-logger.js';

export const uploadsRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5, fields: 0 },
});
const storageDirectory = fileURLToPath(new URL('../../uploads/', import.meta.url));
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

uploadsRouter.get('/:storedName', optionalAuth, async (req, res) => {
  const { storedName } = req.params;
  if (typeof storedName !== 'string' || !/^[a-f0-9-]+\.(jpg|png|webp)$/i.test(storedName)) {
    return res.status(404).json({ error: 'Image not found' });
  }

  try {
    const uploadRecord = await prisma.incidentUpload.findUnique({
      where: { storedName },
      include: {
        incident: {
          select: {
            isPublic: true,
            reporterId: true,
            departmentId: true,
            department: { select: { status: true } },
          },
        },
      },
    });
    if (!uploadRecord) return res.status(404).json({ error: 'Image not found' });

    const { incident, uploadedByUserId, isPublic } = uploadRecord;
    let allowed = !incident && req.user?.id === uploadedByUserId;
    if (incident?.isPublic && isPublic) allowed = true;
    if (incident && !allowed && req.user) {
      allowed = req.user.role === 'ADMIN'
        || (req.user.role === 'CITIZEN'
          && (req.user.id === incident.reporterId || req.user.id === uploadedByUserId));
      if (req.user.role === 'AUTHORITY') {
        const profile = await prisma.authorityProfile.findUnique({
          where: { userId: req.user.id },
          include: { department: { select: { status: true } } },
        });
        allowed = allowed || hasActiveAuthorityDepartment(profile, incident.departmentId);
      }
    }
    if (!allowed) return res.status(404).json({ error: 'Image not found' });

    const storedImage = await readFile(path.join(storageDirectory, storedName));
    const processed = await processSafeImage(storedImage);
    if (processed.mime !== uploadRecord.contentType || !storedName.toLowerCase().endsWith(`.${processed.extension}`)) {
      return res.status(404).json({ error: 'Image not found' });
    }
    return res.type(processed.mime).send(processed.buffer);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Image not found' });
    }
    logSafeError('uploads.read', error, res.getHeader('X-Request-Id'));
    res.status(500).json({ error: 'Unable to safely process this image' });
  }
});

uploadsRouter.post('/', uploadLimiter, requireAuth, upload.array('images', 5), async (req, res) => {
  if (!['CITIZEN', 'AUTHORITY', 'ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'You do not have permission to upload evidence' });
  }
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files?.length) return res.status(400).json({ error: 'Select at least one image to upload' });

  const stored: string[] = [];
  const validated: { filename: string; mime: string; buffer: Buffer }[] = [];
  try {
    for (const file of files) {
      try {
        const processed = await processSafeImage(file.buffer);
        validated.push({
          filename: `${randomUUID()}.${processed.extension}`,
          mime: processed.mime,
          buffer: processed.buffer,
        });
      } catch {
        return res.status(400).json({ error: 'An image could not be safely processed. Choose a valid JPEG, PNG, or WebP image.' });
      }
    }
    await mkdir(storageDirectory, { recursive: true });
    try {
      for (const file of validated) {
        await writeFile(path.join(storageDirectory, file.filename), file.buffer, { flag: 'wx' });
      }
      await prisma.incidentUpload.createMany({
        data: validated.map((file) => ({
          storedName: file.filename,
          contentType: file.mime,
          uploadedByUserId: req.user!.id,
        })),
      });
    } catch (error) {
      await Promise.all(validated.map(async (file) => {
        try { await unlink(path.join(storageDirectory, file.filename)); }
        catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            logSafeError('uploads.cleanup', cleanupError, res.getHeader('X-Request-Id'));
          }
        }
      }));
      throw error;
    }
    for (const file of validated) {
      const filename = file.filename;
      stored.push(`/api/uploads/${filename}`);
    }
    res.status(201).json({ files: stored });
  } catch (error) {
    logSafeError('uploads.create', error, res.getHeader('X-Request-Id'));
    res.status(500).json({ error: 'Image upload failed' });
  }
});
