CREATE TYPE "RecommendationPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE "RecommendationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DISMISSED', 'IN_PROGRESS', 'COMPLETED');

CREATE TABLE "ProactiveRecommendation" (
    "id" TEXT NOT NULL,
    "recommendationKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "areaLabel" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "category" "IncidentCategory",
    "riskScore" INTEGER NOT NULL,
    "priority" "RecommendationPriority" NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PENDING',
    "supportingMetrics" JSONB NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "responsibleDepartmentId" TEXT,
    "dismissalReason" TEXT,
    "actionSummary" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProactiveRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationHistory" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "previousStatus" "RecommendationStatus",
    "newStatus" "RecommendationStatus",
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProactiveRecommendation_recommendationKey_key" ON "ProactiveRecommendation"("recommendationKey");
CREATE INDEX "ProactiveRecommendation_responsibleDepartmentId_status_priority_idx" ON "ProactiveRecommendation"("responsibleDepartmentId", "status", "priority");
CREATE INDEX "ProactiveRecommendation_status_priority_generatedAt_idx" ON "ProactiveRecommendation"("status", "priority", "generatedAt");
CREATE INDEX "ProactiveRecommendation_category_generatedAt_idx" ON "ProactiveRecommendation"("category", "generatedAt");
CREATE INDEX "RecommendationHistory_recommendationId_createdAt_idx" ON "RecommendationHistory"("recommendationId", "createdAt");
CREATE INDEX "RecommendationHistory_actorUserId_createdAt_idx" ON "RecommendationHistory"("actorUserId", "createdAt");

ALTER TABLE "ProactiveRecommendation" ADD CONSTRAINT "ProactiveRecommendation_responsibleDepartmentId_fkey"
    FOREIGN KEY ("responsibleDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecommendationHistory" ADD CONSTRAINT "RecommendationHistory_recommendationId_fkey"
    FOREIGN KEY ("recommendationId") REFERENCES "ProactiveRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationHistory" ADD CONSTRAINT "RecommendationHistory_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
