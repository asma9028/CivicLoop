import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';

const maximumImageBytes = 5 * 1024 * 1024;
const maximumInputPixels = 40_000_000;

const supportedFormats = {
  'image/jpeg': { format: 'jpeg', extension: 'jpg' },
  'image/png': { format: 'png', extension: 'png' },
  'image/webp': { format: 'webp', extension: 'webp' },
} as const;

export type SafeImageMime = keyof typeof supportedFormats;

export interface ProcessedImage {
  buffer: Buffer;
  mime: SafeImageMime;
  extension: 'jpg' | 'png' | 'webp';
}

export async function processSafeImage(buffer: Buffer): Promise<ProcessedImage> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !(detected.mime in supportedFormats)) {
    throw new Error('Unsupported or invalid image');
  }

  const mime = detected.mime as SafeImageMime;
  const format = supportedFormats[mime];
  const image = sharp(buffer, { failOn: 'error', limitInputPixels: maximumInputPixels });
  const metadata = await image.metadata();
  if (metadata.format !== format.format) throw new Error('Image signature does not match its format');

  const oriented = image
    .rotate()
    .resize({ width: 8192, height: 8192, fit: 'inside', withoutEnlargement: true });

  let encoded: Buffer;
  if (format.format === 'jpeg') {
    encoded = await oriented.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  } else if (format.format === 'png') {
    encoded = await oriented.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  } else {
    encoded = await oriented.webp({ quality: 85 }).toBuffer();
  }

  if (encoded.length > maximumImageBytes) throw new Error('Processed image exceeds the upload limit');
  return { buffer: encoded, mime, extension: format.extension };
}
