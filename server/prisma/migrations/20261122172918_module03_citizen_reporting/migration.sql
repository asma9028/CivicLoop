-- CreateEnum
CREATE TYPE "PriorityBand" AS ENUM ('P1', 'P2', 'P3', 'P4');

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "aiCategory" "IncidentCategory",
ADD COLUMN     "aiConfidence" DOUBLE PRECISION,
ADD COLUMN     "aiProvider" TEXT,
ADD COLUMN     "aiReasoning" TEXT,
ADD COLUMN     "aiSubcategory" TEXT,
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priorityBand" "PriorityBand" NOT NULL DEFAULT 'P3',
ADD COLUMN     "priorityBreakdown" JSONB;

-- CreateTable
CREATE TABLE "IncidentUpload" (
    "id" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "incidentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncidentUpload_storedName_key" ON "IncidentUpload"("storedName");

-- CreateIndex
CREATE INDEX "IncidentUpload_uploadedByUserId_incidentId_idx" ON "IncidentUpload"("uploadedByUserId", "incidentId");

-- CreateIndex
CREATE INDEX "Incident_reporterId_createdAt_idx" ON "Incident"("reporterId", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_isPublic_status_createdAt_idx" ON "Incident"("isPublic", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_category_createdAt_idx" ON "Incident"("category", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_latitude_longitude_createdAt_idx" ON "Incident"("latitude", "longitude", "createdAt");

-- AddForeignKey
ALTER TABLE "IncidentUpload" ADD CONSTRAINT "IncidentUpload_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentUpload" ADD CONSTRAINT "IncidentUpload_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;
