import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

export const orphanUploadRetentionDays = 30;
const cleanupBatchSize = 100;
const storageDirectory = fileURLToPath(new URL('../../../uploads/', import.meta.url));

type UploadCandidate = { id: string; storedName: string; createdAt: Date; incidentId: string | null };

export function selectExpiredOrphanUploads(
  candidates: UploadCandidate[],
  referencedNames: Set<string>,
  cutoff: Date,
) {
  return candidates.filter((candidate) =>
    candidate.incidentId === null
    && candidate.createdAt < cutoff
    && !referencedNames.has(candidate.storedName)
    && /^[a-f0-9-]+\.(jpg|png|webp)$/i.test(candidate.storedName),
  );
}

async function findReferencedNames(tx: Prisma.TransactionClient, storedNames: string[]) {
  if (!storedNames.length) return new Set<string>();
  const urls = storedNames.map((name) => `/api/uploads/${name}`);
  const [incidents, evidence, actions] = await Promise.all([
    tx.incident.findMany({ where: { imageUrls: { hasSome: urls } }, select: { imageUrls: true } }),
    tx.resolutionEvidence.findMany({ where: { evidenceImageUrls: { hasSome: urls } }, select: { evidenceImageUrls: true } }),
    tx.verificationAction.findMany({ where: { evidenceUrls: { hasSome: urls } }, select: { evidenceUrls: true } }),
  ]);
  const references = new Set<string>();
  for (const url of [
    ...incidents.flatMap((incident) => incident.imageUrls),
    ...evidence.flatMap((record) => record.evidenceImageUrls),
    ...actions.flatMap((action) => action.evidenceUrls),
  ]) {
    if (url.startsWith('/api/uploads/')) references.add(url.slice('/api/uploads/'.length));
  }
  return references;
}

export async function cleanupOrphanedUploads(options: { apply: boolean; now?: Date }) {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - orphanUploadRetentionDays * 86_400_000);
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<UploadCandidate[]>`
      SELECT id, "storedName", "createdAt", "incidentId"
      FROM "IncidentUpload"
      WHERE "incidentId" IS NULL
        AND "createdAt" < ${cutoff}
        AND "storedName" ~ '^[a-f0-9-]+[.](jpg|png|webp)$'
        AND NOT EXISTS (
          SELECT 1 FROM "Incident" i
          WHERE i."imageUrls" @> ARRAY['/api/uploads/' || "IncidentUpload"."storedName"]::text[]
        )
        AND NOT EXISTS (
          SELECT 1 FROM "ResolutionEvidence" e
          WHERE e."evidenceImageUrls" @> ARRAY['/api/uploads/' || "IncidentUpload"."storedName"]::text[]
        )
        AND NOT EXISTS (
          SELECT 1 FROM "VerificationAction" a
          WHERE a."evidenceUrls" @> ARRAY['/api/uploads/' || "IncidentUpload"."storedName"]::text[]
        )
      ORDER BY "createdAt" ASC
      LIMIT ${cleanupBatchSize}
      FOR UPDATE OF "IncidentUpload" SKIP LOCKED
    `;
    const references = await findReferencedNames(tx, candidates.map((candidate) => candidate.storedName));
    const expired = selectExpiredOrphanUploads(candidates, references, cutoff);
    if (!options.apply) {
      return { examined: candidates.length, eligible: expired.length, deleted: 0, hasMore: candidates.length === cleanupBatchSize };
    }

    for (const upload of expired) {
      const filePath = path.join(storageDirectory, upload.storedName);
      try {
        await unlink(filePath);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await tx.auditLog.create({
        data: {
          action: 'UPLOAD_CLEANUP',
          targetType: 'INCIDENT_UPLOAD',
          targetId: upload.id,
          metadata: { storedName: upload.storedName, uploadedAt: upload.createdAt.toISOString() },
        },
      });
      await tx.incidentUpload.delete({ where: { id: upload.id, incidentId: null } });
    }
    return { examined: candidates.length, eligible: expired.length, deleted: expired.length, hasMore: candidates.length === cleanupBatchSize };
  });
}
