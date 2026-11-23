import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapFirstAdmin, FirstAdminBootstrapError, type FirstAdminDatabase } from './bootstrap-first-admin.js';

function createDatabase(existingAdmin: { id: string } | null = null, existingEmail: { id: string } | null = null) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: {
      findFirst: vi.fn().mockResolvedValue(existingAdmin),
      findUnique: vi.fn().mockResolvedValue(existingEmail),
      create: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'ADMIN', accountStatus: 'ACTIVE' }),
    },
  };
  const database = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as FirstAdminDatabase;
  return { database, tx };
}

describe('first administrator bootstrap', () => {
  it('creates one active ADMIN using the existing bcrypt hash format and shared admin lock', async () => {
    const { database, tx } = createDatabase();
    const result = await bootstrapFirstAdmin(database, {
      email: '  FIRST.ADMIN@example.demo ',
      password: 'CivicLoopPass123',
    });

    expect(result).toMatchObject({ id: 'admin-1', role: 'ADMIN', accountStatus: 'ACTIVE' });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const createArgs = tx.user.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      email: 'first.admin@example.demo',
      fullName: 'CivicLoop Administrator',
      role: 'ADMIN',
      accountStatus: 'ACTIVE',
    });
    expect(await bcrypt.compare('CivicLoopPass123', createArgs.data.passwordHash)).toBe(true);
  });

  it('refuses when any administrator already exists, regardless of account status', async () => {
    const { database, tx } = createDatabase({ id: 'inactive-admin' });

    await expect(bootstrapFirstAdmin(database, {
      email: 'first.admin@example.demo',
      password: 'CivicLoopPass123',
    })).rejects.toMatchObject({ code: 'ADMIN_EXISTS' });

    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('refuses to promote an existing non-admin account', async () => {
    const { database, tx } = createDatabase(null, { id: 'citizen-1' });

    await expect(bootstrapFirstAdmin(database, {
      email: 'citizen@example.demo',
      password: 'CivicLoopPass123',
    })).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });

    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('rejects weak or malformed credentials before opening a transaction', async () => {
    const { database } = createDatabase();

    await expect(bootstrapFirstAdmin(database, {
      email: 'not-an-email',
      password: 'weak',
    })).rejects.toBeInstanceOf(FirstAdminBootstrapError);
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});
