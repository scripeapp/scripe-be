-- 0005_app_user_profiles_rich_fields.sql
-- Extends app.user_profiles with the product profile fields the frontend reads
-- from GET /api/me (rules F.3). Deprecated subscription mirrors and unused
-- legacy columns are intentionally not reproduced.
-- Runs as surge_migrator.

alter table app.user_profiles
    add column "firstName"     text  not null default '',
    add column "lastName"      text  not null default '',
    add column "username"      text,
    add column "bio"           text  not null default '',
    add column "website"       text  not null default '',
    add column "location"      text  not null default '',
    add column "phoneNumber"   text  not null default '',
    add column "gender"        text  not null default '',
    add column "socialLinks"   jsonb not null default '{}'::jsonb,
    add column "accountStatus" text  not null default 'active',
    add column "accountType"   text  not null default 'personal',
    add column "preferences"   jsonb not null default '{}'::jsonb;

comment on column app.user_profiles."username" is
  'Public handle; null until set from profile settings.';
comment on column app.user_profiles."preferences" is
  'JSON object for onboarding and display preferences (e.g. onboarding_role, onboarding_completed).';

-- Usernames are public identifiers; enforce case-insensitive uniqueness only
-- when present so profileless rows stay valid.
create unique index user_profiles_username_lower_key
    on app.user_profiles (lower("username"))
    where "username" is not null;
