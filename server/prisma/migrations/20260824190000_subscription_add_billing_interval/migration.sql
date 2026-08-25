-- DEV-11372: record what a subscription is actually billed at, so we can tell an annual subscriber
-- from a monthly one without calling Stripe.
--
-- "stripePriceId" is nullable: existing rows are back-filled naturally the next time Stripe sends a
-- subscription webhook for them, and nothing depends on it being present.
--
-- "billingInterval" defaults to 'month' rather than being nullable because every subscription sold
-- before annual billing existed was monthly, so that is the true value for every pre-existing row.
ALTER TABLE "Subscription" ADD COLUMN "stripePriceId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "billingInterval" TEXT NOT NULL DEFAULT 'month';
