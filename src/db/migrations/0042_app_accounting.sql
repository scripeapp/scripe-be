-- Accounting: double-entry ledger (chart of accounts, journal entries,
-- journal lines, accounting periods) plus the retrofit of every other
-- shipped domain whose events should post a journal - payments (capture),
-- returns (refund obligation), payables (bill creation and payment), and
-- inventory (waste). Not a legacy port: legacy's bookkeeping.service.ts was
-- a single flat bookkeeping_transactions income/expense table with no
-- double-entry, no chart of accounts, and no per-domain wiring beyond a
-- manual "sync this order as income" call. PROPOSED_TABLE_INVENTORY.md
-- section 10 calls for real double-entry instead, so this is a redesign,
-- not a translation of that table.
--
-- Scope decisions (see the domain rewrite report for the full list):
--   * Goods receipts (procurement) post nothing. The bill is what formally
--     recognizes the liability and the expense/asset - a goods receipt is a
--     physical quantity event, not a financial one in this model. This also
--     sidesteps a real double-counting question (a bill line can reference
--     a goodsReceiptId) by construction: only one place ever posts.
--   * No COGS-on-sale posting - inventory's "sale" stock-transaction type
--     doesn't carry a reliable unit cost at that call site the way "waste"
--     does, and nothing evidences this as a currently-needed report.
--   * bill_lines."accountCategory" is caller-supplied free text (no legacy
--     or schema-level enum). It's matched case-insensitively against a
--     known set of ledger account codes with a general_expense fallback,
--     rather than treated as a hard foreign key - this keeps payables'
--     already-shipped createBill working unchanged for any caller that
--     supplies an unrecognized category.
--   * No exchange_rates or financial_account_daily_balances tables - both
--     are approved in the inventory doc but have zero current caller
--     (single-currency NGN throughout this codebase) or are explicitly a
--     rebuildable reporting cache, not core ledger truth. Can be added
--     later without disturbing this migration.
--   * accounting_periods are plain calendar months, lazily created on first
--     post. Locking one blocks further posts dated inside it; nothing
--     currently closes a period automatically.

insert into app.permissions ("code", "description") values
  ('accounting.read', 'View the chart of accounts, journal entries, and financial reports'),
  ('accounting.manage', 'Manage the chart of accounts and lock accounting periods')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('accounting.read', 'accounting.manage')
on conflict do nothing;

create table app.ledger_accounts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "code" text not null check (length(trim("code")) between 1 and 60),
  "name" text not null check (length(trim("name")) between 1 and 160),
  "type" text not null check ("type" in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  "isSystem" boolean not null default true,
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "code"),
  unique ("id", "businessId")
);
create index ledger_accounts_business_idx on app.ledger_accounts ("businessId", "status");

create trigger ledger_accounts_set_updated_at before update on app.ledger_accounts
  for each row execute function app.set_updated_at();

alter table app.ledger_accounts enable row level security;
create policy ledger_accounts_read on app.ledger_accounts for select
  using (app.has_business_permission("businessId", 'accounting.read'));
create policy ledger_accounts_write on app.ledger_accounts for all
  using (app.has_business_permission("businessId", 'accounting.manage'))
  with check (app.has_business_permission("businessId", 'accounting.manage'));

grant select, insert, update on app.ledger_accounts to surge_app;

-- Calendar-month periods, lazily created on first post into a given month.
create table app.accounting_periods (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "periodStart" date not null,
  "periodEnd" date not null,
  "status" text not null default 'open' check ("status" in ('open', 'closing', 'locked')),
  "closedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "periodStart"),
  check ("periodEnd" > "periodStart")
);

create trigger accounting_periods_set_updated_at before update on app.accounting_periods
  for each row execute function app.set_updated_at();

alter table app.accounting_periods enable row level security;
create policy accounting_periods_read on app.accounting_periods for select
  using (app.has_business_permission("businessId", 'accounting.read'));
-- The only direct (non-security-definer) write path to this table is the
-- authenticated close/lock endpoint (accounting.manage). Lazy period
-- creation happens inside post_journal_entry below instead, since that
-- runs from every domain that posts, including anonymous webhook callers
-- (payments captured via Paystack/Flutterwave) with no business
-- permission grant at all - the same gap subscriptions' dunning sweep hit
-- against its own tables.
create policy accounting_periods_manage on app.accounting_periods for update
  using (app.has_business_permission("businessId", 'accounting.manage'))
  with check (app.has_business_permission("businessId", 'accounting.manage'));

grant select, update on app.accounting_periods to surge_app;

-- Immutable once posted - "corrections create reversing journals; posted
-- rows are not edited" (PROPOSED_TABLE_INVENTORY.md section 10). No status
-- column: a journal_entries row is simply posted at insert time forever;
-- a reversal is a distinct new row pointing back via reversalOfId.
create table app.journal_entries (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "entryDate" date not null,
  "description" text not null check (length(trim("description")) between 1 and 500),
  "sourceType" text not null check (length(trim("sourceType")) between 1 and 60),
  "sourceId" text not null,
  "reversalOfId" uuid references app.journal_entries ("id") on delete restrict,
  "createdBy" uuid references auth.user ("id") on delete set null,
  "createdAt" timestamptz not null default now(),
  unique ("id", "businessId")
);
create index journal_entries_business_idx on app.journal_entries ("businessId", "entryDate" desc, "id" desc);
create index journal_entries_source_idx on app.journal_entries ("businessId", "sourceType", "sourceId");

create trigger journal_entries_immutable before update or delete on app.journal_entries
  for each row execute function app.reject_immutable_change();

alter table app.journal_entries enable row level security;
create policy journal_entries_read on app.journal_entries for select
  using (app.has_business_permission("businessId", 'accounting.read'));
-- Insert-only, check(true): posted from inside other domains' own request-
-- scoped transactions (payments, returns, payables, inventory), which
-- already checked their own domain permission before calling in - same
-- append-only-log pattern as audit_events and subscription_dunning_events.
create policy journal_entries_insert on app.journal_entries for insert with check (true);

grant select, insert on app.journal_entries to surge_app;

create table app.journal_lines (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "journalEntryId" uuid not null,
  "ledgerAccountId" uuid not null,
  "direction" text not null check ("direction" in ('debit', 'credit')),
  "amountMinor" bigint not null check ("amountMinor" > 0),
  "assetCode" text not null check ("assetCode" ~ '^[A-Z0-9]{2,12}$'),
  "createdAt" timestamptz not null default now(),
  foreign key ("journalEntryId", "businessId") references app.journal_entries ("id", "businessId") on delete restrict,
  foreign key ("ledgerAccountId", "businessId") references app.ledger_accounts ("id", "businessId") on delete restrict
);
create index journal_lines_entry_idx on app.journal_lines ("journalEntryId");
create index journal_lines_account_idx on app.journal_lines ("businessId", "ledgerAccountId", "createdAt" desc);

create trigger journal_lines_immutable before update or delete on app.journal_lines
  for each row execute function app.reject_immutable_change();

alter table app.journal_lines enable row level security;
create policy journal_lines_read on app.journal_lines for select
  using (app.has_business_permission("businessId", 'accounting.read'));
create policy journal_lines_insert on app.journal_lines for insert with check (true);

grant select, insert on app.journal_lines to surge_app;

-- The one write path into journal_entries/journal_lines, called by every
-- domain that posts (payments, returns, payables, inventory) through
-- accounting.service.ts's postJournalEntry. Security definer for three
-- reasons at once: (1) some callers are anonymous webhook principals with
-- no business permission grant at all, so a plain insert into these
-- check(true)-gated tables would still need to read ledger_accounts and
-- accounting_periods, both of which ARE permission-gated; (2) an ordinary
-- "insert ... returning" would hit the RETURNING-reselect RLS gotcha this
-- codebase has hit repeatedly elsewhere (journal_entries_read requires
-- accounting.read, which an anonymous caller never has); (3) it keeps the
-- balance check, the account-code lookups, and the period-open check
-- atomic with the writes rather than racing them across separate
-- round-trips. p_lines is a JSON array of {"accountCode","direction",
-- "amountMinor","assetCode"} objects; accounting.service.ts's
-- postJournalEntry already validated the debit/credit balance before
-- calling this, but the check here is what's actually load-bearing.
create or replace function app.post_journal_entry(
  p_business_id uuid, p_entry_date date, p_description text, p_source_type text, p_source_id text,
  p_reversal_of_id uuid, p_created_by uuid, p_lines jsonb
)
returns uuid
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_period_start date := date_trunc('month', p_entry_date)::date;
  v_period_end date := (date_trunc('month', p_entry_date) + interval '1 month')::date;
  v_period_status text;
  v_entry_id uuid;
  v_line jsonb;
  v_account_id uuid;
  v_balance jsonb := '{}'::jsonb;
  v_asset text;
  v_signed bigint;
begin
  insert into app.accounting_periods ("businessId", "periodStart", "periodEnd")
    values (p_business_id, v_period_start, v_period_end)
    on conflict ("businessId", "periodStart") do nothing;

  select period."status" into v_period_status from app.accounting_periods period
    where period."businessId" = p_business_id and period."periodStart" = v_period_start;

  if v_period_status <> 'open' then
    raise exception using errcode = 'P0001', message = format('The accounting period covering %s is %s and cannot accept new postings', p_entry_date, v_period_status);
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_asset := v_line ->> 'assetCode';
    v_signed := (v_line ->> 'amountMinor')::bigint * (case when v_line ->> 'direction' = 'debit' then 1 else -1 end);
    v_balance := jsonb_set(v_balance, array[v_asset], to_jsonb(coalesce((v_balance ->> v_asset)::bigint, 0) + v_signed));
  end loop;
  if exists (select 1 from jsonb_each_text(v_balance) balance where balance.value::bigint <> 0) then
    raise exception using errcode = 'P0001', message = format('Journal entry for %s:%s does not balance', p_source_type, p_source_id);
  end if;

  insert into app.journal_entries ("businessId", "entryDate", "description", "sourceType", "sourceId", "reversalOfId", "createdBy")
    values (p_business_id, p_entry_date, p_description, p_source_type, p_source_id, p_reversal_of_id, p_created_by)
    returning "id" into v_entry_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select account."id" into v_account_id from app.ledger_accounts account
      where account."businessId" = p_business_id and account."code" = (v_line ->> 'accountCode');
    if v_account_id is null then
      raise exception using errcode = 'P0001', message = format('Unknown ledger account "%s" for business %s', v_line ->> 'accountCode', p_business_id);
    end if;
    insert into app.journal_lines ("businessId", "journalEntryId", "ledgerAccountId", "direction", "amountMinor", "assetCode")
      values (p_business_id, v_entry_id, v_account_id, (v_line ->> 'direction'), (v_line ->> 'amountMinor')::bigint, (v_line ->> 'assetCode'));
  end loop;

  return v_entry_id;
end;
$$;

revoke all on function app.post_journal_entry(uuid, date, text, text, text, uuid, uuid, jsonb) from public;
grant execute on function app.post_journal_entry(uuid, date, text, text, text, uuid, uuid, jsonb) to surge_app;

-- Widens capture_checkout_payment_from_webhook's result (originally
-- migration 0037) with the fields provider-events.service.ts now needs to
-- post a journal entry for a webhook-driven capture - amountMinor, method,
-- assetCode, and the order's tax/total for the same proportional tax split
-- payments.service.ts's own (authenticated-path) capture uses. Logic is
-- otherwise unchanged from 0037. Postgres refuses create-or-replace when a
-- table-returning function's column set changes, so the narrower 0037
-- version is dropped first.
drop function if exists app.capture_checkout_payment_from_webhook(text);
create or replace function app.capture_checkout_payment_from_webhook(target_external_reference text)
returns table ("found" boolean, "captured" boolean, "isFullyPaid" boolean, "businessId" uuid, "orderId" uuid, "amountMinor" bigint, "method" text, "assetCode" text, "orderTaxMinor" bigint, "orderTotalMinor" bigint)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_payment_id uuid;
  v_business_id uuid;
  v_order_id uuid;
  v_amount_minor bigint;
  v_status text;
  v_method text;
  v_asset_code text;
  v_total_minor bigint;
  v_tax_minor bigint;
  v_allocated bigint;
  v_next bigint;
  v_is_fully_paid boolean;
begin
  select payment."id", payment."businessId", payment."orderId", payment."amountMinor", payment."status", payment."method", payment."assetCode"
    into v_payment_id, v_business_id, v_order_id, v_amount_minor, v_status, v_method, v_asset_code
    from app.payments payment where payment."externalReference" = target_external_reference for update;

  if not found then
    return query select false, false, false, null::uuid, null::uuid, null::bigint, null::text, null::text, null::bigint, null::bigint;
    return;
  end if;

  select "order"."totalMinor", "order"."taxMinor" into v_total_minor, v_tax_minor from app.orders "order" where "order"."id" = v_order_id and "order"."businessId" = v_business_id for update;

  if v_status <> 'pending' then
    return query select true, false, (v_status = 'captured'), v_business_id, v_order_id, v_amount_minor, v_method, v_asset_code, v_tax_minor, v_total_minor;
    return;
  end if;

  select coalesce(sum(allocation."amountMinor"), 0) into v_allocated
    from app.payment_allocations allocation where allocation."businessId" = v_business_id and allocation."orderId" = v_order_id;

  insert into app.payment_allocations ("businessId", "paymentId", "orderId", "amountMinor")
    values (v_business_id, v_payment_id, v_order_id, v_amount_minor);

  v_next := v_allocated + v_amount_minor;
  v_is_fully_paid := v_next >= v_total_minor;

  update app.orders "order" set "paymentStatus" = case when v_next >= "order"."totalMinor" then 'paid' else 'partially_paid' end
    where "order"."id" = v_order_id and "order"."businessId" = v_business_id;

  update app.payments set "status" = 'captured' where "id" = v_payment_id;

  return query select true, true, v_is_fully_paid, v_business_id, v_order_id, v_amount_minor, v_method, v_asset_code, v_tax_minor, v_total_minor;
end;
$$;

revoke all on function app.capture_checkout_payment_from_webhook(text) from public;
grant execute on function app.capture_checkout_payment_from_webhook(text) to surge_app;

-- The standard chart of accounts itself is seeded per business from
-- application code (accounting.service.ts's seedDefaultChartOfAccounts,
-- called by businesses.service.ts right after create()) rather than here,
-- so accounting stays a normal dependent of businesses instead of
-- businesses reaching into accounting's schema. "payroll" and "cogs" are
-- seeded even though nothing posts to them yet - both are named in
-- PROPOSED_TABLE_INVENTORY.md's chart-of-accounts list, matching this
-- codebase's established "seed the full approved catalog even where
-- nothing enforces/posts to it yet" precedent (subscriptions' entitlement
-- catalog is the same shape of decision).
