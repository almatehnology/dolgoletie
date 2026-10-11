ALTER TABLE "Person" ADD COLUMN "birthDate" TEXT;
CREATE TABLE "ImportReceipt" ("id" TEXT NOT NULL PRIMARY KEY, "result" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "DatabaseMetadata" ("id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main', "databaseId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "ChangeOperation" ("id" TEXT NOT NULL PRIMARY KEY, "entity" TEXT NOT NULL, "entityId" TEXT NOT NULL, "before" TEXT, "after" TEXT, "parents" TEXT NOT NULL DEFAULT '[]', "deviceId" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "ChangeOperation_entity_entityId_idx" ON "ChangeOperation"("entity", "entityId");
CREATE UNIQUE INDEX "ChangeOperation_deviceId_sequence_key" ON "ChangeOperation"("deviceId", "sequence");
CREATE TABLE "SyncReceipt" ("id" TEXT NOT NULL PRIMARY KEY, "result" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
