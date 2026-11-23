import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { adminRouter } from './routes/admin.js';
import { incidentsRouter } from './routes/incidents.js';
import { uploadsRouter } from './routes/uploads.js';
import { authorityRouter } from './routes/authority.js';
import { verificationRouter } from './routes/verification.js';
import { intelligenceRouter } from './routes/intelligence.js';
import { communityRouter } from './routes/community.js';
import multer from 'multer';
import { assignRequestId, createRequestLogger } from './middleware/request-logging.js';
import { logSafeError } from './utils/safe-logger.js';
import { createReadinessHandler } from './routes/health.js';
import { prisma } from './config/prisma.js';

export const app = express();

// Render's reverse proxy is one hop in front of the API. Trust only that hop
// so Express derives req.ip from the forwarded client address for rate limits.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true }));
app.use(assignRequestId);
app.use(createRequestLogger());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});
const analysisLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'CivicLoop API',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/ready', createReadinessHandler(() => prisma.$queryRaw`SELECT 1`));

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/users', usersRouter);
app.use('/api/admin', adminRouter);
app.use('/api/authority', authorityRouter);
app.use('/api/verification', verificationRouter);
app.use('/api/intelligence', intelligenceRouter);
app.use('/api/community', communityRouter);
app.use('/api/incidents/analyze', analysisLimiter);
app.use('/api/incidents/duplicates', analysisLimiter);
app.use('/api/incidents', incidentsRouter);
app.use('/api/uploads', uploadsRouter);

app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Each image must be 5 MB or smaller' : 'Invalid upload. Attach up to 5 images.' });
  }
  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  logSafeError('http.unhandled', error, res.getHeader('X-Request-Id'));
  res.status(500).json({ error: 'Internal server error' });
});
