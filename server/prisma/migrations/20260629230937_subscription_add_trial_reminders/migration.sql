-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "trialEndingReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "trialExpiredReminderSentAt" TIMESTAMP(3);
