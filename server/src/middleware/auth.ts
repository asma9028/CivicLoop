import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { prisma } from '../config/prisma.js';

const cookieName = 'civicloop_session';

export function authCookieName() {
  return cookieName;
}

export function issueSession(res: Response, user: { id: string; role: UserRole; fullName: string; email: string }) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  const token = jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: '30m', issuer: 'civicloop', audience: 'civicloop-web' });
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    maxAge: 30 * 60 * 1000,
    path: '/',
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.JWT_SECRET;
  const token = req.cookies?.[cookieName];
  if (!secret) return next(new Error('JWT_SECRET is not configured'));
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret, { issuer: 'civicloop', audience: 'civicloop-web' }) as jwt.JwtPayload;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: String(payload.sub) },
      select: { id: true, fullName: true, email: true, role: true, accountStatus: true },
    });
    if (!user || user.accountStatus !== 'ACTIVE') return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: user.id, role: user.role, fullName: user.fullName, email: user.email };
  } catch {
    return next(new Error('Unable to verify authenticated user'));
  }
  next();
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[cookieName];
  if (!token || !process.env.JWT_SECRET) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'civicloop', audience: 'civicloop-web' }) as jwt.JwtPayload;
    const user = await prisma.user.findUnique({
      where: { id: String(payload.sub) },
      select: { id: true, fullName: true, email: true, role: true, accountStatus: true },
    });
    if (user?.accountStatus === 'ACTIVE') req.user = { id: user.id, role: user.role, fullName: user.fullName, email: user.email };
  } catch {
    return next();
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}
