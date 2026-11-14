-- Persistent in-app notification history.
-- Additive and backward-compatible: one row per recipient per event.
-- The same row is what the bell dropdown, the toast and the Alerts history page read.

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "clientId" TEXT,
    "userEmail" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "dedupeKey" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_scopeKey_createdAt_idx" ON "Notification"("scopeKey", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_scopeKey_readAt_createdAt_idx" ON "Notification"("scopeKey", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_clientId_createdAt_idx" ON "Notification"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
