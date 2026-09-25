-- Approvals: multi-tier, multi-approver sign-off workflows gating money
-- movement. Ported from legacy's approval-workflow.service.ts + its
-- 20260907_approval_workflows_*.sql migrations, redesigned around what
-- this rewrite actually has to gate — legacy's Bills/Transfers/transferSource
-- taxonomy existed to support a bill-*approval* gate and a bill-triggered
-- wallet disbursement gate, neither of which exist here: `next`'s payables
-- domain only records payments that already happened externally (no wallet
-- money movement), and there's no bill-approval-itself gate evidenced as
-- ever having been wired live in legacy either (checked: createBillWithItems
-- never calls the gate). So this models exactly the two real things being
-- gated — a withdrawal (real wallet money movement) and a bill payment
-- allocation (a payables record, no wallet involved) — via
-- "withdrawal" | "bill_payment" | "all", not legacy's four-way taxonomy.
--
-- The runtime engine (steps JSONB snapshot, pending_approver_ids denorm,
-- optimistic-concurrency version column, sequential/require-all semantics)
-- is a faithful port of legacy's actual algorithm, not a redesign — see
-- approvals.service.ts for the exact ported logic.

insert into app.permissions ("code", "description") values
  ('approvals.workflow.read', 'View approval workflow configuration'),
  ('approvals.workflow.manage', 'Create, edit, and delete approval workflows')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('approvals.workflow.read', 'approvals.workflow.manage')
on conflict do nothing;

create table app.approval_workflows (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "name" text not null check (length(trim("name")) between 1 and 160),
  "type" text not null check ("type" in ('withdrawal', 'bill_payment', 'all')),
  "status" text not null default 'active' check ("status" in ('active', 'inactive')),
  "triggerTitle" text,
  "triggerSubtitle" text,
  "noSelfApproval" boolean not null default true,
  "creatorName" text not null default '',
  "creatorEmail" text not null default '',
  "creatorRole" text not null default 'owner',
  "createdBy" uuid references auth.user ("id") on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- An active workflow's coverage must never overlap another active
-- workflow's — 'all' covers both kinds, so it conflicts with an active
-- workflow of either specific type (and with a second active 'all').
create unique index approval_workflows_active_withdrawal_idx on app.approval_workflows ("businessId")
  where "status" = 'active' and "type" in ('withdrawal', 'all');
create unique index approval_workflows_active_bill_payment_idx on app.approval_workflows ("businessId")
  where "status" = 'active' and "type" in ('bill_payment', 'all');
create index approval_workflows_business_idx on app.approval_workflows ("businessId");

-- Empty (no rows for a workflow) means "anyone with the relevant manage
-- permission" may submit into it.
create table app.approval_workflow_submitters (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "workflowId" uuid not null references app.approval_workflows ("id") on delete cascade,
  "userId" uuid references auth.user ("id") on delete set null,
  "email" text,
  "name" text not null,
  "role" text,
  "createdAt" timestamptz not null default now()
);
create index approval_workflow_submitters_workflow_idx on app.approval_workflow_submitters ("workflowId");

-- Sequential steps in a workflow's approval chain.
create table app.approval_groups (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "workflowId" uuid not null references app.approval_workflows ("id") on delete cascade,
  "title" text not null,
  "subtitle" text,
  "position" integer not null default 0,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index approval_groups_workflow_idx on app.approval_groups ("workflowId", "position");

-- A group's full approver roster — used directly when a rule doesn't name
-- its own narrower approver subset.
create table app.approval_group_approvers (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "groupId" uuid not null references app.approval_groups ("id") on delete cascade,
  "userId" uuid references auth.user ("id") on delete set null,
  "email" text,
  "name" text not null,
  "role" text,
  "createdAt" timestamptz not null default now()
);
create index approval_group_approvers_group_idx on app.approval_group_approvers ("groupId");

-- Amount-tier rules within a group, e.g. "Over 1,000,000 needs Owner and
-- Finance". A rule with both bounds null is a catch-all ("Everything
-- else") and matches as the fallback when no bounded rule applies.
create table app.approval_rules (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "groupId" uuid not null references app.approval_groups ("id") on delete cascade,
  "rangeLabel" text not null,
  "description" text not null default '',
  "minAmountMinor" bigint check ("minAmountMinor" is null or "minAmountMinor" >= 0),
  "maxAmountMinor" bigint check ("maxAmountMinor" is null or "maxAmountMinor" >= 0),
  "requireAll" boolean not null default true,
  "sequential" boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint approval_rules_amount_range_check check (
    "minAmountMinor" is null or "maxAmountMinor" is null or "minAmountMinor" <= "maxAmountMinor"
  )
);
create index approval_rules_group_idx on app.approval_rules ("groupId");

-- A rule's own narrower approver subset (position matters only when the
-- rule is sequential). Empty means "use the group's full approver list".
create table app.approval_rule_approvers (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "ruleId" uuid not null references app.approval_rules ("id") on delete cascade,
  "userId" uuid references auth.user ("id") on delete set null,
  "email" text,
  "name" text not null,
  "role" text,
  "position" integer not null default 0,
  "createdAt" timestamptz not null default now()
);
create index approval_rule_approvers_rule_idx on app.approval_rule_approvers ("ruleId", "position");

-- The runtime table backing an in-flight sign-off. subjectType/subjectId
-- has no FK (mirrors legacy exactly) — it can point at app.withdrawals or
-- a pre-generated app.bill_payment_allocations id (see
-- payables.service.ts — a gated allocation's row doesn't exist yet when
-- this request is created, only once approved). RLS + businessId scoping
-- keep this safe without a real cross-table foreign key.
create table app.approval_requests (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "subjectType" text not null check ("subjectType" in ('withdrawal', 'bill_payment')),
  "subjectId" uuid not null,
  -- Snapshot, not a live join: freezes the policy exactly as it existed
  -- when the request was created, immune to later edits to the workflow.
  "workflowId" uuid references app.approval_workflows ("id") on delete set null,
  "workflowName" text not null,
  "requestedBy" uuid references auth.user ("id") on delete set null,
  "amountMinor" bigint not null check ("amountMinor" >= 0),
  "assetCode" text not null default 'NGN' check ("assetCode" ~ '^[A-Z]{3}$'),
  "status" text not null default 'pending' check ("status" in ('pending', 'approved', 'rejected', 'cancelled')),
  -- One entry per group: {groupId,title,position,requireAll,sequential,status,approvers:[{userId,email,name,position,decision,decidedAt}]}
  "steps" jsonb not null default '[]'::jsonb check (jsonb_typeof("steps") = 'array'),
  -- Denormalized from steps[0] for cheap "what's pending for me" lookups
  -- without unpacking JSONB per request.
  "pendingApproverIds" uuid[] not null default '{}',
  -- The parameters needed to actually perform a gated bill-payment
  -- allocation once approved (nothing exists to update in place the way a
  -- withdrawal row does) — null for subjectType='withdrawal', which has
  -- its own 'awaitingApproval' status to hold instead.
  "pendingPayload" jsonb,
  -- Optimistic concurrency: every decision write does a compare-and-swap
  -- UPDATE ... WHERE id=X AND version=expected, so two concurrent
  -- "any-one" approvers acting on the same step can't both win.
  "version" integer not null default 0,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("subjectType", "subjectId")
);

create index approval_requests_business_status_idx on app.approval_requests ("businessId", "status");
create index approval_requests_pending_approvers_idx on app.approval_requests using gin ("pendingApproverIds") where "status" = 'pending';

create trigger approval_workflows_set_updated_at before update on app.approval_workflows
  for each row execute function app.set_updated_at();
create trigger approval_groups_set_updated_at before update on app.approval_groups
  for each row execute function app.set_updated_at();
create trigger approval_rules_set_updated_at before update on app.approval_rules
  for each row execute function app.set_updated_at();
create trigger approval_requests_set_updated_at before update on app.approval_requests
  for each row execute function app.set_updated_at();

alter table app.approval_workflows enable row level security;
alter table app.approval_workflow_submitters enable row level security;
alter table app.approval_groups enable row level security;
alter table app.approval_group_approvers enable row level security;
alter table app.approval_rules enable row level security;
alter table app.approval_rule_approvers enable row level security;
alter table app.approval_requests enable row level security;

-- Workflow config: gated on approvals.workflow.read/manage.
create policy approval_workflows_select on app.approval_workflows for select
  using (app.has_business_permission("businessId", 'approvals.workflow.read'));
create policy approval_workflows_write on app.approval_workflows for all
  using (app.has_business_permission("businessId", 'approvals.workflow.manage'))
  with check (app.has_business_permission("businessId", 'approvals.workflow.manage'));

create policy approval_workflow_submitters_select on app.approval_workflow_submitters for select
  using (app.has_business_permission("businessId", 'approvals.workflow.read'));
create policy approval_workflow_submitters_write on app.approval_workflow_submitters for all
  using (app.has_business_permission("businessId", 'approvals.workflow.manage'))
  with check (app.has_business_permission("businessId", 'approvals.workflow.manage'));

create policy approval_groups_select on app.approval_groups for select
  using (app.has_business_permission("businessId", 'approvals.workflow.read'));
create policy approval_groups_write on app.approval_groups for all
  using (app.has_business_permission("businessId", 'approvals.workflow.manage'))
  with check (app.has_business_permission("businessId", 'approvals.workflow.manage'));

create policy approval_group_approvers_select on app.approval_group_approvers for select
  using (app.has_business_permission("businessId", 'approvals.workflow.read'));
create policy approval_group_approvers_write on app.approval_group_approvers for all
  using (app.has_business_permission("businessId", 'approvals.workflow.manage'))
  with check (app.has_business_permission("businessId", 'approvals.workflow.manage'));

create policy approval_rules_select on app.approval_rules for select
  using (app.has_business_permission("businessId", 'approvals.workflow.read'));
create policy approval_rules_write on app.approval_rules for all
  using (app.has_business_permission("businessId", 'approvals.workflow.manage'))
  with check (app.has_business_permission("businessId", 'approvals.workflow.manage'));

create policy approval_rule_approvers_select on app.approval_rule_approvers for select
  using (app.has_business_permission("businessId", 'approvals.workflow.read'));
create policy approval_rule_approvers_write on app.approval_rule_approvers for all
  using (app.has_business_permission("businessId", 'approvals.workflow.manage'))
  with check (app.has_business_permission("businessId", 'approvals.workflow.manage'));

-- Approval requests: readable by anyone with workflow-read (to see what's
-- in flight); insert/update happens via the app role from service code,
-- gated by the caller already having proven eligibility upstream (a
-- specific role permission for insert, per-row/per-step eligibility for
-- decisions) rather than a single blanket permission — mirrors legacy's
-- explicit choice not to gate decide endpoints on requirePermission.
create policy approval_requests_select on app.approval_requests for select
  using (app.has_business_permission("businessId", 'approvals.workflow.read'));
create policy approval_requests_insert on app.approval_requests for insert
  with check (app.has_business_permission("businessId", 'banking.manage') or app.has_business_permission("businessId", 'payables.manage'));
create policy approval_requests_update on app.approval_requests for update
  using (app.has_business_permission("businessId", 'banking.manage') or app.has_business_permission("businessId", 'payables.manage'))
  with check (app.has_business_permission("businessId", 'banking.manage') or app.has_business_permission("businessId", 'payables.manage'));

grant select, insert, update, delete on app.approval_workflows to scripe_app;
grant select, insert, update, delete on app.approval_workflow_submitters to scripe_app;
grant select, insert, update, delete on app.approval_groups to scripe_app;
grant select, insert, update, delete on app.approval_group_approvers to scripe_app;
grant select, insert, update, delete on app.approval_rules to scripe_app;
grant select, insert, update, delete on app.approval_rule_approvers to scripe_app;
grant select, insert, update on app.approval_requests to scripe_app;

-- A gated withdrawal sits in 'awaitingApproval' before any provider call is
-- made; a rejected one never gets one at all.
alter table app.withdrawals drop constraint if exists withdrawals_status_check;
alter table app.withdrawals add constraint withdrawals_status_check
  check ("status" in ('pending', 'awaitingApproval', 'processing', 'success', 'failed', 'rejected'));
