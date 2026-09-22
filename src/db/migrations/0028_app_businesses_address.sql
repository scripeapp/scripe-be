-- Registered business address — needed as sender compliance data for
-- Brails payouts (POST /api/v2/beneficiaries, per
-- https://docs.brails.com/docs/beneficiaries/nigeria-beneficiary), which
-- had no source of this data anywhere in the rewrite until now. Nullable:
-- filling this in is only required once a business actually tries to send
-- a Brails payout, not at business creation.

alter table app.businesses
  add column "addressLine1" text,
  add column "addressLine2" text,
  add column "city" text,
  add column "state" text,
  add column "postalCode" text,
  add column "country" text not null default 'Nigeria';
