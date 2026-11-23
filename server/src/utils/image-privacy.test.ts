import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processSafeImage } from './image-privacy.js';

function jpegWithExifAndGps() {
  const tiff = Buffer.alloc(82);
  tiff.write('II', 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);

  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(6, 18);

  tiff.writeUInt16LE(0x8825, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(38, 30);
  tiff.writeUInt32LE(0, 34);

  tiff.writeUInt16LE(1, 38);
  tiff.writeUInt16LE(0x0002, 40);
  tiff.writeUInt16LE(5, 42);
  tiff.writeUInt32LE(3, 44);
  tiff.writeUInt32LE(56, 48);
  tiff.writeUInt32LE(0, 52);
  tiff.writeUInt32LE(28, 56);
  tiff.writeUInt32LE(1, 60);
  tiff.writeUInt32LE(36, 64);
  tiff.writeUInt32LE(1, 68);
  tiff.writeUInt32LE(5000, 72);
  tiff.writeUInt32LE(1000, 76);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

describe('server-side image privacy processing', () => {
  it('removes EXIF and GPS while applying the original orientation', async () => {
    const source = await sharp({
      create: { width: 4, height: 2, channels: 3, background: { r: 30, g: 100, b: 160 } },
    }).jpeg().toBuffer();
    const sourceWithMetadata = Buffer.concat([
      source.subarray(0, 2),
      jpegWithExifAndGps().subarray(2, -2),
      source.subarray(2),
    ]);

    const originalMetadata = await sharp(sourceWithMetadata).metadata();
    expect(originalMetadata.orientation).toBe(6);
    expect(originalMetadata.exif).toBeDefined();

    const processed = await processSafeImage(sourceWithMetadata);
    const processedMetadata = await sharp(processed.buffer).metadata();

    expect(processed.mime).toBe('image/jpeg');
    expect(processedMetadata.exif).toBeUndefined();
    expect(processedMetadata.orientation).toBeUndefined();
    expect(processedMetadata.width).toBe(2);
    expect(processedMetadata.height).toBe(4);
  });

  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ] as const)('preserves the supported %s format', async (mime, format) => {
    const source = await sharp({
      create: { width: 16, height: 10, channels: 3, background: { r: 20, g: 80, b: 120 } },
    }).toFormat(format).toBuffer();

    const processed = await processSafeImage(source);

    expect(processed.mime).toBe(mime);
    expect((await sharp(processed.buffer).metadata()).format).toBe(format);
  });

  it('rejects malformed or unsupported image bytes instead of returning them', async () => {
    await expect(processSafeImage(Buffer.from('not an image'))).rejects.toThrow();
  });
});
