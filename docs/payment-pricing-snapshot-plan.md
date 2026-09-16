# Payment Pricing Snapshot Plan

## Purpose

Preserve the exact buyer-currency pricing used when a checkout is initialized so that payment fulfillment, admin recovery, reconciliation, receipts, and merchant/customer emails can reproduce the original transaction without depending on current product prices or later exchange rates.

This plan applies equally to Paystack, Flutterwave, and future payment providers.

## Current constraints

- `store_orders` retains its existing NGN accounting fields because analytics, bookkeeping, CRM, and revenue aggregation currently depend on those semantics.
- The provider's verified transaction amount and currency are the authority for what the buyer actually paid.
- `pending_checkouts.metadata` is the provider-neutral location for immutable checkout context, so this work should not require a database migration.
- Product prices may come from an explicit price configured for the buyer's currency or from an NGN-to-target-currency conversion.
- Older pending checkouts do not contain converted line-item prices or historical FX rates.

## Pricing snapshot

Add a versioned pricing snapshot to the pending checkout metadata. The snapshot should contain:

### Checkout totals

- Snapshot version.
- Buyer/charge currency.
- Converted subtotal.
- Converted discount.
- Converted delivery fee.
- Converted tax.
- Converted service charge.
- Final pre-provider-fee total.
- Platform/payment fees included in the provider charge, when applicable.
- Final amount sent to the provider.

### Line items

For every purchased item, preserve:

- Product ID and product name.
- Variant ID and variant name, when applicable.
- Quantity.
- Base NGN unit price.
- Base NGN variant adjustment.
- Converted unit price.
- Converted variant adjustment.
- Converted line total before discount.
- Pricing source: `explicit_currency_price` or `fx_conversion`.
- The exact FX rate used when the base product price required conversion.
- The exact FX rate used for the variant adjustment when it required conversion.

### Other converted components

For delivery, tax, service charges, and any other converted component, preserve:

- Original NGN amount.
- Converted amount.
- Exact FX rate used.
- Target currency.
- Conversion timestamp or rate-source timestamp, when available.
- Rate source/provider identifier, when available.

An explicit product currency price must not be presented as though it was FX-converted. Its pricing source should be recorded, and its FX rate should be absent.

## Implementation plan

1. Define strict TypeScript types for the versioned checkout pricing snapshot and its line-item and conversion records.
2. Refactor currency resolution so it returns both the converted amount and conversion evidence: pricing source, rate, source, and timestamp.
3. Generate the complete pricing snapshot once during checkout initialization.
4. Persist the snapshot inside `pending_checkouts.metadata` before redirecting the buyer to the selected provider.
5. Pass the same immutable snapshot through Paystack and Flutterwave metadata where supported, while treating the pending checkout as the canonical copy.
6. Restore the snapshot during webhook processing regardless of whether provider metadata is complete.
7. Use the snapshot during normal fulfillment, automatic replay, manual admin recovery, and email resend. Do not recalculate new transactions using current prices or current FX rates.
8. Restore the email `Price` column using the snapshotted converted unit price and buyer currency.
9. Continue displaying the currency-aware subtotal, discount, delivery fee, and verified `Amount paid` in merchant and customer emails.
10. Keep the snapshot separate from the NGN accounting fields stored on `store_orders`.

## Reconciliation rules

- Sum the snapshotted line totals to reproduce the converted subtotal.
- Apply the snapshotted discount, delivery, tax, and service charge to reproduce the pre-provider-fee total.
- Apply only known, snapshotted platform/payment fees to reproduce the amount sent to the provider.
- Compare the reconstructed provider amount against the verified provider transaction using smallest currency units and the project's established rounding rules.
- A mismatch must block fulfillment and route the transaction to admin recovery with a detailed breakdown of the difference.
- The provider's verified amount is used for the email's `Amount paid`; it must not be inferred from internal NGN order values.

## Legacy checkout behavior

For pending checkouts created before this snapshot exists:

1. Prefer any existing converted total, converted delivery fee, or explicit currency metadata already stored with the checkout.
2. Use the product's configured currency-aware price when it can be reliably associated with the purchased item.
3. Use the existing proportional discount information to reconstruct subtotal and discount where possible.
4. Use current FX conversion only as a final fallback.
5. Never label a reconstructed/current rate as the exact historical checkout rate when no historical rate was saved.
6. Continue to show the verified provider currency and amount paid even when a complete historical per-item breakdown cannot be proven.

## Email result

Both merchant and customer emails should show:

| Item | Quantity | Price |
| --- | ---: | ---: |
| Product name | 1 | GH₵15.00 |

The totals section should preserve:

- Subtotal in the buyer's currency.
- Discount in the buyer's currency, when present.
- Delivery fee in the buyer's currency, when present.
- Tax/service charges where applicable.
- Verified amount paid in the buyer's currency.

The displayed per-item prices and breakdown must use the checkout snapshot, while `Amount paid` must use the verified provider transaction.

## Test coverage

Add tests for:

- NGN checkout without FX conversion.
- Non-NGN checkout using an explicit product currency price.
- Non-NGN checkout using FX fallback with the exact rate captured.
- Mixed cart containing explicit currency prices and FX-converted products.
- Variant price adjustments.
- Multiple quantities and line-total rounding.
- Fixed and percentage discounts.
- Delivery fees, taxes, and service charges.
- Customer-borne and merchant-borne payment fees.
- Paystack webhook fulfillment and recovery.
- Flutterwave webhook fulfillment and recovery.
- Provider metadata missing while pending-checkout metadata is present.
- Merchant and customer confirmation emails.
- Email resend after product prices or exchange rates have changed.
- Legacy pending checkout without a pricing snapshot.
- Reconciliation mismatch blocking fulfillment.

## Acceptance criteria

- New checkouts can reproduce every displayed buyer-currency line and total from immutable checkout metadata.
- The exact FX rate is recorded whenever a component uses FX conversion.
- Explicit currency-aware prices are distinguished from converted prices.
- Paystack, Flutterwave, and future providers use the same fulfillment and recovery model.
- Merchant and customer emails restore the `Price` column without displaying internal NGN prices for non-NGN transactions.
- Discounts and delivery fees remain visible when present.
- The email's amount paid matches the verified provider amount and currency.
- Existing NGN accounting and downstream reporting remain unchanged.
- Legacy transactions remain recoverable without falsely claiming an unavailable historical rate.

