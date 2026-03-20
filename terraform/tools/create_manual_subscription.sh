#!/bin/bash
#
# Generate SQL statements to manually set up a subscription for a user
# whose Stripe subscription was created outside the normal payment workflow.
#

set -euo pipefail

# Generate a nanoid-style random ID (10 chars, alphanumeric)
generate_id() {
  local prefix="$1"
  local random
  random=$(cat /dev/urandom | LC_ALL=C tr -dc '0-9A-Za-z' | head -c 10)
  echo "${prefix}${random}"
}

# Prompt for inputs
read -rp "User ID: " USER_ID
read -rp "Stripe Customer ID (cus_...): " STRIPE_CUSTOMER_ID
read -rp "Plan Type (FREE_PLAN, PRO_PLAN, MAX_PLAN) [PRO_PLAN]: " PLAN_TYPE
PLAN_TYPE="${PLAN_TYPE:-PRO_PLAN}"
read -rp "Stripe Subscription ID (sub_...): " STRIPE_SUBSCRIPTION_ID

# Validate inputs
if [[ -z "$USER_ID" || -z "$STRIPE_CUSTOMER_ID" || -z "$STRIPE_SUBSCRIPTION_ID" ]]; then
  echo "Error: User ID, Stripe Customer ID, and Stripe Subscription ID are required."
  exit 1
fi

if [[ "$PLAN_TYPE" != "FREE_PLAN" && "$PLAN_TYPE" != "PRO_PLAN" && "$PLAN_TYPE" != "MAX_PLAN" ]]; then
  echo "Error: Plan Type must be one of: FREE_PLAN, PRO_PLAN, MAX_PLAN"
  exit 1
fi

SUBSCRIPTION_ID=$(generate_id "sub_")

cat <<EOF

-- ============================================================
-- Manual Subscription Setup
-- User ID:                ${USER_ID}
-- Stripe Customer ID:     ${STRIPE_CUSTOMER_ID}
-- Stripe Subscription ID: ${STRIPE_SUBSCRIPTION_ID}
-- Plan Type:              ${PLAN_TYPE}
-- Generated Sub ID:       ${SUBSCRIPTION_ID}
-- ============================================================

BEGIN;

-- 1. Set the Stripe customer ID on the user record
UPDATE "User"
SET "stripeCustomerId" = '${STRIPE_CUSTOMER_ID}',
    "updatedAt" = NOW()
WHERE "id" = '${USER_ID}';

-- 2. Create a new Subscription record
INSERT INTO "Subscription" (
  "id",
  "createdAt",
  "updatedAt",
  "version",
  "userId",
  "organizationId",
  "planType",
  "stripeSubscriptionId",
  "expiration",
  "priceInDollars",
  "stripeStatus"
)
SELECT
  '${SUBSCRIPTION_ID}',
  NOW(),
  NOW(),
  1,
  '${USER_ID}',
  u."organizationId",
  '${PLAN_TYPE}',
  '${STRIPE_SUBSCRIPTION_ID}',
  NOW() + INTERVAL '1 month',
  0,
  'active'
FROM "User" u
WHERE u."id" = '${USER_ID}'
  AND u."organizationId" IS NOT NULL;

COMMIT;
EOF
