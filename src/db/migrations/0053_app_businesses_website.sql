-- The onboarding "let's get to know your business" step collects a business
-- website alongside the business name and address. app.businesses already
-- carried the address columns but had no place for a website URL, so add one.
-- Stored as a non-null empty string by default, matching how
-- app.user_profiles.website is persisted.

alter table app.businesses
  add column "website" text not null default '';
