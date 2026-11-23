import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

export interface FirstAdminDatabase {
  $transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

export class FirstAdminBootstrapError extends Error {
  constructor(readonly code: 'ADMIN_EXISTS' | 'EMAIL_IN_USE' | 'INVALID_CREDENTIALS') {
    const messages = {
      ADMIN_EXISTS: 'An administrator already exists; first-admin bootstrap was refused.',
      EMAIL_IN_USE: 'The bootstrap email already belongs to an account; no account was changed.',
      INVALID_CREDENTIALS: 'Bootstrap email or password does not meet the required format.',
    };
    super(messages[code]);
    this.name = 'FirstAdminBootstrapError';
  }
}

const bootstrapInputSchema = z.object({
  email: z.string().trim().email().max(254).toLowerCase(),
  password: z.string().min(8).regex(/[a-z]/).regex(/[A-Z]/).regex(/[0-9]/),
});

export async function bootstrapFirstAdmin(
  database: FirstAdminDatabase,
  input: { email: string; password: string },
) {
  const parsed = bootstrapInputSchema.safeParse(input);
  if (!parsed.success) throw new FirstAdminBootstrapError('INVALID_CREDENTIALS');

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  return database.$transaction(async (tx) => {
    // Share the lock used by admin role/status changes so bootstrap and RBAC
    // cannot race while deciding whether an administrator already exists.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(1837468647, 1)`;

    const existingAdmin = await tx.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (existingAdmin) throw new FirstAdminBootstrapError('ADMIN_EXISTS');

    const existingEmail = await tx.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (existingEmail) throw new FirstAdminBootstrapError('EMAIL_IN_USE');

    return tx.user.create({
      data: {
        fullName: 'CivicLoop Administrator',
        email: parsed.data.email,
        passwordHash,
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
      },
    });
  });
}
