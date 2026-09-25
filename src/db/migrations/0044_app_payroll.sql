-- Payroll: salary run + per-employee item (PROPOSED_TABLE_INVENTORY.md
-- section 11). Deliberately thin - payroll "reuses beneficiaries, transfers,
-- approvals, and ledger journals. It does not need a second payout system."
-- So a payroll_item's net pay is executed as an app.transfers row (purpose
-- 'payroll') to the employee's beneficiary, and the run's expense is posted
-- through accounting's app.post_journal_entry. This migration adds only the
-- two tables that are genuinely payroll's own.
--
-- Scope decisions (see the domain rewrite report for the full list):
--   * A run's approval is a status transition guarded by the payroll.manage
--     permission, NOT an app.approval_requests row. approvals' subjectType is
--     locked to ('withdrawal','bill_payment') (0031 deliberately rejected a
--     broader taxonomy); wiring a 'payroll' approval subject is a later
--     extension that needs its own approvals change, so it is not invented
--     here.
--   * The run posts ONE journal at pay time for the successfully paid items:
--     debit payroll_expense (gross), credit bank (net), credit tax_payable
--     (deductions). The transfers themselves post no journal, so the cash
--     leg is recorded exactly once here - no double counting.
--   * net = gross - deductions is enforced by a check constraint; amounts are
--     integer minor units (bigint), never float.

insert into app.permissions ("code", "description") values
  ('payroll.read', 'View payroll runs and items'),
  ('payroll.manage', 'Create, approve, and pay payroll runs')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('payroll.read', 'payroll.manage')
on conflict do nothing;

create table app.payroll_runs (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "reference" text not null unique,
  "periodStart" date not null,
  "periodEnd" date not null,
  "status" text not null default 'draft'
    check ("status" in ('draft', 'approved', 'processing', 'paid', 'partially_paid', 'cancelled')),
  "assetCode" text not null default 'NGN' check ("assetCode" ~ '^[A-Z]{3}$'),
  "grossMinor" bigint not null default 0 check ("grossMinor" >= 0),
  "deductionsMinor" bigint not null default 0 check ("deductionsMinor" >= 0),
  "netMinor" bigint not null default 0 check ("netMinor" >= 0),
  "journalEntryId" uuid,
  "approvedBy" uuid references auth.user ("id") on delete set null,
  "approvedAt" timestamptz,
  "createdBy" uuid references auth.user ("id") on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  check ("periodEnd" >= "periodStart"),
  foreign key ("journalEntryId", "businessId") references app.journal_entries ("id", "businessId") on delete restrict,
  unique ("id", "businessId")
);
create index payroll_runs_business_idx on app.payroll_runs ("businessId", "status", "createdAt" desc);

create trigger payroll_runs_set_updated_at before update on app.payroll_runs
  for each row execute function app.set_updated_at();

alter table app.payroll_runs enable row level security;
create policy payroll_runs_read on app.payroll_runs for select
  using (app.has_business_permission("businessId", 'payroll.read'));
create policy payroll_runs_write on app.payroll_runs for all
  using (app.has_business_permission("businessId", 'payroll.manage'))
  with check (app.has_business_permission("businessId", 'payroll.manage'));

grant select, insert, update on app.payroll_runs to scripe_app;

create table app.payroll_items (
  "id" uuid primary key default gen_random_uuid(),
  "payrollRunId" uuid not null,
  "businessId" uuid not null,
  "beneficiaryId" uuid not null,
  "partyId" uuid references app.parties ("id") on delete set null,
  "grossMinor" bigint not null check ("grossMinor" > 0),
  "deductionsMinor" bigint not null default 0 check ("deductionsMinor" >= 0),
  "netMinor" bigint not null check ("netMinor" > 0),
  "transferId" uuid,
  "status" text not null default 'pending' check ("status" in ('pending', 'paid', 'failed')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  check ("netMinor" = "grossMinor" - "deductionsMinor"),
  check ("deductionsMinor" <= "grossMinor"),
  foreign key ("payrollRunId", "businessId") references app.payroll_runs ("id", "businessId") on delete cascade,
  foreign key ("beneficiaryId", "businessId") references app.beneficiaries ("id", "businessId") on delete restrict,
  foreign key ("transferId", "businessId") references app.transfers ("id", "businessId") on delete set null,
  unique ("id", "businessId")
);
create index payroll_items_run_idx on app.payroll_items ("payrollRunId");
create index payroll_items_business_idx on app.payroll_items ("businessId", "status");

create trigger payroll_items_set_updated_at before update on app.payroll_items
  for each row execute function app.set_updated_at();

alter table app.payroll_items enable row level security;
create policy payroll_items_read on app.payroll_items for select
  using (app.has_business_permission("businessId", 'payroll.read'));
create policy payroll_items_write on app.payroll_items for all
  using (app.has_business_permission("businessId", 'payroll.manage'))
  with check (app.has_business_permission("businessId", 'payroll.manage'));

grant select, insert, update on app.payroll_items to scripe_app;
