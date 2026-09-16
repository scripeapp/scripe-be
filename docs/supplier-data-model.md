# Supplier / Vendor — Product & Architecture Proposal (v3)

**Audience:** Product, engineering, and stakeholders
**Status:** Proposal — grounded in the current Hilaq implementation, revised after two review passes
**Created:** 2026-09-05
**Scope:** The full buying lifecycle — from sourcing _anything_ a business buys (sellable stock, raw materials, office supplies, pure expenses), through receiving and inventory impact, to billing and payment.

**What changed in this pass:** closed two implementation blockers found in review — a reconciliation rule that depended on a `supplier_payments.status` column that didn't exist anywhere in the schema, and a preferred-supplier uniqueness index that would silently fail to enforce itself for base-price (NULL-variant) rows. Also resolved the `stock_receipt_id` header-shortcut ambiguity, and added RLS, concurrency, and rejection-reason gaps that were missing from the plan rather than wrong in it.

---

## Executive Summary

Hilaq already ships useful supplier building blocks: a rich supplier profile, product-to-supplier attribution, bills with line items, and recorded payments. But three structural gaps keep the feature from being trustworthy for real merchants:

1. **A product is limited to one supplier** (`products.supplier_id` is a single foreign key). Real merchants buy the same item from multiple sources, compare prices, and switch.
2. **Receiving stock is a bare inventory movement, not an auditable receiving document.** No supplier is attributed to the ledger, no per-line unit cost or batch/expiry is persisted, and there is no goods-received record to reconcile against a bill.
3. **Any linked payment marks a bill fully paid** — even a partial one. Outstanding payables are therefore overstated and partial payments cannot be tracked.

This proposal addresses all three while phasing complexity so a single shop can keep a 30-second intake flow and a pharmacy or multi-branch retailer can go deep.

### At a glance — what exists, what changes, and why

| Area                 | What exists today                                             | What should change                                                             | Why                                                                             |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Supplier profile** | `suppliers` table, full CRUD, Vendors UI                      | Near-total keep                                                                | The source of "who we buy from"                                                 |
| **Product sourcing** | `products.supplier_id` (single nullable FK)                   | Replace with `supplier_products` bridge; backfill, flip reads, then drop the column — "primary" = `is_preferred` | Merchants buy the same item from several sources and compare, with one source of truth |
| **Receive stock**    | Generic `restock` movement via `/store/inventory/update`      | `stock_receipts` + `stock_receipt_lines`; attribute supplier/branch/cost/batch | Intake must be an auditable, reconcilable document                              |
| **Inventory ledger** | `stock_movements` (branch, `effective_at`, wide `reason` set) | Add `supplier_id`, `unit_cost`, `batch_number`, `expiry_date`                  | Provenance, valuation, traceability                                             |
| **Bills**            | `supplier_bills` + `supplier_bill_items`                      | Add `paid_amount`, widen status for `partially_paid`, link receipt lines       | Partials, honest balances, three-way match                                      |
| **Payments**         | `supplier_payments` recorded, **no status column**            | Add `status`; reconcile against bill instead of forcing `paid`                 | A partial payment must not close a bill; reconciliation needs a state to act on |
| **Payables**         | `outstanding_payable` = full sum of non-`paid` bills          | Compute `amount − paid_amount` at query time                                   | Numbers merchants trust                                                         |
| **Purchase orders**  | —                                                             | New (phase 2)                                                                  | Procurement for larger merchants                                                |
| **Procurable items** | Sellable `products` only                                      | Allow non-sellable `products` (`is_sellable = false`) + free-text bill lines   | Restaurants/offices buy things they don't sell (tomatoes, chairs)               |

---

## Guiding Model

> **Products are sellable items. Vendors are supply sources. Inventory movements are operational truth. Bills and payments are financial truth. Purchase orders/receipts connect the two.**

A product should never be permanently locked to one supplier. The relationship is many-to-many, mediated by a bridge table (`supplier_products`). This reflects reality: a restaurant buys tomatoes from multiple farms, a pharmacy sources paracetamol from three distributors, and retail shops switch suppliers based on price and availability.

---

## Reframing: This Is Purchase-to-Pay, Not an Inventory Add-On

Looking at the full loop, these entities are **not** an inventory feature wearing a supplier costume. They are a **purchase-to-pay (P2P) procurement pipeline**:

```
Vendor → (optional Purchase Order) → Receipt / Goods Received Note → Bill → Payment
```

Vendor, PO, receipt, bill, and payment are **sourcing and accounts objects**. Inventory is one _optional side effect_ of a receipt: pieces of stock are only created when a receipt line resolves to a tracked item. That distinction — not the inventory ledger — is the true purpose of this feature.

### Why this matters

A restaurant that buys tomatoes, a pharmacy that buys paracetamol, and an office that buys printer paper and a dozen chairs are all doing the _same_ thing: procuring from a supplier and paying for it. The only difference is what happens to the item afterward. Forcing everything through a **sellable** `products` row makes tomatoes unrepresentable (they're not sold) while making one-off expenses (chairs) require pretend catalog entries.

### The item-kind spectrum

| Kind                     | Examples                                    | Tracked as stock?              | Way it appears                                                          |
| ------------------------ | ------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| **Sellable**             | Retail goods, medicine, courses             | Yes — valuation, batch, expiry | `products` row with `is_sellable = true`                                |
| **Tracked non-sellable** | Tomatoes, printer paper, cleaning supplies  | Yes — COGS, count, batch       | `products` row with `is_sellable = false` (any existing `type` is fine) |
| **Expense-only**         | Office chairs, a contractor, a one-off tool | No — no stock doc needed       | Free-text line on `supplier_bill_items` only                            |

### The approach

1. **Keep the sellable catalog as `products`.**
2. **Tracked non-sellable items are also `products` rows**, gated by a single **`is_sellable BOOLEAN NOT NULL DEFAULT true`** column as the one source of truth. Do **not** add `raw_material`/`consumable` values to the `type` enum — keep `type` as the sellable taxonomy (checkout/fulfillment branches on it) and let `is_sellable` be the sellability guard. This reuses _everything_ the inventory engine already does — `stock_movements`, `branch_inventory_overrides`, transfers, counts, batch/expiry, receipts — because they all key on `products`. A tomato is tracked exactly like a t-shirt, minus the storefront.
   - Force `storefront_enabled`, `pos_enabled`, `marketplace_enabled` off for these rows, and exclude them from storefront, catalog facets, search, and checkout.
   - **Audit every other surface that assumes `products` = revenue-generating catalog:** billing/product-count quotas, "top sellers" analytics, reorder-suggestion logic, search indexing, and exports/reports. Default to excluding non-sellable items everywhere.
3. **Expense-only purchases never become a product.** They are recorded as a free-text line on the bill — `supplier_bill_items` already stores `description + quantity + unit_price`, no product requirement.
4. **Keep procurement documents item-agnostic.** PO and receipt lines reference a `product_id` _or_ carry free-text `description` when no product exists. Stock movements are created **only** when the line resolves to a tracked item; otherwise the receipt/bill is a pure procurement + expense record.

### Why not a separate `inventory_items` table

The tempting "cleaner" design — a second table for non-sellable items with polymorphic `item_type` + `item_id` references on every movement — is the wrong trade:

- `stock_movements`, `branch_inventory_overrides`, `decrement_product_stock` (the RPC), transfers, and counts all key on `product_id` / `variant_id`. Polymorphic refs would touch every one of them.
- Reporting and RLS joins get messier for zero capability gain — a flagged `products` row gets identical behaviour.
- The later need — **recipes / BOM** linking tomatoes to the menu items that consume them (true cost-of-goods) — is trivial when both sides are `products` rows and harder across two tables.

### Net effect per business

| Business    | What procurement now covers                                                                   |
| ----------- | --------------------------------------------------------------------------------------------- |
| Restaurant  | Track tomatoes as non-sellable items, count and value them, later link to menu items for COGS |
| Office      | Count printer paper if desired; just bill the chairs                                          |
| Pharmacy    | Medicine as sellable items with batch/expiry; supplies as non-sellable or bill-only           |
| Retail shop | Sellable stock + operating consumables, all from the same suppliers and bills                 |

---

## Entity Overview

| Entity                                  | Purpose                                                 | Status in Hilaq today                                                                      |
| --------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Vendor / Supplier**                   | Who we buy from                                         | ✅ Exists (`suppliers`)                                                                    |
| **Product / Item**                      | What we sell **or** track (incl. non-sellable items)    | ✅ Exists, but sellable-only + single-supplier                                             |
| **Supplier Product**                    | What a specific supplier can provide, and on what terms | ❌ Missing — needs `supplier_products`                                                     |
| **Purchase Order**                      | Intent to buy                                           | ❌ Missing — optional phase 2                                                              |
| **Stock Receipt / Goods Received Note** | What actually arrived                                   | ❌ Missing — intake today is a raw `restock` movement                                      |
| **Inventory Movement**                  | Source of truth for stock changes                       | ✅ Exists, but lacks supplier/cost/batch attribution                                       |
| **Stock Transfer**                      | Branch-to-branch stock move (two-sided, auditable)      | ✅ Exists (`stock_transfers` + `stock_transfer_lines`); lacks batch/expiry and cost-copy on receive |
| **Supplier Bill**                       | Financial obligation to the supplier                    | ✅ Exists (`supplier_bills` + `supplier_bill_items`)                                       |
| **Supplier Payment**                    | Money leaving the business                              | ✅ Exists (`supplier_payments`), but has no `status` column and partials aren't reconciled |

---

## 1. Vendor / Supplier

A supplier is an organization or person the merchant buys from. **This exists today** as the `suppliers` table (`20260827_products_v2_metadata.sql`), with full CRUD in `StoreService`, routes under `/store/suppliers`, React Query hooks, and a complete Vendors UI (`VendorsManager`, `VendorsList`, `VendorModal`, `VendorDetailView`).

### Current Fields (verified — matches `suppliers` table)

| Column                                               | Type        | Notes                                     |
| ---------------------------------------------------- | ----------- | ----------------------------------------- |
| `id`                                                 | UUID        | Primary key                               |
| `store_id`                                           | UUID        | FK → `stores`                             |
| `name`                                               | TEXT        | NOT NULL, UNIQUE (store_id, name)         |
| `code`                                               | TEXT        | UNIQUE (store_id, code) — shorthand       |
| `contact_person`                                     | TEXT        | Default `''`                              |
| `email`                                              | TEXT        | Default `''`                              |
| `phone`                                              | TEXT        | Default `''`                              |
| `category`                                           | TEXT        | Default `''` — e.g. food, pharma, retail  |
| `address` / `city` / `state` / `country` / `website` | TEXT        | Contact details                           |
| `payment_terms`                                      | TEXT        | Default `'Net 30'`                        |
| `bank_name` / `account_number` / `account_name`      | TEXT        | Bank details for payment reference        |
| `notes`                                              | TEXT        | Free-form                                 |
| `is_active`                                          | BOOLEAN     | Default `true` — **boolean, not an enum** |
| `created_at` / `updated_at`                          | TIMESTAMPTZ |                                           |

RLS is enforced via `is_business_member()`; the deletion flow blocks removal when products reference the supplier (409).

### Gaps & Recommendations

- **`is_active` is a boolean.** If we later want `blocked` as a first-class state, widen to a `status` enum (`active` / `inactive` / `blocked`). Low priority — `is_active` is fine for the simple case.
- **Performance stats are not stored** (intentionally). `total_spend`, `outstanding_payable`, delivery-time, and reliability data must be computed from `supplier_bills`, `supplier_payments`, and (once added) `stock_receipts` / `purchase_orders`. Keep them derived, do not denormalize.
- **`deleteSupplier`** hard-blocks deletion when a product references the supplier; `supplier_bills` guards with `ON DELETE RESTRICT` — but **`supplier_payments.supplier_id` is `ON DELETE CASCADE`** (`20260902_supplier_bill_items_payments.sql:39`). A supplier whose only records are payments — or whose bills were already removed — can be deleted and payment history silently destroyed. **Fix now (data-loss risk): change `supplier_payments.supplier_id` to `ON DELETE RESTRICT`**, matching bills. As receipts are added, keep the same guard so financial history is never destroyed.

---

## 2. Product

A product is what the merchant sells or tracks. The `products` table already carries supplier attribution, but **only a single supplier today**.

### Current Relationship (verified)

`products.supplier_id` — a nullable UUID FK to `suppliers`, `ON DELETE SET NULL` (`20260827_products_v2_metadata.sql`). There is a `products_store_supplier_idx` index and **no bridge table**. The product form (`ProductFormContext`, `BasicsStep`), create/update hooks (`useProductCreate`/`useProductUpdate`), and the product catalog facets all read and write this single column.

### The Problem

A merchant cannot represent "Tomatoes — from Farm A, Farm B, or Farm C." They can only tag a product with one supplier, and the frontend drop-down is a single select. There is no way to compare unit cost, lead time, or last-received date per supplier.

### Recommendation

- **Drop `products.supplier_id` entirely** once `supplier_products` (Section 3) exists. The bridge already answers "who supplies this product," and `supplier_products.is_preferred` already encodes the primary-supplier concept — keeping the column would store the same fact in two places and reintroduce the exact drift this proposal rejects elsewhere. Single source of truth.
- **Backfill then drop:** for every product with a non-null `supplier_id`, insert a `supplier_products` row for that supplier (`is_preferred = true` when the product has exactly one mapping), then drop the column and its `products_store_supplier_idx` index.
- The catalog "filter by supplier" facet, the `ProductsList` filter, and the `ReceiveStockModal` pre-filter (Section 5) switch from the column to a `supplier_products` join. Simple merchants are unaffected: the facet shows their existing sole supplier, and `is_preferred` marks the default.

---

## 3. Supplier Product (Bridge Table)

**Status in Hilaq: does not exist.** This is the single highest-value new table — it unlocks the many-to-many relationship and every "who supplies / who's cheapest / who's reliable" answer below.

### Recommended Table: `supplier_products`

| Column                   | Type        | Notes                                                                                                                                                                  |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | UUID        | Primary key                                                                                                                                                            |
| `store_id`               | UUID        | FK → `stores`                                                                                                                                                          |
| `supplier_id`            | UUID        | FK → `suppliers`                                                                                                                                                       |
| `product_id`             | UUID        | FK → `products`                                                                                                                                                        |
| `variant_id`             | UUID        | FK → `product_variants`, nullable — lets supplier pricing differ per variant (e.g. the Large t-shirt costs differently from the Small); the NULL row is the base price |
| `supplier_sku`           | TEXT        | The supplier's own SKU or product code                                                                                                                                 |
| `supplier_product_name`  | TEXT        | How the supplier names this product                                                                                                                                    |
| `unit_cost`              | NUMERIC     | Default cost from this supplier                                                                                                                                        |
| `minimum_order_quantity` | INTEGER     | Minimum units per order                                                                                                                                                |
| `lead_time_days`         | INTEGER     | Average days from order to delivery                                                                                                                                    |
| `is_preferred`           | BOOLEAN     | Default false — marks the recommended supplier                                                                                                                         |
| `last_purchase_cost`     | NUMERIC     | Cost at most recent purchase                                                                                                                                           |
| `last_received_at`       | TIMESTAMPTZ | When stock was last received from this supplier                                                                                                                        |
| `status`                 | TEXT        | CHECK: `active`, `inactive`                                                                                                                                            |
| `created_at`             | TIMESTAMPTZ |                                                                                                                                                                        |
| `updated_at`             | TIMESTAMPTZ |                                                                                                                                                                        |

### Constraints

- `UNIQUE NULLS NOT DISTINCT (store_id, supplier_id, product_id, variant_id)` — one record per supplier-product-variant pair; the NULL-variant row is the base price and duplicates are prevented. **Requires Postgres 15+.** Hilaq runs on Supabase, which ships PG15+ by default, but this must be confirmed against the actual project's Postgres version before the migration lands — if the project is pinned below PG15, fall back to a `COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)` expression index instead.
- **Preferred-supplier uniqueness, fixed:** a plain partial unique index on `is_preferred` does **not** work here, because Postgres treats `NULL <> NULL` in ordinary unique indexes — two suppliers could both be marked preferred for the same product with `variant_id IS NULL` (the base-price row) and the index would not catch it. Use:
  ```sql
  CREATE UNIQUE INDEX supplier_products_preferred_unique
    ON supplier_products (store_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE is_preferred = true;
  ```
  This guarantees at most one preferred supplier per product/variant grain, including the base-price (NULL-variant) row.

### What This Table Answers

| Question                                  | Query                                                   |
| ----------------------------------------- | ------------------------------------------------------- |
| "Who supplies this product?"              | SELECT from `supplier_products` WHERE `product_id` = ?  |
| "Who is cheapest?"                        | ORDER BY `unit_cost` ASC                                |
| "Who delivered last?"                     | ORDER BY `last_received_at` DESC                        |
| "Which supplier should I reorder from?"   | WHERE `is_preferred` = true                             |
| "What products does this supplier offer?" | SELECT from `supplier_products` WHERE `supplier_id` = ? |

---

## 4. Purchase Order

**Status in Hilaq: does not exist.** A purchase order represents the merchant's intent to buy from a supplier. Optional for small merchants (they can receive stock directly) but essential for multi-location businesses, pharmacies, and restaurants with regular ordering cycles. This is phase 2 — it is **not** a prerequisite for fixing the three priority gaps.

### Table: `purchase_orders`

| Column                   | Type        | Notes                                                                 |
| ------------------------ | ----------- | --------------------------------------------------------------------- |
| `id`                     | UUID        | Primary key                                                           |
| `store_id`               | UUID        | FK → `stores`                                                         |
| `supplier_id`            | UUID        | FK → `suppliers`                                                      |
| `branch_id`              | UUID        | FK → `branches` — destination location                                |
| `status`                 | TEXT        | CHECK: `draft`, `sent`, `partially_received`, `received`, `cancelled` |
| `expected_delivery_date` | DATE        |                                                                       |
| `subtotal`               | NUMERIC     | Sum of line totals                                                    |
| `tax`                    | NUMERIC     |                                                                       |
| `total`                  | NUMERIC     | subtotal + tax                                                        |
| `notes`                  | TEXT        |                                                                       |
| `created_by`             | UUID        | FK → `auth.users`                                                     |
| `created_at`             | TIMESTAMPTZ |                                                                       |
| `updated_at`             | TIMESTAMPTZ |                                                                       |

### Table: `purchase_order_lines`

| Column               | Type    | Notes                             |
| -------------------- | ------- | --------------------------------- |
| `id`                 | UUID    | Primary key                       |
| `purchase_order_id`  | UUID    | FK → `purchase_orders`            |
| `product_id`         | UUID    | FK → `products`                   |
| `variant_id`         | UUID    | FK → `product_variants`, nullable |
| `quantity_ordered`   | INTEGER | NOT NULL                          |
| `expected_unit_cost` | NUMERIC |                                   |
| `tax_rate`           | NUMERIC |                                   |
| `discount`           | NUMERIC |                                   |
| `total`              | NUMERIC |                                   |
| `notes`              | TEXT    |                                   |

### Status Flow

```
draft → sent → partially_received → received
draft → sent → cancelled
```

---

## 5. Stock Receipt / Goods Received Note

**Status in Hilaq: the operational gap.** Today, "receiving stock" is a single `restock` record in a generic `/store/inventory/update` endpoint. There is **no** `stock_receipts` table, the movement does **not** carry a `supplier_id`, and no `unit_cost` or batch/expiry is persisted on the ledger.

### What Receive Stock looks like today (verified)

- Frontend `supplierApi.receiveStock` POSTs to `/store/inventory/update` with `{ product_id, quantity_change, reason: "restock", unit_cost, notes }` and **no supplier reference** (`surge-fe/src/queries/suppliers/api.ts:119`).
- Backend `StoreService.updateInventory` (store.service.ts:7373) inserts into `stock_movements` with `store_id, product_id, variant_id, branch_id, quantity_change, reason, effective_at, notes, created_by` — it drops `unit_cost` and has no `supplier_id` column to write (`stock_movements` has none).
- The `ReceiveStockModal` works only because it restricts the product list to items whose `products.supplier_id` equals the chosen vendor — a workaround for the missing attribution, not a real receive document.

### The Fix — Introduce `stock_receipts` + `stock_receipt_lines`

The recommended model, formalizing what the current modal approximates:

#### Table: `stock_receipts`

| Column                       | Type        | Notes                                         |
| ---------------------------- | ----------- | --------------------------------------------- |
| `id`                         | UUID        | Primary key                                   |
| `store_id`                   | UUID        | FK → `stores`                                 |
| `supplier_id`                | UUID        | FK → `suppliers` — **the missing link today** |
| `branch_id`                  | UUID        | FK → `branches` — where stock was received    |
| `purchase_order_id`          | UUID        | FK → `purchase_orders`, nullable (phase 2)    |
| `status`                     | TEXT        | CHECK: `draft`, `completed`, `cancelled`      |
| `received_at`                | TIMESTAMPTZ |                                               |
| `received_by`                | UUID        | FK → `auth.users`                             |
| `subtotal` / `tax` / `total` | NUMERIC     | Value of the receipt                          |
| `notes`                      | TEXT        |                                               |
| `created_at`                 | TIMESTAMPTZ |                                               |

#### Table: `stock_receipt_lines`

| Column                   | Type    | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | UUID    | Primary key                                                                                                                                                                                                                                                                                                                                                           |
| `stock_receipt_id`       | UUID    | FK → `stock_receipts`                                                                                                                                                                                                                                                                                                                                                 |
| `purchase_order_line_id` | UUID    | FK → `purchase_order_lines`, nullable — **line-level three-way match**; lets one PO line be fulfilled across multiple partial receipts and tells you exactly which PO line each receipt line satisfies                                                                                                                                                                |
| `product_id`             | UUID    | FK → `products`                                                                                                                                                                                                                                                                                                                                                       |
| `variant_id`             | UUID    | FK → `product_variants`, nullable                                                                                                                                                                                                                                                                                                                                     |
| `quantity_received`      | INTEGER | NOT NULL                                                                                                                                                                                                                                                                                                                                                              |
| `quantity_rejected`      | INTEGER | Default 0 — damaged/wrong items                                                                                                                                                                                                                                                                                                                                       |
| `rejection_reason`       | TEXT    | Nullable. CHECK: `damaged`, `wrong_item`, `short_shipped`, `expired_on_arrival`, `other`. Required whenever `quantity_rejected > 0`. Without a reason code, "supplier reliability" scoring (a stated goal of this proposal) can't distinguish a supplier who under-ships from one who ships damaged goods — this column is cheap now and expensive to backfill later. |
| `unit_cost`              | NUMERIC | Actual cost at receipt — the source of the movement's cost                                                                                                                                                                                                                                                                                                            |
| `tax_rate`               | NUMERIC | Default 0 — matches `purchase_order_lines` so receipt → bill generation keeps precision                                                                                                                                                                                                                                                                               |
| `discount`               | NUMERIC | Default 0 — total line discount; also matches PO lines                                                                                                                                                                                                                                                                                                                |
| `batch_number`           | TEXT    | Batch-traceable items                                                                                                                                                                                                                                                                                                                                                 |
| `expiry_date`            | DATE    | Perishable items                                                                                                                                                                                                                                                                                                                                                      |
| `manufacture_date`       | DATE    | Optional                                                                                                                                                                                                                                                                                                                                                              |
| `serial_number`          | TEXT    | Electronics / high-value                                                                                                                                                                                                                                                                                                                                              |
| `notes`                  | TEXT    |                                                                                                                                                                                                                                                                                                                                                                       |

### Why a Document Matters (not just a movement)

- **Auditability / three-way matching:** merchant can compare what was ordered (PO), what arrived (receipt), and what was billed — before paying. This prevents paying for stock never received. Matching is **at the line level**: `stock_receipt_lines.purchase_order_line_id` ties a receipt line to the exact PO line it satisfies, and `supplier_bill_items.stock_receipt_line_id` (Section 7) ties a bill line back to the receipt line — so a PO split across partial receipts, or an invoice consolidating several receipts, stays reconcilable.
- **Partial & rejected handling:** record `quantity_received` vs `quantity_rejected` (with `rejection_reason`) and link a receipt to a PO even when only part of the order arrives.
- **Cost & batch traceability:** the ledger cost and batch/expiry must come from a real document, not be dropped.
- **Multi-branch receiving:** `branch_id` makes it explicit where goods landed.

### How Receipts Update Inventory

Each completed receipt line creates an `inventory_movement` with `reason = 'received'` (Section 6). The receipt is the source; the movement is the ledger entry.

---

## 6. Inventory Movement

Inventory movements remain the source of truth for stock changes. **The table exists today** — but it lacks the columns the supplier flow needs.

### Current Schema (verified)

`stock_movements` currently has: `store_id`, `product_id`, `variant_id`, `branch_id` (added `20260828_branch_inventory_ledger`), `quantity_change INTEGER`, `reason`, `reference_id`, `notes`, `created_by`, `created_at`, and `effective_at` (added `20260902_stock_movements_effective_at`). The `reason` CHECK already accepts `received`, `restock`, `damaged`, `spoilage`, `count`, `transfer_in/out`, etc. (`20260902_stock_movement_reasons`).

**Confirmed missing:** `unit_cost`, `supplier_id`, and batch/expiry metadata. The `restock` intake path (`updateInventory`, store.service.ts:7373) does not persist unit cost even though the frontend sends it.

### Recommended Extensions

| Column                         | Status | Purpose                                                                      |
| ------------------------------ | ------ | ---------------------------------------------------------------------------- |
| `unit_cost`                    | ❌ Add | Cost at time of movement — supports cost history and inventory valuation     |
| `supplier_id`                  | ❌ Add | FK → `suppliers`, nullable — who supplied the stock                          |
| `batch_number` / `expiry_date` | ❌ Add | Traceability for pharmacy/food                                               |
| `reference_type`               | ⚠️ Add | Distinguish `stock_receipt`, `stock_transfer`, etc. alongside `reference_id` |

With these, each receipt line maps to a movement:

```
INSERT INTO stock_movements (
  store_id, branch_id, product_id, variant_id,
  quantity_change = quantity_received,
  reason = 'received',
  reference_id = stock_receipt_id,
  reference_type = 'stock_receipt',
  supplier_id = receipt.supplier_id,
  unit_cost = line.unit_cost,
  batch_number = line.batch_number,
  expiry_date = line.expiry_date,
  effective_at = receipt.received_at
)
```

Rejected quantities (`quantity_rejected`) do **not** generate movements — that stock was never available. The existing `branch_id` and `effective_at` columns already make multi-branch and backdated receiving possible; the receipt document simply becomes the authoritative source.

### Transfers ride the existing `stock_transfers` flow — not a new mechanism

Branch-to-branch stock movement already has a real document: `stock_transfers` + `stock_transfer_lines` (`20260902_stock_transfers.sql`) — two-sided, with a `draft → in_transit → received / partial_received` lifecycle (header + lines first, sending commits the decrements, receiving commits the increments), a store-unique `reference`, and RLS already in place. This proposal does **not** create a parallel transfer mechanism: no new tables, statuses, or flows. It only extends what exists.

The single gap: `stock_transfer_lines` already stores `unit_cost`, but the receiving side does not currently persist cost onto the destination movements, and there is no batch/expiry on transfer lines. So:

- Add nullable `batch_number` / `expiry_date` to `stock_transfer_lines`.
- When the destination movements are written (the existing `receiveStockTransfer` path), **copy** `unit_cost` and `batch_number`/`expiry_date` from the sending movements onto the receiving movements — `transfer_in` must mirror `transfer_out`. Otherwise valuation and traceability silently break the moment stock moves between locations.

### Batch balances and FEFO (honesty about scope)

Batch tags on movements give _traceability_ (which batch produced which movements) but **not** _on-hand per batch_. FEFO sale decrement and expiry alerts need current batch balances. That requires more than tagging:

- Maintain a `stock_batch_balances` view or table — sum `quantity_change` per `product + variant + branch + batch` to get on-hand per batch.
- Extend `decrement_product_stock` (the sale RPC) to accept a batch and decrement the **batch expiring soonest** (FEFO).

This is **phase 2**: the `batch_number`/`expiry_date` columns in this proposal are a partial fix (tagging), not complete traceability. Do not present batch tracking as solved without the balance/FEFO layer.

### Valuation method

`unit_cost` per movement is necessary but not sufficient for a stock value — several movements of the same SKU at different costs require a costing rule. This proposal locks:

- **Moving (weighted) average** cost for ordinary items — recompute on each receipt.
- **Batch cost** for batch-tracked items (`batch balance × batch unit_cost`).

"Current stock value" is therefore computed from movements via the chosen rule, never a single `unit_cost` column.

---

## 7. Supplier Bill

A bill is the financial obligation from the supplier. **This exists today** as `supplier_bills` (`20260827_supplier_bills.sql`) with `supplier_bill_items` (`20260902_supplier_bill_items_payments.sql`), plus `createSupplierBill`, `updateSupplierBillStatus`, `listSupplierBills`, `getSupplierBillItems`, `addSupplierBillItem` in `StoreService` and the `RecordVendorBillModal` UI.

### Current Schema (verified)

| Column           | Type          | Notes                                                           |
| ---------------- | ------------- | --------------------------------------------------------------- |
| `id`             | UUID          | Primary key                                                     |
| `store_id`       | UUID          | FK → `stores`                                                   |
| `supplier_id`    | UUID          | FK → `suppliers`, `ON DELETE RESTRICT`                          |
| `bill_number`    | TEXT          | UNIQUE (store_id, bill_number)                                  |
| `invoice_number` | TEXT          | Supplier's invoice                                              |
| `amount`         | NUMERIC(14,2) | Total, CHECK ≥ 0                                                |
| `currency`       | TEXT          | Default `'NGN'`                                                 |
| `issue_date`     | DATE          |                                                                 |
| `due_date`       | DATE          |                                                                 |
| `status`         | TEXT          | CHECK: `paid` / `pending` / `overdue` — **no `partially_paid`** |
| `items_count`    | INTEGER       | Recomputed as bill items are added                              |
| `notes`          | TEXT          |                                                                 |
| `created_by`     | UUID          | FK → `users`                                                    |

### The Payment-Accuracy Gap (verified)

`createSupplierPayment` (store.service.ts:688–731) inserts a payment and then **unconditionally sets `supplier_bills.status = 'paid'`** whenever `bill_id` is provided — regardless of whether the payment covers the whole amount.

Two consequences:

1. **`outstanding_payable` is wrong.** Both `listSuppliers` (store.service.ts:452) and `getSupplierDashboard` (store.service.ts:548) sum the **full** `amount` of every non-`paid` bill — they never subtract partial payments recorded in `supplier_payments`. A ₦500,000 bill with a ₦400,000 payment still shows ₦500,000 outstanding.
2. **Partial payments cannot be represented.** Pay ₦100k of a ₦900k bill and the bill is instantly "paid."

### Recommended Changes

Add columns to support real reconciliation:

| Column           | Type          | Notes                                          |
| ---------------- | ------------- | ---------------------------------------------- |
| `paid_amount`    | NUMERIC(14,2) | Default 0 — incremented on successful payments |
| `approval_state` | TEXT          | For phase-2 approval workflows                 |

Decisions (resolved, not left open):

- **No stored `balance_due`.** Compute `amount − paid_amount` in the query (`listSuppliers`, `getSupplierDashboard`, bill lists). A maintained column drifts across write paths (bulk updates, manual SQL, future webhooks) — a generated column becomes the fallback only if a hot, indexed path ever needs it.
- **Receipt ↔ bill is linked at the line level**, not the bill header: add nullable `stock_receipt_line_id` to `supplier_bill_items` (and `purchase_order_line_id`). This lets one invoice consolidate several receipts and one receipt split across partial bills.
- **Drop the header-level `stock_receipt_id` shortcut entirely** rather than keep it as an ambiguous "convenience" field. Once a bill can consolidate lines from more than one receipt, a single header FK has no well-defined value — should it point to the first receipt referenced, the most recent, or nothing at all? Rather than leave that guess to whoever implements it, don't add the header column. "Which receipts fed this bill?" is a one-line join against `supplier_bill_items.stock_receipt_line_id → stock_receipt_lines.stock_receipt_id`, and it's always correct, unlike a header field that can drift or be ambiguous by construction.

Widen `status` CHECK to: `draft`, `pending`, `approved`, `partially_paid`, `paid`, `overdue`, `disputed`, `cancelled`.

Update the payment flow (Section 8) so a payment:

1. Inserts into `supplier_payments`.
2. If `status = 'successful'`, increments `supplier_bills.paid_amount`.
3. Sets status: `paid` if `paid_amount >= amount`, else `partially_paid`.
4. Reverts on `reversed`.

And update `outstanding_payable` everywhere to use `amount - paid_amount` instead of full amounts (`balance_due` is computed, not stored).

### Linking to Receipts

Once `stock_receipts` exists, a bill can be **generated from a receipt** (recommended flow) or created manually from an invoice. The link is line-level: `supplier_bill_items.stock_receipt_line_id` ties each billed line to the receipt line it pays for, so three-way matching (order → received → billed) holds even when one invoice consolidates several receipts or one receipt is billed in parts.

---

## 8. Supplier Payment

A payment is money leaving the business to a supplier. **This exists today** as `supplier_payments` (`20260902_supplier_bill_items_payments.sql`), with `createSupplierPayment` and `listSupplierPayments` in `StoreService` and payments surfaced in `VendorDetailView`.

### Current Schema (verified)

| Column                      | Type          | Notes                                       |
| --------------------------- | ------------- | ------------------------------------------- |
| `id`                        | UUID          | Primary key                                 |
| `store_id`                  | UUID          | FK → `stores`                               |
| `supplier_id`               | UUID          | FK → `suppliers`, `ON DELETE CASCADE`       |
| `bill_id`                   | UUID          | FK → `supplier_bills`, `ON DELETE SET NULL` |
| `amount`                    | NUMERIC(12,2) | CHECK > 0                                   |
| `payment_date`              | DATE          | Default `CURRENT_DATE`                      |
| `method`                    | TEXT          | Default `'bank_transfer'` — free text today |
| `reference`                 | TEXT          |                                             |
| `notes`                     | TEXT          |                                             |
| `created_by`                | UUID          | FK → `users`                                |
| `created_at` / `updated_at` | TIMESTAMPTZ   |                                             |

**Gap 1 (blocker, found in review):** `supplier_payments` has **no `status` column at all** today. The recommended reconciliation logic in the previous draft of this proposal ("if `status = 'successful'`, increment `paid_amount`... if reversed, subtract") referenced a field that does not exist in the schema — it cannot be implemented as specified without adding it first. This is now an explicit migration item below, not an assumed dependency.

**Gap 2:** `createSupplierPayment` force-marks the linked bill `paid` (store.service.ts:722–728) and no reconciliation runs against `paid_amount`.

### Recommended Changes

1. **Add `supplier_payments.status`** — `TEXT NOT NULL DEFAULT 'successful'`, CHECK: `pending`, `successful`, `failed`, `reversed`. This is a **prerequisite** for the reconciliation logic below; without it there is nothing for the reconciliation rule to branch on. Existing rows backfill to `successful` (matching current behavior, where every recorded payment is treated as having gone through).
2. **Make `supplier_payments.supplier_id` `ON DELETE RESTRICT`** — it is currently `CASCADE`, so a supplier with payment-only records (or whose bills were deleted first) can be deleted and its payment history destroyed. This is a data-loss fix and should ship before the partial-payment work.
3. **Enforce the partial-payment logic** (replaces the unconditional `status = 'paid'` update), run as a **single database transaction or Postgres function** rather than sequential app-layer calls — a read-modify-write across `supplier_payments` and `supplier_bills` is a race condition under concurrent payments (two staff paying the same bill at once, or a webhook retry) if it isn't atomic:

```
When a payment is recorded against a bill (single transaction, bill row locked FOR UPDATE):
  1. Insert into supplier_payments with its status
  2. If status = 'successful': supplier_bills.paid_amount += payment.amount
  3. If paid_amount >= amount  → status = 'paid'
  4. Else if paid_amount > 0   → status = 'partially_paid'
  5. If an existing payment's status transitions to 'reversed' → subtract its amount and recalculate status
```

4. **Make `method` a constrained enum** (`wallet`, `bank_transfer`, `cash`, `card`, `cheque`) so payment reporting is clean.
5. **Recompute `outstanding_payable`** from `amount - paid_amount` in `listSuppliers` (store.service.ts:452) and `getSupplierDashboard` (store.service.ts:548). Optionally store an `overdue` flip when `due_date < today` and balance > 0.

A bill can have many payments, which enables partial payments, deposits, and payment plans.

---

## 9. Access Control (RLS)

**Status: a gap in the plan, not just the schema.** The existing `suppliers` table has RLS enforced via `is_business_member()`. Every new table introduced by this proposal needs the equivalent policy before it ships — this was previously assumed rather than stated. Required for:

- `supplier_products`
- `stock_receipts` / `stock_receipt_lines`
- `purchase_orders` / `purchase_order_lines` (phase 2)

None of these are optional or "add later" — a table without RLS on a multi-tenant store schema is a cross-tenant data leak, not a missing nice-to-have. This should be its own migration-review checkbox, not bundled silently into each table's creation script.

---

## The Flow

The **bold** steps are what exists today; the framed changes are what this proposal adds or fixes.

```
1. Merchant creates or selects a supplier              ✅ exists
         ↓
2. Merchant links products the supplier can provide   [NEW: supplier_products]
         ↓
3. Merchant creates a purchase order (optional)
   or goes directly to receiving                      [NEW: purchase_orders — phase 2]
         ↓
4. Merchant receives stock → stock_receipt + lines    [NEW: was a bare restock movement]
   (sellable & non-sellable items; expense-only skips
   via bill lines instead)                             [NEW: item-agnostic lines]
         ↓
5. Receipt lines generate inventory_movements — only
   for tracked items — with supplier + unit cost + batch [FIX: ledger attribution]
         ↓
6. Merchant records or generates a supplier_bill      ✅ exists (line-level receipt link = NEW)
         ↓
7. Merchant pays the bill (fully or partially)        ✅ exists, but [FIX: payment status column + partial-payment reconciliation]
         ↓
8. Hilaq tracks vendor spend, outstanding payables,
   cost history, inventory movements                  [FIX: correct outstanding_payable]
```

---

## What This Model Solves

| Capability                  | How                                                                                  | Today                                                        |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Trace product origin        | `stock_movements.supplier_id` + `stock_receipt_lines`                                | ❌ No supplier on ledger                                     |
| Track supplier debt         | `supplier_bills.amount − paid_amount` per supplier (computed)                        | ⚠️ Exists, but wrong without partials                        |
| Prevent overpayment         | Line-level three-way match: PO line → receipt line → bill line                       | ❌ No receipt doc to reconcile                               |
| Track price changes         | `stock_receipt_lines.unit_cost` over time                                            | ❌ Cost dropped on intake                                    |
| Rate supplier reliability   | Delivery time, rejection rate (with reason codes), on-time %                         | ❌ No receipt data to derive from                            |
| Handle partial deliveries   | `purchase_orders` status `partially_received` + receipt `purchase_order_line_id`     | ❌ Phase 2                                                   |
| Handle damaged goods        | `stock_receipt_lines.quantity_rejected` + `rejection_reason`                         | ❌ Not captured                                              |
| Batch & expiry traceability | Movement tags now; **phase 2:** on-hand batch balances + FEFO decrement              | ⚠️ Tagging only — not complete traceability                  |
| Inventory valuation         | Moving-average cost (default) or batch cost, computed from movement history          | ❌ No unit_cost on ledger                                    |
| Multi-branch receiving      | `stock_receipts.branch_id`                                                           | ⚠️ `stock_movements.branch_id` exists, but no receipt record |
| Compare suppliers / reorder | `supplier_products` (cost, lead time, preferred, variant-aware, uniqueness enforced) | ❌ Many-to-one only                                          |
| Simple start, deep controls | UX layers below                                                                      | ✅ Design approach                                           |

### The Three Priority Fixes (end state)

1. **Many-to-many sourcing** — `supplier_products` bridge (backfilled from `products.supplier_id`, then drop the column); "primary" supplier is `is_preferred`.
2. **Auditable stock intake** — `stock_receipts` + `stock_receipt_lines`; movements carry `supplier_id`, `unit_cost`, `batch_number`, `expiry_date`.
3. **Honest money** — `supplier_payments.status` + atomic reconciliation; `supplier_bills.paid_amount` + `partially_paid` status; `outstanding_payable` = `amount − paid_amount`.

---

## UX Phasing

### Phase 1 — The three priority fixes (do now)

- **Receive stock** becomes a real document: select supplier + location, enter product/quantity/cost lines (`ReceiveStockModal` evolution).
- **Product → supplier** becomes multi-select via `supplier_products`; the vendor page pre-filters Receive Stock to that supplier.
- **Bills** track partial payments: "record bill", "pay supplier" updates `paid_amount` and status honestly, backed by an atomic reconciliation transaction.
- **Supplier products** surfaced in the vendor detail view.

### Phase 2 — Advanced Merchants

- Purchase orders (PO → receipt links, partial receipts)
- Batch / expiry tracking inputs on receipt lines, plus on-hand batch balances and FEFO decrement
- Bill approval workflows
- Supplier performance dashboard (reliability, spend, payables) — now meaningfully backed by `rejection_reason` data
- Payment reconciliation reporting
- `status` enum on suppliers (`blocked`) and constrained payment methods

### Business-Specific Defaults

| Business           | Default Experience                                                |
| ------------------ | ----------------------------------------------------------------- |
| Restaurant         | Receive ingredients in 30 seconds. Simple quantity + cost entry.  |
| Pharmacy           | Track batch, expiry, supplier, and invoice for every receipt.     |
| Retail shop        | Compare supplier costs, reorder fast based on preferred supplier. |
| Large commerce org | Approval workflows before bill payment, PO-based procurement.     |

---

## Migration Priority

| #   | Change                                                                                                                                                                          | Type            | Unlocks / Notes                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Fix `supplier_payments.supplier_id` → `ON DELETE RESTRICT`                                                                                                                      | ALTER           | Removes silent payment-history deletion — **data-loss fix, do now**                             |
| 2   | Add `supplier_payments.status` (`pending`/`successful`/`failed`/`reversed`, default `successful`, backfilled)                                                                   | ALTER           | **Prerequisite** for payment reconciliation (#7) — was missing entirely, blocked implementation |
| 3   | `supplier_products` (with `variant_id`, `UNIQUE NULLS NOT DISTINCT` — confirm PG15+ — and the `COALESCE`-based partial index for preferred-supplier uniqueness). **Sequenced drop of `products.supplier_id`:** backfill rows from existing non-null `supplier_id`s (mark `is_preferred` when a product has exactly one), move the write path (product create/update) to the bridge, flip the reads — catalog facet, vendor dashboard, `VendorDetailView`, `ReceiveStockModal` pre-filter — to joins, then drop the column + `products_store_supplier_idx` | NEW → ALTER | Many-to-many, variant-aware sourcing with uniqueness that actually holds, and one source of truth for supplier linkage |
| 4   | `stock_receipts` + `stock_receipt_lines` (incl. `purchase_order_line_id`, line-level tax/discount, `rejection_reason`)                                                          | NEW             | Auditable intake, line-level three-way match, reliability-scoring data                          |
| 5   | Extend `stock_movements`: add `supplier_id`, `unit_cost`, `batch_number`, `expiry_date`, `reference_type`                                                                       | ALTER           | Ledger provenance                                                                               |
| 6   | Add `is_sellable BOOLEAN NOT NULL DEFAULT true` to `products` + audit quotas/analytics/reorder/search/exports                                                                   | ALTER           | Single source of truth for sellability                                                          |
| 7   | Extend `supplier_bills`: add `paid_amount`, widen `status` CHECK, add `supplier_bill_items.stock_receipt_line_id` (no stored `balance_due`, no header-level `stock_receipt_id`) | ALTER           | Partial payments, invoice consolidation, unambiguous receipt linkage                            |
| 8   | Fix `createSupplierPayment` reconciliation as a single transaction/DB function + recompute `outstanding_payable` in `listSuppliers` / `getSupplierDashboard`                    | SERVICE         | Honest payables, race-free under concurrent payments                                            |
| 9   | RLS policies for `supplier_products`, `stock_receipts`, `stock_receipt_lines`                                                                                                   | SECURITY        | Required before any of these tables carry real tenant data — not optional                       |
| 10  | `purchase_orders` + `purchase_order_lines`                                                                                                                                      | NEW (phase 2)   | Procurement workflows, partial receipts                                                         |
| 11  | Extend **existing** `stock_transfer_lines` (add batch/expiry); receiving movements copy cost + batch — no new transfer tables, statuses, or parallel flow                                                                                           | ALTER (phase 2) | Valuation/traceability survive branch moves within the current transfer flow                  |
| 12  | `stock_batch_balances` view + FEFO batch decrement in `decrement_product_stock`                                                                                                 | NEW (phase 2)   | On-hand batch tracking, expiry alerts                                                           |
| 13  | `suppliers.{status}` enum + `supplier_payments.method` enum                                                                                                                     | ALTER (phase 2) | Blocked suppliers, clean reporting                                                              |
| 14  | Materialized summary view for supplier/payable stats when volumes demand                                                                                                        | NEW (later)     | Scaling path for derived stats                                                                  |

Performance stats and supplier dashboards stay **derived** from these tables — never drift-prone maintained columns.

---

## Decisions Locked

| Question                                          | Decision                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sellability: `is_sellable` boolean vs `type` enum | **`is_sellable BOOLEAN NOT NULL DEFAULT true`** on `products` is the single source of truth. `type` remains the sellable taxonomy; no `raw_material`/`consumable` values added.                                                                                   |
| `balance_due` stored vs computed                  | **Computed** in queries as `amount − paid_amount`. No stored column (anti-drift). Generated column only if a hot indexed path needs it.                                                                                                                                                                                                                                                           |
| `products.supplier_id`                            | **Dropped** once `supplier_products` lands — backfill from existing non-null values, flip reads to the bridge, then drop the column + index. "Primary supplier" is derived from `is_preferred`, not a denormalized column. No backward-compat shortcut.                                                                                                                                          |
| `stock_receipt_id` on bill header                 | **Dropped.** Once a bill can consolidate multiple receipts, a single header FK has no unambiguous value. "Which receipts fed this bill" is answered by joining through `supplier_bill_items.stock_receipt_line_id`.                                               |
| Valuation method                                  | **Moving average** default; **batch cost** for batch-tracked items. Costing rule is locked so valuation is deterministic.                                                                                                                                         |
| Currency scope                                    | **NGN-only assumption** for cost history/valuation. Foreign-supplier multi-currency is out of scope and intentionally stated, not omitted.                                                                                                                        |
| Preferred supplier uniqueness                     | Partial unique index on `(store_id, product_id, COALESCE(variant_id, zero-uuid))` where `is_preferred = true` — a plain partial index on `is_preferred` alone does not enforce uniqueness for NULL-variant (base-price) rows, so the `COALESCE` form is required. |
| Payment reconciliation state                      | `supplier_payments.status` added as a prerequisite column (was missing). Reconciliation runs as one transaction with the bill row locked, not sequential app-layer writes, to avoid races under concurrent payments.                                              |
| Batch / FEFO                                      | Tagging on movements ships now; **on-hand batch balances + FEFO decrement are phase 2**, explicitly scoped, not silently claimed solved.                                                                                                                          |
| Rejection detail                                  | `quantity_rejected` gets a `rejection_reason` CHECK column now — needed later for reliability scoring and cheap to add at the same time as the column itself.                                                                                                     |
| Transfers                                         | Extend the **existing** `stock_transfers` flow — add batch/expiry to `stock_transfer_lines` and copy cost + batch onto receiving movements. No new table, status, or parallel mechanism; keep the `draft → in_transit → received / partial_received` lifecycle and current RLS. |
| RLS on new tables                                 | Explicit migration-list item (#9), not assumed. No new table ships without a tenant-isolation policy.                                                                                                                                                             |
| Derived stat scaling                              | Query-time sums now; **materialized view** when live payables slow down. Periodic staleness accepted at that point.                                                                                                                                               |
| Payments deletion safety                          | `supplier_payments.supplier_id` → `ON DELETE RESTRICT` **now** (fixes production data-loss risk).                                                                                                                                                                 |
| PG version dependency                             | `UNIQUE NULLS NOT DISTINCT` requires PG15+. Confirm against the actual project's Postgres version before this migration lands; Supabase typically ships PG15+, but this is stated as an assumption to verify, not a guarantee.                                    |

---

## Is This Ready for Implementation?

Yes, with the two items in Migration Priority #2 and #3's uniqueness fix built _before_ anything downstream depends on them — everything else in the numbered list can proceed in order without further design review. Recommended sequencing for a first PR: items #1–#2 (data-loss fix + missing status column) ship together as a single low-risk migration, since neither touches application logic yet. Items #3–#7 (schema) can follow as one migration set. Item #8 (service-layer reconciliation) should not be written until #2 and #7 are live, since it depends on both. Item #9 (RLS) should be a required checklist item on the same PR as #3–#4, not a follow-up.
