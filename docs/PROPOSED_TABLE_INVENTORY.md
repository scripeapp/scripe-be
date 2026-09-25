# Proposed Table Inventory

This document defines the proposed PostgreSQL table inventory for the new
Scripe backend. It replaces the earlier literal translation of the legacy
schema with a model centered on Scripe's actual product:

> A business runs one or more stores, sells through online and physical
> channels, manages stock and suppliers, receives and spends money through
> business accounts, and can explain every material stock and money movement.

## Status and approval gate

This remains a schema proposal. Before implementation, each table must receive
human approval for its columns, ownership boundary, deletion behavior, RLS
policy, indexes, financial semantics, and concurrency rules.

The legacy schema is requirements evidence only. Its table splits, JSON
shapes, cached counters, provider-specific fields, and historical migrations
are not compatibility requirements.

## Provider roles

Provider names do not define the core schema. They appear only at integration
boundaries:

- **Paystack and Flutterwave** remain online payment gateway providers. They
  process checkout payment attempts and refunds.
- **Brails and Anchor** issue and operate business accounts. They provide
  account identifiers, statement transactions, balances, and outbound transfer
  rails.
- A business may use either Brails or Anchor, or both.
- Provider IDs and statuses live in integration/link tables, never as columns
  on `app.businesses`, `app.orders`, or other core domain tables.

## Core ownership model

```text
auth.user
   │
   └── app.business_memberships ── app.businesses
                                      │
                                      ├── app.stores
                                      │     ├── locations
                                      │     ├── sales channels
                                      │     ├── products and orders
                                      │     └── inventory
                                      │
                                      └── financial accounts
                                            ├── provider transactions
                                            ├── transfers
                                            ├── reconciliation
                                            └── double-entry ledger
```

- `app.businesses` is the tenant boundary.
- A user participates in a business through membership; a user does not own
  store rows directly.
- Business creation also creates one default store in the same database
  transaction.
- The model permits additional stores later without a schema rewrite.
- Major business-owned records carry `business_id` directly. Composite foreign
  keys must prevent records from being connected across tenants.

## Existing migrations to retain or revise

The following tables are already represented by new-backend migrations. Their
presence does not exempt them from the final schema review.

### Better Auth — `auth`

- `auth.user` — Canonical authenticated user identity.
- `auth.session` — Opaque, database-backed login sessions.
- `auth.account` — Password and OAuth provider accounts.
- `auth.verification` — Email verification and password-reset challenges.
- `auth.passkey` — WebAuthn/passkey credentials.

### Existing application foundations — `app`

- `app.user_profiles` — Product profile linked one-to-one to `auth.user`.
- `app.user_addresses` — A user's saved personal addresses.
- `app.support_tickets` — Merchant support cases.
- `app.support_ticket_replies` — Messages and staff replies on support cases.

# Canonical application inventory

## 1. Businesses, access, and compliance

### Tenancy and authorization

- `app.businesses` — Top-level tenant, lifecycle state, display name, default
  currency, timezone, and primary merchant vertical.
- `app.business_legal_profiles` — Registered name, registration number, tax
  details, and legal address separate from store branding.
- `app.business_memberships` — Connects a user to a business and records active,
  invited, suspended, or ended membership state.
- `app.business_invitations` — Expiring team invitations with inviter and
  intended access.
- `app.roles` — System-defined or business-defined role names.
- `app.permissions` — Stable application capabilities such as
  `inventory.adjust` or `transfer.approve`.
- `app.role_permissions` — Permissions granted to a role.
- `app.membership_roles` — Roles assigned to each business membership.
- `app.staff_location_access` — Optional restriction of a member to specific
  stores or locations.
- `app.platform_administrators` — Explicit platform-level administrator status;
  never inferred from a business role or cookie claim.

### KYB and sensitive business identity

- `app.beneficial_owners` — Ultimate beneficial owners and control percentage
  required during KYB.
- `app.compliance_cases` — Scripe-level KYB case and review state, independent
  of any provider's status vocabulary.
- `app.compliance_documents` — Encrypted document metadata, object key, type,
  expiry, and retention state.
- `app.compliance_submissions` — Attempts to submit a compliance case to Brails
  or Anchor and the normalized result.
- `app.user_consents` — Versioned terms, privacy, and marketing consent records.
- `app.data_privacy_requests` — NDPR access, export, correction, and deletion
  requests with fulfillment history.

Sensitive KYB fields require restricted grants, encryption or tokenization,
access logging, and explicit retention rules. Integration credentials belong
in a secret manager; tables store only secret references.

## 2. Stores, locations, and selling channels

- `app.stores` — Business-owned selling brand. Exactly one active store is
  marked as the default per business.
- `app.locations` — Physical branch, warehouse, kitchen, pharmacy, or stockroom
  belonging to a store.
- `app.sales_channels` — Storefront, POS, manual invoice, QR, or future channel
  through which an order originates.
- `app.registers` — POS tills assigned to a physical location.
- `app.pos_devices` — Authorized devices and their registration/revocation
  state.
- `app.register_shifts` — Cashier opening, closing, expected cash, and counted
  cash for a register session.
- `app.cash_movements` — Float, cash-in, cash-out, safe drop, and adjustment
  events during a register shift.

Online and physical sales use the same product and order model. Channel and
location identify where the sale happened; they do not create separate order
tables.

A partial unique index permits at most one active default store per business.
The business-creation transaction and its integration tests guarantee that at
least one default store exists; the database must never temporarily commit a
business without its initial store.

## 3. Parties, customers, suppliers, and employees

- `app.parties` — A business-scoped person or organization known to the
  merchant.
- `app.party_contacts` — Email addresses and phone numbers belonging to a
  party.
- `app.party_addresses` — Billing, shipping, supplier, or employee addresses.
- `app.customer_accounts` — Customer-specific attributes attached to a party,
  including acquisition channel and lifecycle state.
- `app.supplier_accounts` — Supplier-specific terms, code, tax details, and
  lifecycle state attached to a party.
- `app.employees` — Minimal employment and salary-payment profile attached to a
  party; this is not intended to become a full HR system.

One party may have more than one role. A supplier that also buys from the
merchant should not be duplicated as unrelated supplier and customer rows.

## 4. Products, pricing, and tax

- `app.categories` — Business-owned hierarchical product classification.
- `app.products` — Sellable product, service, menu item, or pharmacy item with
  shared presentation and lifecycle fields.
- `app.product_variants` — Sellable SKU-level options such as pack size, color,
  dosage, or unit size. Every product has at least one variant; Scripe creates a
  hidden default variant when the merchant does not configure options.
- `app.product_categories` — Many-to-many product/category membership.
- `app.product_barcodes` — Barcode or alternate identifier mapped to a product
  variant with business-scoped uniqueness.
- `app.units` — Standard unit definitions such as each, kilogram, litre, pack,
  or tablet.
- `app.unit_conversions` — Valid conversion factors between units for a
  business or product context.
- `app.product_prices` — Authoritative absolute selling price for a product
  variant and asset, optionally scoped to a location. A null `location_id` is
  the store-wide default; a location-specific row overrides it.
- `app.product_location_settings` — Sparse location-specific product
  availability and lead-time override. No row means available and inherit the
  product default.
- `app.tax_rates` — Business tax configuration with effective dates.
- `app.modifier_groups` — Restaurant/customization group attached to applicable
  products.
- `app.modifier_options` — Normalized selectable options and price adjustments.
- `app.product_modifier_groups` — Product-to-modifier-group assignment and
  selection rules.

Images and documents reference `app.uploads`; provider URLs and arrays of image
metadata do not live directly on products.

`app.products` and `app.product_variants` do not contain selling-price columns.
Fixed prices live only in `app.product_prices`; resolved prices are copied into
`app.order_lines` when an order is created. The unique price grain is
`(product_variant_id, location_id, asset_id)` using `UNIQUE NULLS NOT DISTINCT`
so each variant has at most one store-default price and one price per
location/asset.

Price resolution is deterministic: use the requested location's price when it
exists, otherwise use the null-location store default, and reject the sale when
neither exists. Modifier amounts, discounts, tax, service charges, and delivery
fees are applied afterward and remain separate concerns.

## 5. Inventory, costing, and waste

- `app.inventory_items` — A stocked item independent of whether it is directly
  sellable. Flour can be stocked without being sold as a menu item.
- `app.variant_inventory_components` — Quantity of each inventory item consumed
  by a sold product variant. Retail normally has one component; a restaurant
  item may have several ingredients.
- `app.inventory_locations` — A stock-holding area within a location.
- `app.inventory_lots` — Batch/lot number, manufacture date, expiry date,
  supplier, and recall state. Required for pharmacy and useful for food.
- `app.stock_transactions` — Immutable header describing why stock changed,
  who posted it, and the idempotency key.
- `app.stock_movements` — Immutable quantity and cost movement by inventory
  item, lot, and inventory location.
- `app.stock_balances` — Transactionally maintained, rebuildable projection of
  on-hand and reserved quantity. It is not the authoritative history.
- `app.stock_reservations` — Quantity reserved for checkout, fulfillment, or
  internal work, with expiry and release state.
- `app.stock_counts` — Physical inventory count document and workflow state.
- `app.stock_count_lines` — Expected, counted, and variance quantity per item
  and lot.
- `app.stock_transfers` — Transfer document between inventory locations.
- `app.stock_transfer_lines` — Items, lots, quantities, dispatch, and receipt
  state in a transfer.
- `app.waste_events` — Spoilage, expiry, damage, preparation loss, theft, or
  other write-off reason linked to the resulting stock transaction.
- `app.inventory_cost_layers` — FIFO or weighted-average cost layers used to
  calculate COGS and gross margin.
- `app.reorder_policies` — Reorder point, safety stock, target quantity, lead
  time, and preferred supplier per item/location.

There is no authoritative `stock` column on products or variants. Every change
must be explained by a stock transaction, while `stock_balances` provides fast
availability reads.

## 6. Procurement and accounts payable

- `app.supplier_products` — Supplier-to-inventory-item relationship, including
  supplier SKU, pack size, cost, lead time, minimum order, and preferred state.
- `app.purchase_orders` — Approved order sent to a supplier.
- `app.purchase_order_lines` — Requested item, quantity, price, tax, and
  received quantity.
- `app.goods_receipts` — Receipt of supplier goods at an inventory location.
- `app.goods_receipt_lines` — Accepted/rejected quantity, lot, expiry, and
  actual unit cost; posting creates the corresponding stock transaction.
- `app.bills` — Supplier, utility, tax, rent, or other business payable.
- `app.bill_lines` — Itemized amount, tax, account category, and optional
  purchase/receipt relationship.
- `app.bill_payment_allocations` — Allocates a transfer to one or more bills and
  supports partial payment.

Supplier and utility obligations share the same payable lifecycle. Bill type
and line categorization capture their differences without parallel payment
systems.

## 7. Carts, orders, discounts, and returns

- `app.carts` — Active or converted cart scoped to a store, channel, and
  optional customer.
- `app.cart_lines` — Product variant, quantity, selected modifiers, and current
  quote reference before checkout.
- `app.cart_line_modifiers` — Normalized modifier selections attached to a cart
  line before conversion into immutable order-line modifiers.
- `app.checkout_sessions` — Expiring checkout price, stock-reservation, customer,
  and delivery snapshot used to create an order idempotently.
- `app.orders` — Channel-neutral sale header with independent order, payment,
  fulfillment, and reconciliation states.
- `app.order_addresses` — Immutable billing, delivery, or pickup-contact
  snapshots used by an order.
- `app.order_lines` — Immutable SKU, description, quantity, unit price,
  discount, tax, cost, and total snapshots.
- `app.order_line_modifiers` — Modifier selections and price snapshots attached
  to order lines.
- `app.discounts` — Promotion definition, eligibility, limits, and effective
  period.
- `app.discount_redemptions` — Discount use by customer/order for atomic limit
  enforcement.
- `app.returns` — Return authorization and receipt state independent of an
  order's status.
- `app.return_lines` — Returned quantity, condition, restock decision, and
  refund relationship.
- `app.fulfillments` — Partial or complete allocation of order lines for pickup,
  shipping, or delivery.
- `app.deliveries` — Carrier/provider, quote, tracking, address snapshot, and
  delivery lifecycle.
- `app.delivery_methods` — Store delivery or pickup options.
- `app.delivery_zones` — Geographic coverage, fee, minimum order, and ETA rules.
- `app.fiscal_documents` — Immutable numbered receipt/invoice/credit-note record
  when a durable legal document is required.

Order lines are rows, not JSON. Order, payment, fulfillment, return, and
reconciliation states remain separate.

## 8. Payment gateway processing

- `app.payments` — Provider-neutral payment or tender received for an order,
  including cash, card, bank transfer, or online gateway.
- `app.payment_attempts` — Individual Paystack or Flutterwave initialization,
  authorization, verification, and provider response.
- `app.payment_allocations` — Allocates one or more payments to an order and
  supports split tender.
- `app.refunds` — Merchant refund intent, approval state, amount, and reason.
- `app.refund_attempts` — Individual Paystack/Flutterwave or manual refund
  execution attempts.
- `app.disputes` — Gateway dispute or chargeback and its evidence/resolution
  lifecycle.
- `app.gateway_settlements` — Paystack or Flutterwave settlement batch, gross
  amount, fees, deductions, expected payout, and settlement state.
- `app.gateway_settlement_items` — Payments, refunds, disputes, and fees included
  in a gateway settlement for payout-to-bank reconciliation.

Paystack and Flutterwave appear on attempts and integration records. Core
orders and payments remain provider-neutral so a gateway can be changed or
both gateways can be used.

## 9. Business accounts, transfers, and reconciliation

- `app.integration_connections` — Platform- or business-scoped provider
  connection, capability (`payment_gateway`, `account_issuer`, or another
  integration), environment, state, and secret reference.
- `app.provider_customers` — Maps a Scripe business to a provider's customer/KYB
  identifier and normalized provider onboarding state.
- `app.assets` — NGN, USD, or other supported currency/asset with precision and
  lifecycle state.
- `app.financial_accounts` — Scripe's canonical merchant bank, virtual, wallet,
  cash, clearing, or settlement account.
- `app.provider_account_links` — Brails/Anchor external account ID, provider
  product type, and normalized lifecycle state for a financial account.
- `app.account_identifiers` — Account number, bank code, routing information,
  and effective dates for a financial account.
- `app.financial_account_balance_snapshots` — Provider-observed ledger and
  available balances for monitoring and reconciliation; never accounting truth.
- `app.bank_transactions` — Immutable Brails/Anchor statement transaction,
  provider reference, value date, status, direction, and raw-payload reference.
- `app.beneficiaries` — Verified supplier, employee, owner, or general transfer
  destination, optionally linked to a party.
- `app.transfers` — Provider-neutral outbound money movement requested by a
  merchant workflow.
- `app.transfer_attempts` — Individual Brails/Anchor submission, retry,
  provider reference, fee, and result.
- `app.reconciliation_matches` — Matches an external bank transaction to one or
  more internal journal entries.

A business can use Brails, Anchor, or both. `app.businesses` therefore has no
`brails_customer_id`, `anchor_account_id`, or provider-specific KYC status.
Account identifiers must be masked in routine reads and logs, with unmasked
values encrypted or tokenized and available only to narrowly authorized
workflows.

## 10. Double-entry accounting and profitability

- `app.ledger_accounts` — Business chart of accounts, including cash, bank,
  gateway clearing, revenue, tax, inventory, COGS, payable, payroll, fee, and
  expense accounts.
- `app.journal_entries` — Immutable accounting event with posting and reversal
  state.
- `app.journal_lines` — Debit/credit postings that must balance per journal and
  asset before commit.
- `app.accounting_periods` — Open, closing, or locked reporting periods.
- `app.exchange_rates` — Rate, source, and effective time used for an actual
  conversion or reporting valuation.
- `app.financial_account_daily_balances` — Rebuildable daily projection for
  charts and reporting, never the source of truth.

Domain records such as payments, refunds, goods receipts, bills, transfers,
payroll runs, and waste events reference the journal entry created when they
are posted. Corrections create reversing journals; posted rows are not edited.

For fiat, amounts use integer minor units. If higher-precision assets are later
approved, amounts use integer atomic units whose precision is defined by
`app.assets`. Floating-point money is prohibited.

## 11. Payroll

- `app.payroll_runs` — Salary period, approval state, totals, and posting state.
- `app.payroll_items` — Employee gross amount, deductions, net amount,
  beneficiary, transfer, and result.

Payroll reuses beneficiaries, transfers, approvals, and ledger journals. It
does not need a second payout system.

## 12. Approval workflows

- `app.approval_policies` — Business rule selecting which bills, transfers,
  refunds, stock adjustments, or other actions require approval.
- `app.approval_policy_steps` — Ordered approval stages and threshold rules.
- `app.approval_step_approvers` — Eligible membership or role for each stage.
- `app.approval_requests` — Runtime request containing an immutable policy and
  action summary.
- `app.approval_request_steps` — Runtime state for each required stage.
- `app.approval_decisions` — Append-only approve, reject, cancel, and comment
  history.

The domain object holds a real foreign key to its approval request. Approval
steps, approvers, and decisions are not stored as JSON arrays.

## 13. Notifications, communication, and support

- `app.notification_preferences` — Per-user notification type and channel
  preferences.
- `app.notifications` — In-product notification with read/archive state.
- `app.communication_templates` — Versioned transactional email, SMS, or
  WhatsApp templates.
- `app.communication_messages` — Logical outbound message and business context.
- `app.communication_deliveries` — Per-recipient/provider delivery attempt,
  status, cost, and external reference.
- `app.communication_credit_accounts` — Optional prepaid communication-credit
  balance projection.
- `app.communication_credit_entries` — Immutable communication-credit ledger.
- `app.admin_alerts` — Operational issue requiring platform staff attention.
- `app.system_announcements` — Platform-wide or targeted merchant notices.

Support continues to use the existing `app.support_tickets` and
`app.support_ticket_replies` tables.

Marketing campaigns, audiences, and advanced CRM automation are deferred until
the commerce, inventory, and financial foundations are stable.

## 14. Scripe platform subscriptions

- `app.platform_plans` — Scripe subscription plan, billing interval, currency,
  and lifecycle state.
- `app.platform_plan_entitlements` — Feature and usage entitlement included in a
  platform plan.
- `app.business_subscriptions` — A business's active, trialing, past-due,
  cancelled, or historical Scripe subscription.
- `app.subscription_invoices` — Amount due, tax, discount, billing period, and
  payment state for Scripe's own SaaS billing.
- `app.subscription_payment_attempts` — Paystack or Flutterwave attempt to pay a
  Scripe subscription invoice.
- `app.subscription_dunning_events` — Reminder, retry, grace-period, suspension,
  and recovery history after failed subscription payments.

Platform subscription billing is separate from a merchant's operational
orders, revenue, bank accounts, and accounting ledger. A merchant buying Scripe
software is not a sale made by that merchant's store.

## 15. Uploads and object storage

- `app.uploads` — R2 object key, owner, purpose, MIME type, size, checksum,
  confirmation state, and retention state.
- `app.upload_processing_jobs` — Virus scan, document extraction, video
  processing, or cleanup state for an upload.

Domain tables reference confirmed upload IDs. Provider URLs, public bucket
paths, and unvalidated client-supplied object keys are not persisted as domain
truth.

## 16. Reliability, audit, and fraud controls

- `app.idempotency_keys` — Business-scoped operation key, request fingerprint,
  response reference, and expiry for replay-safe mutations.
- `app.provider_events` — Durable Paystack, Flutterwave, Brails, Anchor, and
  other provider webhook inbox with signature, deduplication, and processing
  state.
- `app.jobs` — Durable asynchronous or scheduled work item.
- `app.job_attempts` — Attempt, lease, retry, result, and failure history for a
  job.
- `app.outbox_events` — Event written in the same transaction as a domain
  mutation and delivered asynchronously.
- `app.audit_events` — Append-only actor, request, action, target, business,
  location, IP, and non-sensitive change summary.
- `app.risk_signals` — Fraud or anomaly signal attached to an order, payment,
  refund, transfer, register shift, user, or stock adjustment.
- `app.risk_cases` — Human review, evidence, assignment, and resolution of
  related risk signals.
- `app.transaction_holds` — Explicit hold/release decision that blocks execution
  without corrupting the underlying payment or transfer lifecycle.

# Tables intentionally not carried forward

The following legacy concepts must not be recreated as authoritative tables:

- `wallet_transactions` — replaced by bank transactions plus double-entry
  journal entries.
- `bookkeeping_transactions` — replaced by double-entry journal entries.
- separate `virtual_accounts` and `settlement_accounts` — represented as types
  of `financial_accounts` with provider links and identifiers.
- `banking_withdrawals` and provider-specific payout tables — represented by
  provider-neutral transfers and transfer attempts.
- `inventory_levels`, product stock, variant stock, and branch override stock as
  competing sources — replaced by stock movements and rebuildable balances.
- JSON order items, modifier options, approval steps, or branch ID arrays —
  replaced by constrained relational rows.
- mutable `financial_snapshots` as accounting truth — replaced by journals and
  rebuildable reporting projections.
- duplicate `customers` and `contacts` — replaced by parties and role-specific
  accounts.
- separate online and POS order tables — replaced by one order model with a
  sales channel.
- events, courses, certificates, learning cohorts, and digital-product
  entitlements unless separately reapproved as a strategic product line.
- publications, posts, social, websites, forms, marketplace ranking, wishlists,
  reviews, NPS, and customer-health scoring in the core rewrite.

# Required database rules

## Tenant integrity

- Major domain tables include `business_id` and use tenant-first indexes such
  as `(business_id, status, created_at)`.
- Composite foreign keys enforce that referenced store, location, account,
  product, and party rows belong to the same business.
- RLS reads transaction-local `app.user_id` and `app.business_id` settings.
- Worker access uses dedicated grants/functions and never impersonates a user.

## Financial integrity

- Posted journals, bank transactions, provider events, stock movements, audit
  events, approval decisions, and communication-credit entries are append-only.
- Corrections use explicit reversal records.
- Every posted journal balances per asset in the same transaction.
- No balance is calculated from an unverified webhook or mutable cached total.
- Financial and stock mutations record actor, request ID, and idempotency key.
- Order, payment, fulfillment, return, transfer, approval, and reconciliation
  states remain independent.
- Financial records use `ON DELETE RESTRICT` or archival behavior, not cascading
  deletion through a business, store, user, supplier, or customer.

## Indexing and identifiers

- Every operational foreign key used in joins receives an index.
- External provider references are unique within their provider connection.
- Webhook event IDs are unique within provider and environment.
- Human-readable order, bill, receipt, transfer, and purchase-order numbers are
  unique within the appropriate business/store series, not globally.
- High-volume timelines use indexes beginning with `business_id` followed by
  status or account and descending creation/value time.
- Partial indexes cover actionable states such as pending approvals, open jobs,
  active reservations, unpaid bills, and unreconciled transactions.

## Time, money, and JSON

- External and business-event timestamps use `timestamptz`; business-local
  calendar dates remain `date` where appropriate.
- Money and quantities never use floating point.
- JSONB is limited to opaque provider payloads, low-risk configuration, and
  immutable display snapshots. Data requiring foreign keys, uniqueness,
  filtering, authorization, or concurrent updates uses relational columns.

# Implementation order

1. Auth, user profile, businesses, memberships, roles, compliance foundation,
   and transactional creation of the default store.
2. Locations, channels, parties, products, prices, orders, Paystack/Flutterwave
   payments, and returns.
3. Inventory items, lots, stock ledger, reservations, procurement, bills,
   costing, waste, and reorder policies.
4. Brails/Anchor connections, financial accounts, statement ingestion,
   beneficiaries, transfers, and reconciliation.
5. Double-entry ledger, automated posting rules, accounting periods, and
   profitability read models.
6. Payroll, approvals, fraud controls, notifications, and communication.
7. Deferred CRM or other expansion modules only after the core is stable.

The schema is successful when Scripe can reliably answer five questions for a
merchant:

1. What was sold?
2. What stock changed, where, and why?
3. Where did the money arrive?
4. Where was the money spent?
5. What profit remained after product cost, waste, fees, refunds, payroll, and
   operating expenses?
