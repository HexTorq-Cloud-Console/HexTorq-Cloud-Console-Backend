-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "clientId" TEXT,
    "userEmail" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "clientId" TEXT,
    "userEmail" TEXT NOT NULL,
    "emailAddress" TEXT,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notifyStarted" BOOLEAN NOT NULL DEFAULT true,
    "notifyCompleted" BOOLEAN NOT NULL DEFAULT true,
    "notifyFailed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_scopeKey_idx" ON "PushSubscription"("scopeKey");

-- CreateIndex
CREATE INDEX "PushSubscription_clientId_idx" ON "PushSubscription"("clientId");

-- CreateIndex
CREATE INDEX "PushSubscription_userEmail_idx" ON "PushSubscription"("userEmail");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_scopeKey_key" ON "NotificationPreference"("scopeKey");

-- CreateIndex
CREATE INDEX "NotificationPreference_clientId_idx" ON "NotificationPreference"("clientId");

-- CreateIndex
CREATE INDEX "NotificationPreference_userEmail_idx" ON "NotificationPreference"("userEmail");

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
