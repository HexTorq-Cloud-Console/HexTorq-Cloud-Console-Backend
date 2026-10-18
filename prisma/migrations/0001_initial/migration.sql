-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('PM2', 'STATIC_FRONTEND');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('DEPLOYING', 'SUCCESS', 'FAILED', 'ERROR');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "googleSubject" TEXT,
    "passwordHash" TEXT NOT NULL,
    "forcePasswordChange" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerAgent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "enrollmentToken" TEXT NOT NULL,
    "apiKeyHash" TEXT,
    "apiKeyEncrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "ServiceType" NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "projectKey" TEXT NOT NULL,
    "workingDirectory" TEXT NOT NULL,
    "deployDirectory" TEXT,
    "pm2ProcessName" TEXT,
    "templateKey" TEXT,
    "customCommands" JSONB,
    "webhookSecretHash" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "clientId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'DEPLOYING',
    "triggerSource" TEXT NOT NULL,
    "deployerEmail" TEXT,
    "commitHash" TEXT,
    "branch" TEXT,
    "commitMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "failureReason" TEXT,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message" TEXT NOT NULL,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_email_key" ON "Client"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Client_googleSubject_key" ON "Client"("googleSubject");

-- CreateIndex
CREATE UNIQUE INDEX "ServerAgent_enrollmentToken_key" ON "ServerAgent"("enrollmentToken");

-- CreateIndex
CREATE INDEX "ServerAgent_enabled_idx" ON "ServerAgent"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Service_projectKey_key" ON "Service"("projectKey");

-- CreateIndex
CREATE INDEX "Service_clientId_idx" ON "Service"("clientId");

-- CreateIndex
CREATE INDEX "Service_agentId_idx" ON "Service"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_clientId_slug_key" ON "Service"("clientId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_runId_key" ON "Deployment"("runId");

-- CreateIndex
CREATE INDEX "Deployment_serviceId_startedAt_idx" ON "Deployment"("serviceId", "startedAt");

-- CreateIndex
CREATE INDEX "Deployment_startedAt_idx" ON "Deployment"("startedAt");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_timestamp_idx" ON "DeploymentLog"("deploymentId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ServerAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ServerAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

