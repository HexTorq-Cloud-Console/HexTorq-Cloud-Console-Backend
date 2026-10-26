-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('SFTP', 'DATABASE');

-- CreateTable
CREATE TABLE "ClientAccess" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "AccessType" NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "path" TEXT,
    "databaseName" TEXT,
    "sslMode" TEXT,
    "notes" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientAccess_clientId_idx" ON "ClientAccess"("clientId");

-- CreateIndex
CREATE INDEX "ClientAccess_clientId_type_idx" ON "ClientAccess"("clientId", "type");

-- AddForeignKey
ALTER TABLE "ClientAccess" ADD CONSTRAINT "ClientAccess_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
