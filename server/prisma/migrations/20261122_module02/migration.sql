-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CITIZEN', 'AUTHORITY', 'ADMIN');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('REPORTED', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLUTION_SUBMITTED', 'VERIFICATION_PENDING', 'RESOLVED', 'REOPENED', 'ON_HOLD', 'REJECTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "IncidentCategory" AS ENUM ('ROAD', 'WASTE', 'WATER', 'DRAINAGE', 'ELECTRICITY', 'PUBLIC_SPACE', 'OTHER');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DepartmentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AIAnalysisStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationResult" AS ENUM ('LIKELY_RESOLVED', 'LIKELY_UNRESOLVED', 'UNCERTAIN', 'MISMATCH', 'PENDING');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('CONFIRMED_RESOLVED', 'NOT_RESOLVED', 'STILL_PRESENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('STATUS_CHANGED', 'DEPARTMENT_ASSIGNED', 'AUTHORITY_ASSIGNED', 'EVIDENCE_SUBMITTED', 'FEEDBACK_SUBMITTED', 'ADMIN_ACTION', 'OTHER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('ROLE_CHANGED', 'ACCOUNT_ACTIVATED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_INACTIVATED', 'DEPARTMENT_CREATED', 'DEPARTMENT_UPDATED', 'AUTHORITY_PROVISIONED', 'PROFILE_UPDATED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'CITIZEN',
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "status" "DepartmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "employeeIdentifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "IncidentCategory" NOT NULL,
    "subcategory" TEXT,
    "locationText" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "imageUrls" TEXT[],
    "reporterId" TEXT,
    "departmentId" TEXT,
    "assignedAuthorityId" TEXT,
    "severity" "Severity" NOT NULL DEFAULT 'MEDIUM',
    "priorityScore" INTEGER NOT NULL DEFAULT 0,
    "status" "IncidentStatus" NOT NULL DEFAULT 'REPORTED',
    "duplicateOfIncidentId" TEXT,
    "aiSummary" TEXT,
    "aiAnalysisStatus" "AIAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "resolutionDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentActivity" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "activityType" "ActivityType" NOT NULL DEFAULT 'OTHER',
    "activityDescription" TEXT NOT NULL,
    "previousStatus" "IncidentStatus",
    "newStatus" "IncidentStatus",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionEvidence" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "submittedByUserId" TEXT,
    "evidenceImageUrls" TEXT[],
    "evidenceDescription" TEXT NOT NULL,
    "verificationResult" "VerificationResult" NOT NULL DEFAULT 'PENDING',
    "verificationNotes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "ResolutionEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitizenFeedback" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "citizenId" TEXT,
    "feedbackType" "FeedbackType" NOT NULL,
    "feedbackDescription" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CitizenFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" "AuditAction" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Department_code_key" ON "Department"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityProfile_userId_key" ON "AuthorityProfile"("userId");

-- AddForeignKey
ALTER TABLE "AuthorityProfile" ADD CONSTRAINT "AuthorityProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthorityProfile" ADD CONSTRAINT "AuthorityProfile_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_assignedAuthorityId_fkey" FOREIGN KEY ("assignedAuthorityId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_duplicateOfIncidentId_fkey" FOREIGN KEY ("duplicateOfIncidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentActivity" ADD CONSTRAINT "IncidentActivity_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentActivity" ADD CONSTRAINT "IncidentActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionEvidence" ADD CONSTRAINT "ResolutionEvidence_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionEvidence" ADD CONSTRAINT "ResolutionEvidence_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitizenFeedback" ADD CONSTRAINT "CitizenFeedback_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitizenFeedback" ADD CONSTRAINT "CitizenFeedback_citizenId_fkey" FOREIGN KEY ("citizenId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

