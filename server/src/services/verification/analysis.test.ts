import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { analyzeResolutionEvidence, validateVerificationAnalysis } from './analysis.js';

const validResult = {
  recommendation: 'UNCERTAIN',
  confidence: 35,
  evidenceRelevance: 50,
  apparentImprovement: 'NOT_COMPARABLE',
  evidenceQuality: 'LIMITED',
  potentialInconsistencies: [],
  explanation: 'The available information is not enough to determine the outcome.',
  recommendedNextAction: 'MANUAL_REVIEW',
};

afterEach(() => vi.unstubAllEnvs());

describe('AI resolution analysis', () => {
  it('accepts only the structured advisory result shape', () => {
    expect(validateVerificationAnalysis(validResult)).toEqual(validResult);
    expect(validateVerificationAnalysis({ ...validResult, confidence: 101 })).toBeNull();
    expect(validateVerificationAnalysis({ ...validResult, recommendation: 'APPROVE' })).toBeNull();
  });

  it('returns an uncertain manual-review fallback when Gemini is not configured', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const result = await analyzeResolutionEvidence({
      title: 'Broken streetlight',
      category: 'ELECTRICITY',
      description: 'The streetlight has stopped working near the public walkway.',
      locationText: 'Main Street',
      originalImageUrls: [],
      resolutionDescription: 'Repaired the streetlight and restored illumination.',
      workCompleted: 'Replaced the damaged lamp and tested it.',
      resolutionDate: new Date('2026-01-01T00:00:00.000Z'),
      resolutionImageUrls: [],
      history: [],
    });
    expect(result.provider).toBe('unavailable');
    expect(result.result.recommendation).toBe('UNCERTAIN');
    expect(result.result.recommendedNextAction).toBe('MANUAL_REVIEW');
    expect(result.contextHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('omits exact location and redacts contact details from the Gemini prompt', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    let requestBody = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      requestBody = String(options.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(validResult) }] } }],
      }), { status: 200 });
    }));

    await analyzeResolutionEvidence({
      title: 'Broken streetlight',
      category: 'ELECTRICITY',
      description: 'Contact the reporter at citizen@example.com about this streetlight.',
      locationText: '44 Cedar Avenue',
      originalImageUrls: [],
      resolutionDescription: 'Repaired the streetlight and restored illumination.',
      workCompleted: 'Replaced the damaged lamp and tested it.',
      resolutionDate: new Date('2026-01-01T00:00:00.000Z'),
      resolutionImageUrls: [],
      history: [],
    });

    expect(requestBody).not.toContain('44 Cedar Avenue');
    expect(requestBody).not.toContain('citizen@example.com');
    expect(requestBody).toContain('[contact details removed]');
    expect(requestBody).toContain('Exact location is intentionally omitted.');
  });

  it('strips metadata from legacy evidence images before sending them to Gemini', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    let requestBody = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      requestBody = String(options.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(validResult) }] } }],
      }), { status: 200 });
    }));

    const storedName = `${randomUUID()}.jpg`;
    const uploadDirectory = fileURLToPath(new URL('../../../uploads/', import.meta.url));
    const original = await sharp({
      create: { width: 8, height: 6, channels: 3, background: { r: 80, g: 100, b: 120 } },
    }).jpeg().withExif({ IFD0: { Artist: 'synthetic fixture' } }).toBuffer();

    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(path.join(uploadDirectory, storedName), original, { flag: 'wx' });
    try {
      await analyzeResolutionEvidence({
        title: 'Broken streetlight',
        category: 'ELECTRICITY',
        description: 'The streetlight has stopped working near the public walkway.',
        locationText: 'Private exact location',
        originalImageUrls: [`/api/uploads/${storedName}`],
        resolutionDescription: 'Repaired the streetlight and restored illumination.',
        workCompleted: null,
        resolutionDate: null,
        resolutionImageUrls: [],
        history: [],
      });

      const request = JSON.parse(requestBody) as { contents: Array<{ parts: Array<{ inlineData?: { data: string } }> }> };
      const imageData = request.contents[0]?.parts.find((part) => part.inlineData)?.inlineData?.data;
      expect(imageData).toBeDefined();
      const metadata = await sharp(Buffer.from(imageData!, 'base64')).metadata();
      expect(metadata.exif).toBeUndefined();
    } finally {
      await unlink(path.join(uploadDirectory, storedName));
    }
  });
});
