import { prisma } from '../config/prisma.js';
import { cleanupOrphanedUploads } from '../services/uploads/orphan-cleanup.js';
import { logSafeError } from '../utils/safe-logger.js';

const apply = process.argv.includes('--apply');

try {
  let examined = 0;
  let eligible = 0;
  let deleted = 0;
  let hasMore = false;
  do {
    const result = await cleanupOrphanedUploads({ apply });
    examined += result.examined;
    eligible += result.eligible;
    deleted += result.deleted;
    hasMore = result.hasMore;
    if (!apply) break;
  } while (hasMore);
  console.info(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', examined, eligible, deleted }));
} catch (error) {
  logSafeError('uploads.orphan-cleanup', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
