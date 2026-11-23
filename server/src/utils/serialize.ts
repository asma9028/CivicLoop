export function safeUser(user: { id: string; fullName: string; email: string; phoneNumber?: string | null; role: string; accountStatus: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phoneNumber: user.phoneNumber ?? null,
    role: user.role,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
