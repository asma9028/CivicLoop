import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  changeAdminUserRole,
  changeAdminUserStatus,
  type AdminUserMutationDatabase,
} from './user-mutations.js';

type TestUser = { id: string; role: 'CITIZEN' | 'AUTHORITY' | 'ADMIN'; accountStatus: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' };

function fakeDatabase(initialUsers: TestUser[]) {
  const users = new Map(initialUsers.map((user) => [user.id, { ...user }]));
  const audits: Array<{ targetId: string; action: string }> = [];
  let lockTail = Promise.resolve();

  const database = {
    $transaction: async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) => {
      let releaseLock: (() => void) | undefined;
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
          if (!strings.join('').includes('pg_advisory_xact_lock')) throw new Error('Expected the administrator mutation lock');
          const previous = lockTail;
          lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
          await previous;
          return [];
        },
        user: {
          findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
          count: async () => [...users.values()].filter((user) => user.role === 'ADMIN' && user.accountStatus === 'ACTIVE').length,
          update: async ({ where, data }: { where: { id: string }; data: Partial<TestUser> }) => {
            const user = users.get(where.id);
            if (!user) throw new Error('User disappeared');
            Object.assign(user, data);
            return { ...user };
          },
        },
        authorityProfile: { findUnique: async () => null },
        auditLog: {
          create: async ({ data }: { data: { targetId: string; action: string } }) => {
            audits.push({ targetId: data.targetId, action: data.action });
            return {};
          },
        },
      } as unknown as Prisma.TransactionClient;
      try {
        return await callback(tx);
      } finally {
        releaseLock?.();
      }
    },
  } satisfies AdminUserMutationDatabase;

  return { database, users, audits };
}

describe('administrator account mutations', () => {
  it('allows suspension when another active administrator remains and records the audit atomically', async () => {
    const { database, users, audits } = fakeDatabase([
      { id: 'admin-1', role: 'ADMIN', accountStatus: 'ACTIVE' },
      { id: 'admin-2', role: 'ADMIN', accountStatus: 'ACTIVE' },
    ]);

    await changeAdminUserStatus(database, 'actor', 'admin-1', 'SUSPENDED');

    expect(users.get('admin-1')?.accountStatus).toBe('SUSPENDED');
    expect(audits).toEqual([{ targetId: 'admin-1', action: 'ACCOUNT_SUSPENDED' }]);
  });

  it('prevents suspending or demoting the last active administrator', async () => {
    const { database, users, audits } = fakeDatabase([
      { id: 'admin-1', role: 'ADMIN', accountStatus: 'ACTIVE' },
    ]);

    await expect(changeAdminUserStatus(database, 'actor', 'admin-1', 'INACTIVE'))
      .rejects.toMatchObject({ code: 'LAST_ACTIVE_ADMIN' });
    await expect(changeAdminUserRole(database, 'actor', 'admin-1', 'CITIZEN'))
      .rejects.toMatchObject({ code: 'LAST_ACTIVE_ADMIN' });
    expect(users.get('admin-1')).toEqual({ id: 'admin-1', role: 'ADMIN', accountStatus: 'ACTIVE' });
    expect(audits).toHaveLength(0);
  });

  it('serializes concurrent admin suspensions so only one can remove an active administrator', async () => {
    const { database, users, audits } = fakeDatabase([
      { id: 'admin-1', role: 'ADMIN', accountStatus: 'ACTIVE' },
      { id: 'admin-2', role: 'ADMIN', accountStatus: 'ACTIVE' },
    ]);

    const outcomes = await Promise.allSettled([
      changeAdminUserStatus(database, 'actor', 'admin-1', 'SUSPENDED'),
      changeAdminUserStatus(database, 'actor', 'admin-2', 'SUSPENDED'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect([...users.values()].filter((user) => user.role === 'ADMIN' && user.accountStatus === 'ACTIVE')).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});
