# Domain Modules

Each directory is a bounded vertical slice. A completed slice owns its approved
schema, repository, service workflows, HTTP controller, routes, Zod contracts,
domain/API types, and focused tests.

The module shells in this directory intentionally contain no placeholder
endpoints, SQL, or speculative types. Implement a slice only after its product
scope, schema, authorization, transaction, concurrency, and idempotency rules
have been approved.

## Implementation status

Every domain below is an implemented, mounted vertical slice **except**:

- `reconciliation` — **deferred, intentionally an empty shell.** It matches
  external bank-statement transactions (`bank_transactions`) against internal
  journal entries. That substrate does not exist: the shipped `banking` slice
  models a wallet/withdrawals flow, not ingested provider statements, so there
  is no statement to reconcile and no caller. The legacy backend has no
  reconciliation feature either, so this is not a parity requirement. It is
  deferred on the same basis `accounting` deferred `exchange_rates` and
  `financial_account_daily_balances`: zero current caller. Building it now
  would mean inventing a statement-ingestion pipeline with no consumer, which
  the rewrite rules forbid. Add it when a bank-statement source is approved.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `profiles` | User profile. |
| `addresses` | User address. |
| `preferences` | User preference. |
| `helpdesk` | Merchant support ticket. |
| `businesses` | Business tenancy and lifecycle. |
| `authorization` | Membership, invitation, role, permission, and scoped access. |
| `compliance` | Legal identity, KYB, consent, and data privacy. |
| `stores` | Store, location, sales channel, register, device, shift, and cash. |
| `parties` | Customer, supplier, employee, and beneficiary identity. |
| `products` | Product, variant, category, barcode, unit, and modifier. |
| `pricing` | Product price, location availability, lead time, and tax. |
| `inventory` | Stock custody, movement, reservation, count, transfer, cost, waste, and reorder. |
| `procurement` | Supplier sourcing, purchase order, and goods receipt. |
| `payables` | Bill, bill line, and bill payment allocation. |
| `carts` | Cart and checkout session. |
| `orders` | Order and immutable order line. |
| `promotions` | Discount and redemption. |
| `returns` | Return authorization and returned item. |
| `fulfillment` | Order allocation and fulfillment. |
| `delivery` | Delivery method, zone, shipment, and tracking. |
| `receipts` | Fiscal receipt, invoice, and credit note. |
| `payments` | Payment gateway, payment, refund, dispute, and settlement. |
| `banking` | Business account, provider account, identifier, statement, and beneficiary. |
| `transfers` | Outbound money movement and provider execution. |
| `reconciliation` | External bank transaction and internal journal matching. |
| `accounting` | Asset, ledger account, journal, period, rate, and financial reporting. |
| `payroll` | Payroll run and employee payment. |
| `approvals` | Approval policy, request, step, and decision. |
| `notifications` | Notification preference and in-product notification. |
| `communications` | Message template, delivery, and communication credit. |
| `subscriptions` | Scripe plan, entitlement, invoice, payment, and dunning. |
| `uploads` | R2 upload metadata and processing. |
| `provider-events` | Provider webhook ingestion and processing. |
| `jobs` | Background and scheduled work execution. |
| `audit` | Immutable privileged and business action audit. |
| `risk` | Fraud signal, investigation, and transaction hold. |
| `platform` | Platform administration, alert, and announcement. |

## Required dependency direction

```text
routes → controller → service → repository → DatabaseContext
                     ↘ domain types / Zod contracts
```

- Controllers never execute SQL.
- Repositories accept `DatabaseContext`; they never import the global pool.
- Services own workflow and transaction boundaries.
- External providers are adapters under `src/integrations`, not domain
  dependencies embedded in repositories.
- Database row types are generated; API and domain types are explicit mappings.
- Do not register an empty router in `app.ts`.
- Do not add compatibility facades or import from the legacy backend.

## Explicitly excluded for now

Catalogs, events, courses, learning sessions, certificates, broad scheduling,
digital-product entitlements, publications, posts, social features, websites,
forms, marketplace ranking, wishlists, reviews, NPS, and customer-health scoring
are not scaffolded. They require a new product-scope approval before inclusion.

