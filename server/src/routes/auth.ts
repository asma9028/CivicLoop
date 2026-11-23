import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authCookieName, issueSession, requireAuth } from '../middleware/auth.js';
import { safeUser } from '../utils/serialize.js';
import { logSafeError } from '../utils/safe-logger.js';

export const authRouter = Router();

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').regex(/[a-z]/, 'Password must include a lowercase letter').regex(/[A-Z]/, 'Password must include an uppercase letter').regex(/[0-9]/, 'Password must include a number');

authRouter.post('/register', async (req, res) => {
  const parsed = z.object({
    fullName: z.string().trim().min(2).max(100),
    email: z.string().trim().email().toLowerCase(),
    password: passwordSchema,
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please check your registration details', fields: parsed.error.flatten().fieldErrors });

  try {
    const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await prisma.user.create({
      data: { fullName: parsed.data.fullName, email: parsed.data.email, passwordHash, role: 'CITIZEN', accountStatus: 'ACTIVE' },
    });
    issueSession(res, { id: user.id, role: user.role, fullName: user.fullName, email: user.email });
    res.status(201).json({ user: safeUser(user) });
  } catch (error) {
    logSafeError('auth.register', error, res.getHeader('X-Request-Id'));
    res.status(503).json({ error: 'Database unavailable. Configure PostgreSQL and run migrations.' });
  }
});

authRouter.post('/login', async (req, res) => {
  const parsed = z.object({ email: z.string().trim().email().toLowerCase(), password: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid email or password' });
  try {
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.accountStatus !== 'ACTIVE') return res.status(403).json({ error: 'This account is not active' });
    issueSession(res, { id: user.id, role: user.role, fullName: user.fullName, email: user.email });
    res.json({ user: safeUser(user) });
  } catch (error) {
    logSafeError('auth.login', error, res.getHeader('X-Request-Id'));
    res.status(503).json({ error: 'Database unavailable. Configure PostgreSQL and run migrations.' });
  }
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(authCookieName(), { httpOnly: true, sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ success: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(user) });
});
