import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { safeUser } from '../utils/serialize.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.get('/me', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(user) });
});

usersRouter.patch('/me', async (req, res) => {
  const parsed = z.object({
    fullName: z.string().trim().min(2).max(100).optional(),
    phoneNumber: z.string().trim().max(30).nullable().optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid profile details', fields: parsed.error.flatten().fieldErrors });
  const user = await prisma.user.update({ where: { id: req.user!.id }, data: parsed.data });
  res.json({ user: safeUser(user) });
});
