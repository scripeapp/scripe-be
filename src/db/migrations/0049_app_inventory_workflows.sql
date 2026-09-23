-- Inventory workflows: makes inventory items idempotently derivable from a
-- product variant (products.repository will upsert one whenever a trackable
-- variant is created), and adds the two stateful document workflows the
-- frontend's stock-transfer and stock-count flows need — raw movements alone
-- don't capture in-transit transfers or a count's review-before-apply step.

create unique index inventory_items_business_variant_idx
  on app.inventory_items ("businessId", "variantId")
  where "variantId" is not null;

-- A branch should have exactly one inventory-tracking wrapper row, not one
-- per name it's ever been created under — the transfer/count workflows'
-- "ensure a wrapper exists for this branch" call needs to be truly
-- idempotent regardless of the name passed, which the original
-- (businessId, locationId, name) uniqueness didn't guarantee.
alter table app.inventory_locations drop constraint "inventory_locations_businessId_locationId_name_key";
alter table app.inventory_locations add constraint inventory_locations_business_location_key unique ("businessId", "locationId");

create table app.stock_transfers (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "reference" text not null,
  "status" text not null default 'draft' check ("status" in ('draft', 'sent', 'received', 'cancelled')),
  "fromInventoryLocationId" uuid not null,
  "toInventoryLocationId" uuid not null,
  "notes" text not null default '',
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "sentAt" timestamptz,
  "receivedAt" timestamptz,
  unique ("id", "businessId"),
  unique ("businessId", "reference"),
  foreign key ("fromInventoryLocationId", "businessId") references app.inventory_locations ("id", "businessId") on delete restrict,
  foreign key ("toInventoryLocationId", "businessId") references app.inventory_locations ("id", "businessId") on delete restrict,
  check ("fromInventoryLocationId" <> "toInventoryLocationId")
);
create index stock_transfers_business_idx on app.stock_transfers ("businessId", "status", "createdAt" desc);

create table app.stock_transfer_lines (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "transferId" uuid not null,
  "inventoryItemId" uuid not null,
  "quantity" numeric(20,6) not null check ("quantity" > 0),
  "quantityReceived" numeric(20,6) not null default 0 check ("quantityReceived" >= 0),
  "unitCostMinor" bigint check ("unitCostMinor" is null or "unitCostMinor" >= 0),
  "createdAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  foreign key ("transferId", "businessId") references app.stock_transfers ("id", "businessId") on delete cascade,
  foreign key ("inventoryItemId", "businessId") references app.inventory_items ("id", "businessId") on delete restrict
);
create index stock_transfer_lines_transfer_idx on app.stock_transfer_lines ("businessId", "transferId");

create table app.stock_counts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "reference" text not null,
  "status" text not null default 'draft' check ("status" in ('draft', 'applied', 'cancelled')),
  "inventoryLocationId" uuid not null,
  "scope" text not null default 'selected' check ("scope" in ('all', 'selected')),
  "countDate" date not null default current_date,
  "notes" text not null default '',
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "appliedAt" timestamptz,
  unique ("id", "businessId"),
  unique ("businessId", "reference"),
  foreign key ("inventoryLocationId", "businessId") references app.inventory_locations ("id", "businessId") on delete restrict
);
create index stock_counts_business_idx on app.stock_counts ("businessId", "status", "createdAt" desc);

create table app.stock_count_lines (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "countId" uuid not null,
  "inventoryItemId" uuid not null,
  -- Snapshotted when the line is added, not computed live at apply time —
  -- a count exists precisely to catch drift between this and what's
  -- physically there, so it must be fixed at count-time, not recomputed
  -- out from under the reviewer.
  "systemQuantity" numeric(20,6) not null,
  "countedQuantity" numeric(20,6) not null,
  "createdAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  unique ("businessId", "countId", "inventoryItemId"),
  foreign key ("countId", "businessId") references app.stock_counts ("id", "businessId") on delete cascade,
  foreign key ("inventoryItemId", "businessId") references app.inventory_items ("id", "businessId") on delete restrict
);
create index stock_count_lines_count_idx on app.stock_count_lines ("businessId", "countId");

create trigger stock_transfers_set_updated_at before update on app.stock_transfers for each row execute function app.set_updated_at();
create trigger stock_counts_set_updated_at before update on app.stock_counts for each row execute function app.set_updated_at();

alter table app.stock_transfers enable row level security;
alter table app.stock_transfer_lines enable row level security;
alter table app.stock_counts enable row level security;
alter table app.stock_count_lines enable row level security;

create policy stock_transfers_read on app.stock_transfers for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy stock_transfers_write on app.stock_transfers for all using (app.has_business_permission("businessId", 'inventory.manage')) with check (app.has_business_permission("businessId", 'inventory.manage'));
create policy stock_transfer_lines_read on app.stock_transfer_lines for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy stock_transfer_lines_write on app.stock_transfer_lines for all using (app.has_business_permission("businessId", 'inventory.manage')) with check (app.has_business_permission("businessId", 'inventory.manage'));
create policy stock_counts_read on app.stock_counts for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy stock_counts_write on app.stock_counts for all using (app.has_business_permission("businessId", 'inventory.manage')) with check (app.has_business_permission("businessId", 'inventory.manage'));
create policy stock_count_lines_read on app.stock_count_lines for select using (app.has_business_permission("businessId", 'inventory.read'));
create policy stock_count_lines_write on app.stock_count_lines for all using (app.has_business_permission("businessId", 'inventory.manage')) with check (app.has_business_permission("businessId", 'inventory.manage'));

grant select, insert, update, delete on app.stock_transfers, app.stock_transfer_lines, app.stock_counts, app.stock_count_lines to surge_app;
