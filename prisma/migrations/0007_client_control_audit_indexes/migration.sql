-- Additive, backward-compatible migration.
-- Adds the per-service client PM2 control flag, enriches the audit log with the
-- actor's role/tenant, and adds indexes used by the analytics aggregates.
-- No existing rows are modified and no columns are dropped.

-- Per-service permission: when false, CLIENT accounts cannot start/stop/restart it.
ALTER TABLE "Service" ADD COLUMN "clientControlEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Audit enrichment (nullable so existing rows remain valid).
ALTER TABLE "AuditLog" ADD COLUMN "actorRole" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "clientId" TEXT;

-- Analytics / lookup indexes.
CREATE INDEX "Deployment_serviceId_completedAt_idx" ON "Deployment"("serviceId", "completedAt");
CREATE INDEX "Deployment_status_startedAt_idx" ON "Deployment"("status", "startedAt");
CREATE INDEX "AuditLog_actorEmail_idx" ON "AuditLog"("actorEmail");
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");
