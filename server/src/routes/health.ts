import type { Request, Response } from 'express';

export function createReadinessHandler(checkDatabase: () => Promise<unknown>) {
  return async (_req: Request, res: Response) => {
    try {
      await checkDatabase();
      return res.status(200).json({ status: 'ready' });
    } catch {
      return res.status(503).json({ status: 'not_ready' });
    }
  };
}
