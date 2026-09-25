-- Compliance: business legal identity, KYB (beneficial owners, cases,
-- documents, provider-neutral submission attempts), user consent records,
-- and the NDPR data-privacy request lifecycle. No legacy evidence existed
-- for KYB/consent — this is genuinely new schema, built narrow per explicit
-- product decisions:
--   - Plain columns now. Encryption/tokenization for sensitive KYB fields
--     (rules.md) is a flagged follow-up requiring its own KMS decision, not
--     improvised here.
--   - No live Brails/Anchor API calls. compliance_submissions records
--     attempts and their normalized result only, mirroring how payments
--     stays provider-neutral rather than embedding a gateway integration.
--   - No cross-domain data export/anonymization. data_privacy_requests
--     covers the request lifecycle only (submit, view own); actually
--     fulfilling a request stays a manual, out-of-band process for now,
--     since automating it means touching every other domain's tables.

insert into app.permissions ("code", "description") values
  ('compliance.read', 'View business legal identity and KYB compliance records'),
  ('compliance.manage', 'Manage business legal identity, beneficial owners, and KYB compliance')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('compliance.read', 'compliance.manage')
on conflict do nothing;

create table app.business_legal_profiles (
  "businessId" uuid primary key references app.businesses ("id") on delete restrict,
  "registeredName" text not null check (length(trim("registeredName")) between 1 and 200),
  "registrationNumber" text not null,
  "taxIdentificationNumber" text,
  "countryCode" text not null default 'NG' check ("countryCode" ~ '^[A-Z]{2}$'),
  "addressLine1" text not null,
  "addressLine2" text,
  "city" text not null,
  "state" text not null,
  "postalCode" text,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create trigger business_legal_profiles_set_updated_at before update on app.business_legal_profiles
  for each row execute function app.set_updated_at();

create table app.beneficial_owners (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "fullName" text not null check (length(trim("fullName")) between 1 and 200),
  "relationship" text not null check ("relationship" in ('director', 'shareholder', 'ultimate_beneficial_owner')),
  "ownershipPercentageBps" integer check ("ownershipPercentageBps" is null or "ownershipPercentageBps" between 0 and 10000),
  "idType" text not null check ("idType" in ('nin', 'passport', 'drivers_license', 'voters_card')),
  "idNumber" text not null,
  "nationality" text not null default 'NG' check ("nationality" ~ '^[A-Z]{2}$'),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "businessId")
);
create index beneficial_owners_business_idx on app.beneficial_owners ("businessId") where "archivedAt" is null;
create trigger beneficial_owners_set_updated_at before update on app.beneficial_owners
  for each row execute function app.set_updated_at();
comment on column app.beneficial_owners."idNumber" is 'Plain text in this slice — flagged for encryption/tokenization before real KYB data is stored (rules.md D).';

create table app.compliance_cases (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "status" text not null default 'draft' check ("status" in ('draft', 'in_review', 'approved', 'rejected', 'requires_more_info')),
  "notes" text,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "closedAt" timestamptz,
  unique ("id", "businessId")
);
-- Only one non-terminal case open per business at a time.
create unique index compliance_cases_one_open_per_business on app.compliance_cases ("businessId")
  where "status" in ('draft', 'in_review', 'requires_more_info');
create index compliance_cases_business_idx on app.compliance_cases ("businessId", "createdAt" desc);
create trigger compliance_cases_set_updated_at before update on app.compliance_cases
  for each row execute function app.set_updated_at();

create table app.compliance_documents (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "caseId" uuid not null,
  "type" text not null check ("type" in ('certificate_of_incorporation', 'tax_certificate', 'proof_of_address', 'identity_document', 'other')),
  "objectKey" text not null,
  "mimeType" text not null,
  "sizeBytes" bigint not null check ("sizeBytes" > 0),
  "expiresAt" timestamptz,
  "retentionUntil" timestamptz,
  "uploadedBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  foreign key ("caseId", "businessId") references app.compliance_cases ("id", "businessId") on delete restrict,
  unique ("businessId", "objectKey")
);
create index compliance_documents_case_idx on app.compliance_documents ("businessId", "caseId");
comment on column app.compliance_documents."objectKey" is 'Metadata only in this slice — no R2 upload flow exists yet (uploads domain not built). Values are not validated against real storage.';

create table app.compliance_submissions (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "caseId" uuid not null,
  "provider" text not null check ("provider" in ('brails', 'anchor')),
  "status" text not null default 'pending' check ("status" in ('pending', 'succeeded', 'failed')),
  "externalReference" text,
  "responseSnapshot" jsonb not null default '{}'::jsonb check (jsonb_typeof("responseSnapshot") = 'object'),
  "submittedBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  foreign key ("caseId", "businessId") references app.compliance_cases ("id", "businessId") on delete restrict
);
create index compliance_submissions_case_idx on app.compliance_submissions ("businessId", "caseId", "createdAt" desc);
comment on table app.compliance_submissions is 'Records submission attempts and their normalized result only — no live provider API call is made by this slice.';

alter table app.business_legal_profiles enable row level security;
alter table app.beneficial_owners enable row level security;
alter table app.compliance_cases enable row level security;
alter table app.compliance_documents enable row level security;
alter table app.compliance_submissions enable row level security;

create policy business_legal_profiles_read on app.business_legal_profiles for select
  using (app.has_business_permission("businessId", 'compliance.read'));
create policy business_legal_profiles_insert on app.business_legal_profiles for insert
  with check (app.has_business_permission("businessId", 'compliance.manage'));
create policy business_legal_profiles_update on app.business_legal_profiles for update
  using (app.has_business_permission("businessId", 'compliance.manage'))
  with check (app.has_business_permission("businessId", 'compliance.manage'));

create policy beneficial_owners_read on app.beneficial_owners for select
  using (app.has_business_permission("businessId", 'compliance.read'));
create policy beneficial_owners_insert on app.beneficial_owners for insert
  with check (app.has_business_permission("businessId", 'compliance.manage'));
create policy beneficial_owners_update on app.beneficial_owners for update
  using (app.has_business_permission("businessId", 'compliance.manage'))
  with check (app.has_business_permission("businessId", 'compliance.manage'));

create policy compliance_cases_read on app.compliance_cases for select
  using (app.has_business_permission("businessId", 'compliance.read'));
create policy compliance_cases_insert on app.compliance_cases for insert
  with check (app.has_business_permission("businessId", 'compliance.manage'));
create policy compliance_cases_update on app.compliance_cases for update
  using (app.has_business_permission("businessId", 'compliance.manage'))
  with check (app.has_business_permission("businessId", 'compliance.manage'));

create policy compliance_documents_read on app.compliance_documents for select
  using (app.has_business_permission("businessId", 'compliance.read'));
create policy compliance_documents_insert on app.compliance_documents for insert
  with check (app.has_business_permission("businessId", 'compliance.manage'));

create policy compliance_submissions_read on app.compliance_submissions for select
  using (app.has_business_permission("businessId", 'compliance.read'));
create policy compliance_submissions_insert on app.compliance_submissions for insert
  with check (app.has_business_permission("businessId", 'compliance.manage'));

grant select, insert, update on app.business_legal_profiles, app.beneficial_owners, app.compliance_cases to scripe_app;
grant select, insert on app.compliance_documents, app.compliance_submissions to scripe_app;

-- Personal, user-scoped tables (not business-tenancy scoped).

create table app.user_consents (
  "id" uuid primary key default gen_random_uuid(),
  "userId" uuid not null references auth.user ("id") on delete cascade,
  "consentType" text not null check ("consentType" in ('terms', 'privacy', 'marketing')),
  "version" text not null check (length(trim("version")) between 1 and 40),
  "grantedAt" timestamptz not null default now(),
  "revokedAt" timestamptz,
  unique ("userId", "consentType", "version")
);
create index user_consents_user_idx on app.user_consents ("userId", "consentType", "grantedAt" desc);

alter table app.user_consents enable row level security;
create policy user_consents_select_own on app.user_consents for select using (app.current_user_id() = "userId"::text);
create policy user_consents_insert_own on app.user_consents for insert with check (app.current_user_id() = "userId"::text);
create policy user_consents_update_own on app.user_consents for update
  using (app.current_user_id() = "userId"::text)
  with check (app.current_user_id() = "userId"::text);

grant select, insert, update on app.user_consents to scripe_app;

create table app.data_privacy_requests (
  "id" uuid primary key default gen_random_uuid(),
  "userId" uuid not null references auth.user ("id") on delete cascade,
  "businessId" uuid references app.businesses ("id") on delete set null,
  "type" text not null check ("type" in ('access', 'deletion', 'portability', 'rectification', 'objection')),
  "status" text not null default 'pending' check ("status" in ('pending', 'processing', 'completed', 'rejected')),
  "description" text,
  "dueAt" timestamptz not null,
  "createdAt" timestamptz not null default now()
);
create index data_privacy_requests_user_idx on app.data_privacy_requests ("userId", "createdAt" desc);

alter table app.data_privacy_requests enable row level security;
create policy data_privacy_requests_select_own on app.data_privacy_requests for select using (app.current_user_id() = "userId"::text);
create policy data_privacy_requests_insert_own on app.data_privacy_requests for insert with check (app.current_user_id() = "userId"::text);

grant select, insert on app.data_privacy_requests to scripe_app;
