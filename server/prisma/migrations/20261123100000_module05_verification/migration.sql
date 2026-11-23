CREATE TYPE "VerificationCaseStatus" AS ENUM ('PENDING', 'DISPUTED', 'REVIEW_REQUIRED', 'VERIFIED', 'REOPENED');
CREATE TYPE "VerificationDecision" AS ENUM ('CONFIRM', 'ISSUE_REMAINS', 'INCOMPLETE', 'EVIDENCE_MISMATCH', 'REQUEST_FURTHER_ACTION');
CREATE TYPE "VerificationActionType" AS ENUM ('CITIZEN_CONFIRMED', 'CITIZEN_DISPUTED', 'CITIZEN_EVIDENCE_SUBMITTED', 'REVIEW_ASSIGNED', 'REVIEW_CONFIRMED', 'REVIEW_REOPENED', 'REVIEW_REQUESTED_EVIDENCE', 'DEADLINE_ESCALATED', 'AI_ANALYZED');

ALTER TYPE "ActivityType" ADD VALUE 'VERIFICATION_REQUESTED';
ALTER TYPE "ActivityType" ADD VALUE 'VERIFICATION_CONFIRMED';
ALTER TYPE "ActivityType" ADD VALUE 'VERIFICATION_DISPUTED';
ALTER TYPE "ActivityType" ADD VALUE 'VERIFICATION_REVIEWED';

ALTER TABLE "IncidentUpload" ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "VerificationCase" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "resolutionEvidenceId" TEXT NOT NULL,
    "reporterId" TEXT,
    "assignedReviewerId" TEXT,
    "status" "VerificationCaseStatus" NOT NULL DEFAULT 'PENDING',
    "citizenDecision" "VerificationDecision",
    "citizenRespondedAt" TIMESTAMP(3),
    "responseDeadline" TIMESTAMP(3) NOT NULL,
    "escalationAt" TIMESTAMP(3),
    "reviewDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VerificationCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VerificationAction" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actionType" "VerificationActionType" NOT NULL,
    "reason" TEXT,
    "evidenceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VerificationAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VerificationAnalysis" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "result" "VerificationResult" NOT NULL,
    "confidence" INTEGER NOT NULL,
    "evidenceRelevance" INTEGER NOT NULL,
    "apparentImprovement" TEXT NOT NULL,
    "evidenceQuality" TEXT NOT NULL,
    "potentialInconsistencies" TEXT[] NOT NULL,
    "explanation" TEXT NOT NULL,
    "recommendedNextAction" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "contextHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VerificationAnalysis_pkey" PRIMARY KEY ("id")
);

INSERT INTO "VerificationCase" (
    "id",
    "incidentId",
    "resolutionEvidenceId",
    "reporterId",
    "responseDeadline",
    "createdAt",
    "updatedAt"
)
SELECT
    'verify_' || gen_random_uuid()::text,
    incident."id",
    evidence."id",
    incident."reporterId",
    evidence."submittedAt" + INTERVAL '72 hours',
    evidence."submittedAt",
    evidence."submittedAt"
FROM (
    SELECT DISTINCT ON ("incidentId") *
    FROM "ResolutionEvidence"
    ORDER BY "incidentId", "submittedAt" DESC
) AS evidence
JOIN "Incident" AS incident ON incident."id" = evidence."incidentId"
WHERE incident."status" = 'VERIFICATION_PENDING';

CREATE UNIQUE INDEX "VerificationCase_resolutionEvidenceId_key" ON "VerificationCase"("resolutionEvidenceId");
CREATE INDEX "VerificationCase_status_responseDeadline_idx" ON "VerificationCase"("status", "responseDeadline");
CREATE INDEX "VerificationCase_status_reviewDueAt_idx" ON "VerificationCase"("status", "reviewDueAt");
CREATE INDEX "VerificationCase_incidentId_createdAt_idx" ON "VerificationCase"("incidentId", "createdAt");
CREATE INDEX "VerificationCase_reporterId_status_responseDeadline_idx" ON "VerificationCase"("reporterId", "status", "responseDeadline");
CREATE INDEX "VerificationCase_assignedReviewerId_status_reviewDueAt_idx" ON "VerificationCase"("assignedReviewerId", "status", "reviewDueAt");
CREATE INDEX "VerificationAction_caseId_createdAt_idx" ON "VerificationAction"("caseId", "createdAt");
CREATE INDEX "VerificationAction_actorUserId_createdAt_idx" ON "VerificationAction"("actorUserId", "createdAt");
CREATE INDEX "VerificationAnalysis_caseId_createdAt_idx" ON "VerificationAnalysis"("caseId", "createdAt");

ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_incidentId_fkey"
    FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_resolutionEvidenceId_fkey"
    FOREIGN KEY ("resolutionEvidenceId") REFERENCES "ResolutionEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_reporterId_fkey"
    FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VerificationCase" ADD CONSTRAINT "VerificationCase_assignedReviewerId_fkey"
    FOREIGN KEY ("assignedReviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VerificationAction" ADD CONSTRAINT "VerificationAction_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "VerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationAction" ADD CONSTRAINT "VerificationAction_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VerificationAnalysis" ADD CONSTRAINT "VerificationAnalysis_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "VerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
