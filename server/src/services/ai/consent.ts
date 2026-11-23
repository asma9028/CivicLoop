import { createHmac, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/prisma.js';

export type AiConsentPurpose = 'INCIDENT_CLASSIFICATION' | 'VERIFICATION_ANALYSIS';
export type AiConsentOperation = 'INCIDENT_PREVIEW' | 'INCIDENT_SUBMISSION' | 'VERIFICATION_ANALYSIS';

export interface AiConsentContext {
  userId: string;
  purpose: AiConsentPurpose;
  operation: AiConsentOperation;
  subject: unknown;
}

const grantLifetimeMs = 5 * 60 * 1000;

function keyFor(purpose: string) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return createHmac('sha256', secret).update(`civicloop-ai-consent:${purpose}:v1`).digest();
}

function subjectHash(context: AiConsentContext) {
  return createHmac('sha256', keyFor('subject'))
    .update(JSON.stringify([context.userId, context.purpose, context.operation, context.subject]))
    .digest('hex');
}

export async function issueAiConsent(context: AiConsentContext) {
  const tokenId = randomUUID();
  const expiresAt = new Date(Date.now() + grantLifetimeMs);
  const token = jwt.sign(
    { purpose: context.purpose, operation: context.operation },
    keyFor('token'),
    {
      algorithm: 'HS256',
      subject: context.userId,
      jwtid: tokenId,
      issuer: 'civicloop',
      audience: 'civicloop-ai-consent',
      expiresIn: Math.floor(grantLifetimeMs / 1000),
    },
  );

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "AiConsentGrant"
      ("id", "tokenId", "userId", "purpose", "operation", "subjectHash", "expiresAt")
    VALUES
      (${randomUUID()}, ${tokenId}, ${context.userId}, ${context.purpose}, ${context.operation}, ${subjectHash(context)}, ${expiresAt})
  `);

  return token;
}

export async function consumeAiConsent(token: string | undefined, context: AiConsentContext) {
  if (!token) return false;

  let claims: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, keyFor('token'), {
      algorithms: ['HS256'],
      issuer: 'civicloop',
      audience: 'civicloop-ai-consent',
    });
    if (typeof verified === 'string') return false;
    claims = verified;
  } catch {
    return false;
  }

  if (
    claims.sub !== context.userId
    || claims.purpose !== context.purpose
    || claims.operation !== context.operation
    || typeof claims.jti !== 'string'
  ) return false;

  const consumed = await prisma.$queryRaw<Array<{ tokenId: string }>>(Prisma.sql`
    UPDATE "AiConsentGrant"
    SET "consumedAt" = ${new Date()}
    WHERE "tokenId" = ${claims.jti}
      AND "userId" = ${context.userId}
      AND "purpose" = ${context.purpose}
      AND "operation" = ${context.operation}
      AND "subjectHash" = ${subjectHash(context)}
      AND "expiresAt" > ${new Date()}
      AND "consumedAt" IS NULL
    RETURNING "tokenId"
  `);

  return consumed.length === 1;
}
