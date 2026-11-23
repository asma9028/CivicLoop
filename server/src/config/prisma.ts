import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { civicLoopPrisma?: PrismaClient };

export const prisma = globalForPrisma.civicLoopPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.civicLoopPrisma = prisma;
