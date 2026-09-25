-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "weight" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "ReelView" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReelComment" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReelView_productId_idx" ON "ReelView"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ReelView_productId_identityKey_day_key" ON "ReelView"("productId", "identityKey", "day");

-- CreateIndex
CREATE INDEX "ReelComment_productId_createdAt_idx" ON "ReelComment"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "ReelComment_userId_idx" ON "ReelComment"("userId");

-- AddForeignKey
ALTER TABLE "ReelView" ADD CONSTRAINT "ReelView_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelComment" ADD CONSTRAINT "ReelComment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelComment" ADD CONSTRAINT "ReelComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
