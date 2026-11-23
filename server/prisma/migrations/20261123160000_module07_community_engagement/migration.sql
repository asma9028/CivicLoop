-- CreateEnum
CREATE TYPE "SupportEventAction" AS ENUM ('SUPPORTED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "CivicCampaignType" AS ENUM ('AWARENESS', 'CLEANUP', 'INFRASTRUCTURE', 'SAFETY', 'CONSERVATION', 'OTHER');

-- CreateEnum
CREATE TYPE "CivicCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignAuditAction" AS ENUM ('CREATED', 'UPDATED', 'PUBLISHED', 'PAUSED', 'RESUMED', 'COMPLETED', 'CANCELLED', 'INCIDENT_LINKED', 'INCIDENT_UNLINKED');

-- CreateEnum
CREATE TYPE "CivicNotificationType" AS ENUM ('SUPPORTED_INCIDENT_UPDATE', 'FOLLOWED_AREA_ACTIVITY', 'CAMPAIGN_UPDATE', 'VERIFIED_IMPROVEMENT');

-- CreateEnum
CREATE TYPE "CampaignParticipationAction" AS ENUM ('JOINED', 'LEFT');

-- CreateTable
CREATE TABLE "IncidentSupport" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "supportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncidentSupport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentSupportEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "SupportEventAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentSupportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowedArea" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "centerLatitude" DOUBLE PRECISION NOT NULL,
    "centerLongitude" DOUBLE PRECISION NOT NULL,
    "radiusMeters" INTEGER NOT NULL DEFAULT 500,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "followedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unfollowedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowedArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CivicCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "campaignType" "CivicCampaignType" NOT NULL,
    "objective" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "targetAreaLabel" TEXT NOT NULL,
    "targetLatitude" DOUBLE PRECISION,
    "targetLongitude" DOUBLE PRECISION,
    "radiusMeters" INTEGER,
    "departmentId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "status" "CivicCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CivicCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignParticipant" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignParticipationEvent" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "action" "CampaignParticipationAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignParticipationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignIncident" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "linkedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAuditEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" "CampaignAuditAction" NOT NULL,
    "fromStatus" "CivicCampaignStatus",
    "toStatus" "CivicCampaignStatus",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CivicNotification" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "type" "CivicNotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CivicNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncidentSupport_userId_isActive_supportedAt_idx" ON "IncidentSupport"("userId", "isActive", "supportedAt");

-- CreateIndex
CREATE INDEX "IncidentSupport_incidentId_isActive_supportedAt_idx" ON "IncidentSupport"("incidentId", "isActive", "supportedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentSupport_incidentId_userId_key" ON "IncidentSupport"("incidentId", "userId");

-- CreateIndex
CREATE INDEX "IncidentSupportEvent_incidentId_action_createdAt_idx" ON "IncidentSupportEvent"("incidentId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "IncidentSupportEvent_userId_createdAt_idx" ON "IncidentSupportEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FollowedArea_userId_createdAt_idx" ON "FollowedArea"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FollowedArea_userId_name_key" ON "FollowedArea"("userId", "name");

-- CreateIndex
CREATE INDEX "CivicCampaign_status_startAt_endAt_idx" ON "CivicCampaign"("status", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "CivicCampaign_departmentId_status_startAt_idx" ON "CivicCampaign"("departmentId", "status", "startAt");

-- CreateIndex
CREATE INDEX "CivicCampaign_createdByUserId_createdAt_idx" ON "CivicCampaign"("createdByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignParticipant_userId_isActive_joinedAt_idx" ON "CampaignParticipant"("userId", "isActive", "joinedAt");

-- CreateIndex
CREATE INDEX "CampaignParticipant_campaignId_isActive_joinedAt_idx" ON "CampaignParticipant"("campaignId", "isActive", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignParticipant_campaignId_userId_key" ON "CampaignParticipant"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "CampaignParticipationEvent_participantId_createdAt_idx" ON "CampaignParticipationEvent"("participantId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignIncident_incidentId_createdAt_idx" ON "CampaignIncident"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignIncident_campaignId_createdAt_idx" ON "CampaignIncident"("campaignId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignIncident_campaignId_incidentId_key" ON "CampaignIncident"("campaignId", "incidentId");

-- CreateIndex
CREATE INDEX "CampaignAuditEvent_campaignId_createdAt_idx" ON "CampaignAuditEvent"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignAuditEvent_actorUserId_createdAt_idx" ON "CampaignAuditEvent"("actorUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CivicNotification_sourceKey_key" ON "CivicNotification"("sourceKey");

-- CreateIndex
CREATE INDEX "CivicNotification_recipientId_readAt_createdAt_idx" ON "CivicNotification"("recipientId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "CivicNotification_recipientId_createdAt_idx" ON "CivicNotification"("recipientId", "createdAt");

-- AddForeignKey
ALTER TABLE "IncidentSupport" ADD CONSTRAINT "IncidentSupport_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentSupport" ADD CONSTRAINT "IncidentSupport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentSupportEvent" ADD CONSTRAINT "IncidentSupportEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentSupportEvent" ADD CONSTRAINT "IncidentSupportEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowedArea" ADD CONSTRAINT "FollowedArea_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CivicCampaign" ADD CONSTRAINT "CivicCampaign_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CivicCampaign" ADD CONSTRAINT "CivicCampaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignParticipant" ADD CONSTRAINT "CampaignParticipant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CivicCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignParticipant" ADD CONSTRAINT "CampaignParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignParticipationEvent" ADD CONSTRAINT "CampaignParticipationEvent_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "CampaignParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignIncident" ADD CONSTRAINT "CampaignIncident_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CivicCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignIncident" ADD CONSTRAINT "CampaignIncident_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignIncident" ADD CONSTRAINT "CampaignIncident_linkedByUserId_fkey" FOREIGN KEY ("linkedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAuditEvent" ADD CONSTRAINT "CampaignAuditEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CivicCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAuditEvent" ADD CONSTRAINT "CampaignAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CivicNotification" ADD CONSTRAINT "CivicNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ProactiveRecommendation_responsibleDepartmentId_status_priority" RENAME TO "ProactiveRecommendation_responsibleDepartmentId_status_prio_idx";
