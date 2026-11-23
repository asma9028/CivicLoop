-- CreateEnum
CREATE TYPE "ActivityVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'OPERATIONAL_UPDATE';
ALTER TYPE "ActivityType" ADD VALUE 'INTERNAL_NOTE';
ALTER TYPE "ActivityType" ADD VALUE 'RESOLUTION_SUBMITTED';
ALTER TYPE "ActivityType" ADD VALUE 'INCIDENT_REJECTED';
ALTER TYPE "ActivityType" ADD VALUE 'INCIDENT_DUPLICATED';

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "resolutionSubmittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "IncidentActivity" ADD COLUMN     "visibility" "ActivityVisibility" NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "ResolutionEvidence" ADD COLUMN     "internalNotes" TEXT,
ADD COLUMN     "resolutionDate" TIMESTAMP(3),
ADD COLUMN     "workCompleted" TEXT;

-- CreateIndex
CREATE INDEX "Incident_departmentId_status_priorityScore_idx" ON "Incident"("departmentId", "status", "priorityScore");

-- CreateIndex
CREATE INDEX "Incident_departmentId_createdAt_idx" ON "Incident"("departmentId", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_assignedAuthorityId_status_createdAt_idx" ON "Incident"("assignedAuthorityId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_status_updatedAt_idx" ON "Incident"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "IncidentActivity_incidentId_createdAt_idx" ON "IncidentActivity"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentActivity_visibility_createdAt_idx" ON "IncidentActivity"("visibility", "createdAt");
