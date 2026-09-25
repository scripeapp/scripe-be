-- Transfers: the canonical, provider-neutral outbound money-movement domain
-- (PROPOSED_TABLE_INVENTORY.md section 9). One payout system that every
-- merchant workflow reuses - wallet withdrawals, supplier payments, and
-- payroll all become transfers with a `purpose`, rather than each growing
-- its own payout table (section 11: payroll "does not need a second payout
-- system"). This lands the canonical model per the approved Path A decision;
-- the already-shipped banking.withdrawals table is refactored onto it in a
-- separate, isolated step so the merge is reviewable on its own.
--
-- Scope decisions (see the domain rewrite report for the full list):
--   * Provider identity (recipient code, transfer code, provider reference,
--     raw result) lives ONLY on transfer_attempts, never on transfers or
--     beneficiaries - "Provider IDs live in integration/link tables, never
--     as columns on core domain tables" (inventory section, Provider roles).
--     A beneficiary is provider-neutral bank coordinates; an attempt is the
--     per-provider execution record. Recipient codes are re-created per
--     attempt for now; caching them per (beneficiary, provider) is a later
--     optimization that does not change this schema.
--   * A transfer's balanced journal entry is posted through accounting's
--     app.post_journal_entry (0042) at gate time, alongside the pending
--     debit - the same double-spend-closing pattern the shipped withdrawal
--     flow uses: a second concurrent transfer must see the amount already
--     reserved. journalEntryId is nullable only for the brief window before
--     the posting leg inside the same transaction; a committed transfer
--     always carries one.
--   * Approval gating reuses approvals' existing "withdrawal" WorkflowType
--     (0031) with the transfer id as the subject. No new approval taxonomy
--     is introduced - 0031 deliberately rejected legacy's broader transfer
--     taxonomy and nothing here re-adds it.
--   * transfer_attempts is append-only per provider submission (immutable
--     once written) - a retry is a new attempt row, never an edit, so the
--     full provider execution history is auditable.

insert into app.permissions ("code", "description") values
  ('transfers.read', 'View beneficiaries and outbound transfers'),
  ('transfers.manage', 'Manage beneficiaries and request outbound transfers')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('transfers.read', 'transfers.manage')
on conflict do nothing;

-- Reusable, verified payout destination. Provider-neutral bank coordinates
-- only; optionally linked to a party (supplier/employee) for reporting.
create table app.beneficiaries (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "partyId" uuid references app.parties ("id") on delete set null,
  "kind" text not null check ("kind" in ('supplier', 'employee', 'owner', 'general')),
  "bankCode" text not null check (length(trim("bankCode")) between 1 and 20),
  "accountNumber" text not null check (length(trim("accountNumber")) between 1 and 20),
  "accountName" text not null check (length(trim("accountName")) between 1 and 160),
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  -- Same destination is one beneficiary per business; re-adding it returns
  -- the existing row rather than duplicating a payout target.
  unique ("businessId", "bankCode", "accountNumber"),
  -- Tenant-safe composite target for transfers.beneficiaryId.
  unique ("id", "businessId")
);
create index beneficiaries_business_idx on app.beneficiaries ("businessId", "status");
create index beneficiaries_party_idx on app.beneficiaries ("businessId", "partyId");

create trigger beneficiaries_set_updated_at before update on app.beneficiaries
  for each row execute function app.set_updated_at();

alter table app.beneficiaries enable row level security;
create policy beneficiaries_read on app.beneficiaries for select
  using (app.has_business_permission("businessId", 'transfers.read'));
create policy beneficiaries_write on app.beneficiaries for all
  using (app.has_business_permission("businessId", 'transfers.manage'))
  with check (app.has_business_permission("businessId", 'transfers.manage'));

grant select, insert, update on app.beneficiaries to scripe_app;

-- Provider-neutral outbound money movement requested by a merchant workflow.
-- `purpose` records which workflow raised it; the row itself carries no
-- provider identity.
create table app.transfers (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "beneficiaryId" uuid not null,
  "amountMinor" bigint not null check ("amountMinor" > 0),
  "assetCode" text not null default 'NGN' check ("assetCode" ~ '^[A-Z]{3}$'),
  "purpose" text not null check ("purpose" in ('withdrawal', 'supplier_payment', 'payroll', 'general')),
  "status" text not null default 'pending'
    check ("status" in ('pending', 'awaitingApproval', 'processing', 'success', 'failed', 'rejected')),
  "reference" text not null unique,
  "idempotencyKey" text,
  "journalEntryId" uuid,
  "approvalRequestId" uuid references app.approval_requests ("id") on delete set null,
  "requestedBy" uuid references auth.user ("id") on delete set null,
  "requestId" text,
  "failureReason" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  -- Tenant-scoped beneficiary link (cannot point at another business's row).
  foreign key ("beneficiaryId", "businessId") references app.beneficiaries ("id", "businessId") on delete restrict,
  -- Tenant-scoped journal link into 0042's (id, businessId) unique.
  foreign key ("journalEntryId", "businessId") references app.journal_entries ("id", "businessId") on delete restrict,
  -- Retried requests dedupe to the same transfer within the business.
  unique ("businessId", "idempotencyKey"),
  -- Tenant-safe composite target for downstream (e.g. payroll_items.transferId).
  unique ("id", "businessId")
);
create index transfers_business_idx on app.transfers ("businessId", "status", "createdAt" desc);
create index transfers_beneficiary_idx on app.transfers ("businessId", "beneficiaryId");
create index transfers_purpose_idx on app.transfers ("businessId", "purpose", "createdAt" desc);

create trigger transfers_set_updated_at before update on app.transfers
  for each row execute function app.set_updated_at();

alter table app.transfers enable row level security;
create policy transfers_read on app.transfers for select
  using (app.has_business_permission("businessId", 'transfers.read'));
create policy transfers_write on app.transfers for all
  using (app.has_business_permission("businessId", 'transfers.manage'))
  with check (app.has_business_permission("businessId", 'transfers.manage'));

grant select, insert, update on app.transfers to scripe_app;

-- Append-only per-provider execution record. A retry is a new row, never an
-- edit - the full submission history stays auditable. Provider identity
-- lives here and nowhere else.
create table app.transfer_attempts (
  "id" uuid primary key default gen_random_uuid(),
  "transferId" uuid not null,
  "businessId" uuid not null,
  "provider" text not null check (length(trim("provider")) between 1 and 40),
  "providerRecipientCode" text,
  "providerTransferCode" text,
  "providerReference" text not null unique,
  "status" text not null default 'pending' check ("status" in ('pending', 'processing', 'success', 'failed')),
  "failureReason" text,
  -- Bounded provider response snapshot for audit/debugging only; never a
  -- query surface for money semantics.
  "rawResult" jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("transferId", "businessId") references app.transfers ("id", "businessId") on delete cascade
);
create index transfer_attempts_transfer_idx on app.transfer_attempts ("transferId", "createdAt" desc);
create index transfer_attempts_business_idx on app.transfer_attempts ("businessId", "createdAt" desc);

create trigger transfer_attempts_set_updated_at before update on app.transfer_attempts
  for each row execute function app.set_updated_at();

alter table app.transfer_attempts enable row level security;
create policy transfer_attempts_read on app.transfer_attempts for select
  using (app.has_business_permission("businessId", 'transfers.read'));
create policy transfer_attempts_write on app.transfer_attempts for all
  using (app.has_business_permission("businessId", 'transfers.manage'))
  with check (app.has_business_permission("businessId", 'transfers.manage'));

grant select, insert, update on app.transfer_attempts to scripe_app;
