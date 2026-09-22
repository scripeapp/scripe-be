-- Banking: KYC status, dedicated virtual accounts, the wallet ledger, and
-- withdrawal requests. Schema + orchestration only in this slice — per
-- product decision, real money movement (BVN validation, virtual-account
-- provisioning, transfer initiation) goes through PaymentProviderGateway
-- (src/integrations/payment-provider.ts), which has no live provider wired
-- in yet and throws SERVICE_UNAVAILABLE rather than pretending to move
-- money. Approval-gated withdrawals and transaction-PIN verification are
-- deferred to future passes (an approvals domain, a security/settings
-- domain) — withdrawals here are gated on KYC-verified status and the
-- banking.manage permission only.

insert into app.permissions ("code", "description") values
  ('banking.read', 'View banking status, virtual accounts, and wallet transactions'),
  ('banking.manage', 'Submit banking KYC, request virtual accounts, and request withdrawals')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('banking.read', 'banking.manage')
on conflict do nothing;

create table app.banking_profiles (
  "businessId" uuid primary key references app.businesses ("id") on delete restrict,
  "kycStatus" text not null default 'not_started' check ("kycStatus" in ('not_started', 'pending', 'verified', 'failed')),
  "kycFailureReason" text,
  "kycSubmittedAt" timestamptz,
  "kycVerifiedAt" timestamptz,
  "providerCustomerCode" text,
  -- Captured from the KYC submission and reused for later provider calls
  -- (e.g. requesting a virtual account) instead of re-deriving contact
  -- details from an unrelated profile domain.
  "email" text,
  "firstName" text,
  "lastName" text,
  "phone" text,
  -- Plain column for now, per the same call made for compliance's
  -- beneficial-owner PII this session — flagged as an encryption follow-up,
  -- not deferred silently.
  "bvn" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create trigger banking_profiles_set_updated_at before update on app.banking_profiles
  for each row execute function app.set_updated_at();

create table app.virtual_accounts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "provider" text not null default 'paystack',
  "providerCustomerCode" text,
  "providerAccountId" text,
  "accountNumber" text,
  "accountName" text,
  "bankName" text,
  "bankSlug" text,
  "assetCode" text not null default 'NGN' check ("assetCode" ~ '^[A-Z]{3}$'),
  "status" text not null default 'pending' check ("status" in ('pending', 'active', 'failed')),
  "assignmentReference" text,
  "failureReason" text,
  "metadata" jsonb not null default '{}'::jsonb check (jsonb_typeof("metadata") = 'object'),
  "lastRequeryAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
-- At most one pending-or-active virtual account per business — legacy
-- always resolves "the current virtual account" as a single row; enforced
-- here instead of just assumed by the query that reads it back.
create unique index virtual_accounts_one_open_per_business on app.virtual_accounts ("businessId") where "status" in ('pending', 'active');
create index virtual_accounts_business_idx on app.virtual_accounts ("businessId", "createdAt" desc);
create trigger virtual_accounts_set_updated_at before update on app.virtual_accounts
  for each row execute function app.set_updated_at();

create table app.wallet_transactions (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "type" text not null check ("type" in ('deposit', 'withdrawal', 'reversal', 'adjustment', 'bill_payment')),
  "direction" text not null check ("direction" in ('credit', 'debit')),
  "status" text not null default 'pending' check ("status" in ('pending', 'posted')),
  "assetCode" text not null default 'NGN' check ("assetCode" ~ '^[A-Z]{3}$'),
  "amountMinor" bigint not null check ("amountMinor" > 0),
  "grossAmountMinor" bigint check ("grossAmountMinor" is null or "grossAmountMinor" > 0),
  "feeAmountMinor" bigint not null default 0 check ("feeAmountMinor" >= 0),
  "feeBreakdown" jsonb not null default '{}'::jsonb check (jsonb_typeof("feeBreakdown") = 'object'),
  "provider" text not null default 'paystack',
  "providerReference" text not null,
  "description" text not null,
  "metadata" jsonb not null default '{}'::jsonb check (jsonb_typeof("metadata") = 'object'),
  "postedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
-- Idempotency: re-posting the same provider event for the same reference
-- must never double-credit or double-debit the ledger.
create unique index wallet_transactions_provider_reference_idx on app.wallet_transactions ("provider", "providerReference");
create index wallet_transactions_business_idx on app.wallet_transactions ("businessId", "createdAt" desc);

create table app.withdrawals (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "requestedBy" uuid references auth.user ("id") on delete set null,
  "amountMinor" bigint not null check ("amountMinor" > 0),
  "assetCode" text not null default 'NGN' check ("assetCode" ~ '^[A-Z]{3}$'),
  "bankCode" text not null,
  "accountNumber" text not null,
  "accountName" text not null,
  "transferRecipientCode" text,
  "providerReference" text not null unique,
  "providerTransferCode" text,
  "idempotencyKey" text,
  "status" text not null default 'pending' check ("status" in ('pending', 'processing', 'success', 'failed')),
  "failureReason" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create unique index withdrawals_business_idempotency_idx on app.withdrawals ("businessId", "idempotencyKey") where "idempotencyKey" is not null;
create index withdrawals_business_idx on app.withdrawals ("businessId", "createdAt" desc);
create trigger withdrawals_set_updated_at before update on app.withdrawals
  for each row execute function app.set_updated_at();

alter table app.banking_profiles enable row level security;
alter table app.virtual_accounts enable row level security;
alter table app.wallet_transactions enable row level security;
alter table app.withdrawals enable row level security;

create policy banking_profiles_select on app.banking_profiles for select
  using (app.has_business_permission("businessId", 'banking.read'));
create policy banking_profiles_insert on app.banking_profiles for insert
  with check (app.has_business_permission("businessId", 'banking.manage'));
create policy banking_profiles_update on app.banking_profiles for update
  using (app.has_business_permission("businessId", 'banking.manage'))
  with check (app.has_business_permission("businessId", 'banking.manage'));

create policy virtual_accounts_select on app.virtual_accounts for select
  using (app.has_business_permission("businessId", 'banking.read'));
create policy virtual_accounts_insert on app.virtual_accounts for insert
  with check (app.has_business_permission("businessId", 'banking.manage'));
create policy virtual_accounts_update on app.virtual_accounts for update
  using (app.has_business_permission("businessId", 'banking.manage'))
  with check (app.has_business_permission("businessId", 'banking.manage'));

create policy wallet_transactions_select on app.wallet_transactions for select
  using (app.has_business_permission("businessId", 'banking.read'));
create policy wallet_transactions_insert on app.wallet_transactions for insert
  with check (app.has_business_permission("businessId", 'banking.manage'));

create policy withdrawals_select on app.withdrawals for select
  using (app.has_business_permission("businessId", 'banking.read'));
create policy withdrawals_insert on app.withdrawals for insert
  with check (app.has_business_permission("businessId", 'banking.manage'));
create policy withdrawals_update on app.withdrawals for update
  using (app.has_business_permission("businessId", 'banking.manage'))
  with check (app.has_business_permission("businessId", 'banking.manage'));

grant select, insert, update on app.banking_profiles to surge_app;
grant select, insert, update on app.virtual_accounts to surge_app;
grant select, insert on app.wallet_transactions to surge_app;
grant select, insert, update on app.withdrawals to surge_app;
