import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AdminUserMutationError, changeAdminUserRole, changeAdminUserStatus } from '../services/admin/user-mutations.js';
import { safeUser } from '../utils/serialize.js';
import { logSafeError } from '../utils/safe-logger.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('ADMIN'));

async function audit(actorId: string | undefined, action: 'ROLE_CHANGED'|'ACCOUNT_ACTIVATED'|'ACCOUNT_SUSPENDED'|'ACCOUNT_INACTIVATED'|'DEPARTMENT_CREATED'|'DEPARTMENT_UPDATED'|'AUTHORITY_PROVISIONED'|'PROFILE_UPDATED', targetType: string, targetId: string, metadata?: object) {
  await prisma.auditLog.create({ data: { actorId, action, targetType, targetId, metadata: metadata as object } });
}

adminRouter.get('/users', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const role = typeof req.query.role === 'string' && ['CITIZEN','AUTHORITY','ADMIN'].includes(req.query.role) ? req.query.role as 'CITIZEN'|'AUTHORITY'|'ADMIN' : undefined;
  const accountStatus = typeof req.query.status === 'string' && ['ACTIVE','INACTIVE','SUSPENDED'].includes(req.query.status) ? req.query.status as 'ACTIVE'|'INACTIVE'|'SUSPENDED' : undefined;
  const where = {
    ...(role ? { role } : {}),
    ...(accountStatus ? { accountStatus } : {}),
    ...(search ? { OR: [{ fullName: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] } : {}),
  };
  const [users,total] = await prisma.$transaction([
    prisma.user.findMany({ where, skip: (page-1)*limit, take: limit, orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where }),
  ]);
  res.json({ users: users.map(safeUser), pagination: { page, limit, total, pages: Math.ceil(total/limit) } });
});

adminRouter.get('/users/:id', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, include: { authority: { include: { department: true } } } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(user), authorityProfile: user.authority });
});

adminRouter.patch('/users/:id/role', async (req, res) => {
  const parsed = z.object({ role: z.enum(['CITIZEN','AUTHORITY','ADMIN']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid role' });
  try {
    const user = await changeAdminUserRole(prisma, req.user!.id, req.params.id, parsed.data.role);
    return res.json({ user: safeUser(user) });
  } catch (error) {
    if (error instanceof AdminUserMutationError) {
      return res.status(error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.message });
    }
    logSafeError('admin.user-role', error, res.getHeader('X-Request-Id'));
    return res.status(503).json({ error: 'Unable to update the user role' });
  }
});

adminRouter.patch('/users/:id/status', async (req, res) => {
  const parsed = z.object({ accountStatus: z.enum(['ACTIVE','INACTIVE','SUSPENDED']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid account status' });
  try {
    const user = await changeAdminUserStatus(prisma, req.user!.id, req.params.id, parsed.data.accountStatus);
    return res.json({ user: safeUser(user) });
  } catch (error) {
    if (error instanceof AdminUserMutationError) {
      return res.status(error.code === 'NOT_FOUND' ? 404 : 409).json({ error: error.message });
    }
    logSafeError('admin.user-status', error, res.getHeader('X-Request-Id'));
    return res.status(503).json({ error: 'Unable to update the user status' });
  }
});

adminRouter.get('/departments', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const departments = await prisma.department.findMany({
    where: search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }] } : undefined,
    include: { _count: { select: { authorities: true, incidents: true } } },
    orderBy: { name: 'asc' },
  });
  res.json({ departments });
});

adminRouter.post('/departments', async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(100),
    code: z.string().trim().min(2).max(30).regex(/^[A-Z0-9_-]+$/),
    description: z.string().trim().max(500).optional().default(''),
    contactEmail: z.string().email().nullable().optional(),
    contactPhone: z.string().trim().max(30).nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid department details', fields: parsed.error.flatten().fieldErrors });
  try {
    const department = await prisma.department.create({ data: parsed.data });
    await audit(req.user!.id, 'DEPARTMENT_CREATED', 'DEPARTMENT', department.id, { code: department.code });
    res.status(201).json({ department });
  } catch {
    res.status(409).json({ error: 'A department with this name or code already exists' });
  }
});

adminRouter.patch('/departments/:id', async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(100).optional(),
    code: z.string().trim().min(2).max(30).regex(/^[A-Z0-9_-]+$/).optional(),
    description: z.string().trim().max(500).optional(),
    contactEmail: z.string().email().nullable().optional(),
    contactPhone: z.string().trim().max(30).nullable().optional(),
    status: z.enum(['ACTIVE','INACTIVE']).optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid department details' });
  try {
    const department = await prisma.department.update({ where: { id: req.params.id }, data: parsed.data });
    await audit(req.user!.id, 'DEPARTMENT_UPDATED', 'DEPARTMENT', department.id, parsed.data as object);
    res.json({ department });
  } catch {
    res.status(404).json({ error: 'Department not found or code already in use' });
  }
});

adminRouter.post('/authorities', async (req, res) => {
  const parsed = z.object({
    fullName: z.string().trim().min(2).max(100),
    email: z.string().trim().email().toLowerCase(),
    temporaryPassword: z.string().min(8).max(128),
    departmentId: z.string().min(1),
    designation: z.string().trim().min(2).max(100),
    employeeIdentifier: z.string().trim().min(2).max(100),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid authority details', fields: parsed.error.flatten().fieldErrors });
  try {
    const department = await prisma.department.findUnique({ where: { id: parsed.data.departmentId } });
    if (!department || department.status !== 'ACTIVE') return res.status(400).json({ error: 'A valid active department is required' });
    const passwordHash = await bcrypt.hash(parsed.data.temporaryPassword, 12);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { fullName: parsed.data.fullName, email: parsed.data.email, passwordHash, role: 'AUTHORITY', accountStatus: 'ACTIVE' } });
      await tx.authorityProfile.create({ data: { userId: created.id, departmentId: department.id, designation: parsed.data.designation, employeeIdentifier: parsed.data.employeeIdentifier } });
      return created;
    });
    await audit(req.user!.id, 'AUTHORITY_PROVISIONED', 'USER', user.id, { departmentId: department.id, designation: parsed.data.designation });
    res.status(201).json({ user: safeUser(user), temporaryPasswordIssued: true });
  } catch {
    res.status(409).json({ error: 'An account with this email already exists or the authority could not be provisioned' });
  }
});
