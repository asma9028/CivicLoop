import { Prisma, type AccountStatus, type UserRole } from '@prisma/client';

export interface AdminUserMutationDatabase {
  $transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

export class AdminUserMutationError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'AUTHORITY_PROFILE_REQUIRED' | 'LAST_ACTIVE_ADMIN',
  ) {
    super(message);
    this.name = 'AdminUserMutationError';
  }
}

async function lockAdministratorSet(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(1837468647, 1)`;
}

export async function changeAdminUserRole(
  database: AdminUserMutationDatabase,
  actorId: string,
  targetId: string,
  nextRole: UserRole,
) {
  return database.$transaction(async (tx) => {
    await lockAdministratorSet(tx);
    const target = await tx.user.findUnique({ where: { id: targetId } });
    if (!target) throw new AdminUserMutationError('User not found', 'NOT_FOUND');
    if (nextRole === 'AUTHORITY' && target.role !== 'AUTHORITY') {
      const profile = await tx.authorityProfile.findUnique({ where: { userId: target.id } });
      if (!profile) {
        throw new AdminUserMutationError(
          'Provision an authority profile before assigning the authority role',
          'AUTHORITY_PROFILE_REQUIRED',
        );
      }
    }
    if (target.role === 'ADMIN' && target.accountStatus === 'ACTIVE' && nextRole !== 'ADMIN') {
      const activeAdmins = await tx.user.count({ where: { role: 'ADMIN', accountStatus: 'ACTIVE' } });
      if (activeAdmins <= 1) {
        throw new AdminUserMutationError('Cannot remove the last active administrator', 'LAST_ACTIVE_ADMIN');
      }
    }
    const user = await tx.user.update({ where: { id: target.id }, data: { role: nextRole } });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'ROLE_CHANGED',
        targetType: 'USER',
        targetId: user.id,
        metadata: { previousRole: target.role, newRole: user.role },
      },
    });
    return user;
  });
}

export async function changeAdminUserStatus(
  database: AdminUserMutationDatabase,
  actorId: string,
  targetId: string,
  nextStatus: AccountStatus,
) {
  return database.$transaction(async (tx) => {
    await lockAdministratorSet(tx);
    const target = await tx.user.findUnique({ where: { id: targetId } });
    if (!target) throw new AdminUserMutationError('User not found', 'NOT_FOUND');
    if (target.role === 'ADMIN' && target.accountStatus === 'ACTIVE' && nextStatus !== 'ACTIVE') {
      const activeAdmins = await tx.user.count({ where: { role: 'ADMIN', accountStatus: 'ACTIVE' } });
      if (activeAdmins <= 1) {
        throw new AdminUserMutationError('Cannot deactivate the last active administrator', 'LAST_ACTIVE_ADMIN');
      }
    }
    const user = await tx.user.update({ where: { id: target.id }, data: { accountStatus: nextStatus } });
    const action = nextStatus === 'ACTIVE'
      ? 'ACCOUNT_ACTIVATED'
      : nextStatus === 'SUSPENDED'
        ? 'ACCOUNT_SUSPENDED'
        : 'ACCOUNT_INACTIVATED';
    await tx.auditLog.create({
      data: {
        actorId,
        action,
        targetType: 'USER',
        targetId: user.id,
        metadata: { previousStatus: target.accountStatus, newStatus: user.accountStatus },
      },
    });
    return user;
  });
}
