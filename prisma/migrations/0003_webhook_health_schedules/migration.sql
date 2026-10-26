-- CreateEnum
CREATE TYPE "WebhookRunSource" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "WebhookRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "WebhookCheckStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "Client"
    ADD COLUMN "webhookScheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "webhookScheduleIntervalDays" INTEGER,
    ADD COLUMN "webhookScheduleNextRunAt" TIMESTAMP(3),
    ADD COLUMN "webhookScheduleLastRunAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Client_webhookScheduleEnabled_webhookScheduleNextRunAt_idx" ON "Client"("webhookScheduleEnabled", "webhookScheduleNextRunAt");

-- CreateTable
CREATE TABLE "WebhookHealthRun" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "source" "WebhookRunSource" NOT NULL,
    "status" "WebhookRunStatus" NOT NULL DEFAULT 'RUNNING',
    "requestedBy" TEXT,
    "totalServices" INTEGER NOT NULL DEFAULT 0,
    "successfulServices" INTEGER NOT NULL DEFAULT 0,
    "failedServices" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookHealthRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookHealthCheck" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "deploymentRunId" TEXT,
    "status" "WebhookCheckStatus" NOT NULL DEFAULT 'QUEUED',
    "httpStatus" INTEGER,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "WebhookHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookHealthRun_clientId_startedAt_idx" ON "WebhookHealthRun"("clientId", "startedAt");

-- CreateIndex
CREATE INDEX "WebhookHealthRun_status_idx" ON "WebhookHealthRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookHealthCheck_deploymentRunId_key" ON "WebhookHealthCheck"("deploymentRunId");

-- CreateIndex
CREATE INDEX "WebhookHealthCheck_runId_createdAt_idx" ON "WebhookHealthCheck"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookHealthCheck_serviceId_createdAt_idx" ON "WebhookHealthCheck"("serviceId", "createdAt");

-- AddForeignKey
ALTER TABLE "WebhookHealthRun" ADD CONSTRAINT "WebhookHealthRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookHealthCheck" ADD CONSTRAINT "WebhookHealthCheck_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WebhookHealthRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookHealthCheck" ADD CONSTRAINT "WebhookHealthCheck_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
