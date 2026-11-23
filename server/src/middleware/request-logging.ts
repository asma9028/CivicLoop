import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import morgan from 'morgan';

export function assignRequestId(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Request-Id', randomUUID());
  next();
}

export function createRequestLogger(stream?: NodeJS.WritableStream) {
  const format: morgan.FormatFn = (tokens, req, res) => {
    const routePath = (req as Request).route?.path;
    return JSON.stringify({
      requestId: res.getHeader('X-Request-Id'),
      method: tokens.method(req, res),
      route: typeof routePath === 'string' ? routePath : 'unmatched',
      status: Number(tokens.status(req, res)),
      durationMs: Number(tokens['response-time'](req, res)),
    });
  };
  return stream ? morgan(format, { stream }) : morgan(format);
}
