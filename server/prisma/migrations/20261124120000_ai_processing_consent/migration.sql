CREATE TABLE "AiConsentGrant" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiConsentGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiConsentGrant_tokenId_key" ON "AiConsentGrant"("tokenId");
CREATE INDEX "AiConsentGrant_userId_purpose_expiresAt_idx" ON "AiConsentGrant"("userId", "purpose", "expiresAt");
CREATE INDEX "AiConsentGrant_expiresAt_consumedAt_idx" ON "AiConsentGrant"("expiresAt", "consumedAt");

ALTER TABLE "AiConsentGrant"
    ADD CONSTRAINT "AiConsentGrant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
