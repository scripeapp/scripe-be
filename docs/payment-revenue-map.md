# Hilaq Payment & Revenue Map

> Last updated: 2026-05-20

---

## Overview

Hilaq routes all payments through a provider factory (`PaymentProviderFactory`) that selects **Paystack** for NGN transactions and **Flutterwave** for all other currencies (GHS, KES, ZAR, USD, GBP, TZS, UGX, XAF, XOF, RWF, ZMW).

There are two fee directions in the platform:

| Fee model | Who pays | Rate | Used for |
|---|---|---|---|
| **Gross-up** | Buyer pays fee on top of list price | 1.5% | Commerce (store, bookings, events, forms) |
| **Creator split** | Fee deducted from creator payout; buyer sees list price | 10% total | Content, subscriptions, tipping |

In the **creator split** model, Hilaq guarantees the creator nets exactly **90%** of the listed price:
- **Paystack (NGN):** `transactionCharge = (price × 10%) − paystackFee`. Paystack's own processing fee is absorbed within the 10%, so combined deduction = exactly 10%.
- **Flutterwave:** `flwMerchantAmount = price × 90%` (flat). FLW takes its processing fee from Hilaq's 10% remainder.

---

## Revenue Sources

### Group A — Content & Subscriptions (10% fee, creator nets 90%)

| # | Product | Service / Controller | `transaction_type` | Multi-currency |
|---|---|---|---|---|
| 1 | Course purchase | `courses.controller.ts` | `course_purchase` | ✓ |
| 2 | Cohort enrollment | `circle-cohorts.service.ts` | `cohort_enrollment` | ✓ |
| 3 | Circle plan subscription | `circle-subscription.service.ts` | `circle_plan_subscription` | ✓ |
| 4 | Publication subscription | `publication-subscription.service.ts` | `publication_subscription` | ✓ |
| 5 | Circle membership (legacy one-time) | `circle.service.ts` | `circle_payment` | ✓ |
| 6 | Tipping | `tips.controller.ts` | `tipping` | ✓ |

Fee env vars: `COURSE_SALE_FEE_PERCENT`, `COHORT_ENROLLMENT_FEE_PERCENT`, `CIRCLE_SUBSCRIPTION_FEE_PERCENT`, `PUBLICATION_SUBSCRIPTION_FEE_PERCENT` — all default to `10`.

---

### Group B — Commerce (1.5% fee, buyer absorbs)

| # | Product | Service / Controller | `transaction_type` | Multi-currency |
|---|---|---|---|---|
| 7 | Store product purchase | `store.service.ts` | `store_purchase` | ✓ |
| 8 | Store service booking | `booking.service.ts` | `booking_payment` | ✓ |
| 9 | Event ticket | `events.controller.ts` | `event_ticket` | ✓ |
| 10 | Scheduling / calendar booking | `scheduling.service.ts` | `scheduling_payment` | ✓ |
| 11 | Paid form submission | `form.service.ts` | `form_submission` | ✓ |

Fee calculation: caller calls `provider.calculateFees(baseAmount, currency)` to get `totalToCharge`, then passes that as `amount` to `initializePayment`. The provider does **not** gross up internally.

---

### Group C — Platform Subscription (Hilaq is merchant, no creator split)

| # | Product | Service / Controller | `transaction_type` | Multi-currency |
|---|---|---|---|---|
| 12 | Hilaq business / platform plan | `business-subscription.service.ts` | `business_subscription` | ✗ (NGN only, direct Paystack) |

No subaccount split. All revenue goes to Hilaq's main Paystack account. NGN-only until ported to the factory.

---

## Webhook Dispatch

All successful charges hit `POST /webhook/paystack` or `POST /webhook/flutterwave` and are routed by `handleChargeSuccess` in `webhook.controller.ts` based on `transaction_type` in the payment metadata.

| `transaction_type` | Handler |
|---|---|
| `event_ticket` | `processEventPurchase()` |
| `form_submission` | `processFormSubmission()` |
| `booking_payment` | `processBookingPayment()` |
| `scheduling_payment` | `processSchedulingPayment()` |
| `store_purchase` | `processStorePurchase()` |
| `publication_subscription` | `processPublicationSubscription()` |
| `store_membership` | `processStoreMembershipSubscription()` |
| `course_purchase` | `processCoursePurchase()` |
| `cohort_enrollment` | `processCohortEnrollment()` |
| `circle_plan_subscription` | `processCirclePlanSubscription()` |
| `tipping` | `processTipping()` |
| `business_subscription` | `processBusinessSubscription()` |

---

## Payment Flow (Group A & B)

```
Client → POST /api/<domain>/pay
           │
           ├─ Validate request
           ├─ Fetch business subaccount (paystack_subaccount_code / flw_subaccount_id)
           ├─ Calculate fee (gross-up for Group B; 10% split for Group A)
           ├─ PaymentProviderFactory.getProvider(currency)
           │       ├─ NGN  → PaystackProvider  → Paystack API
           │       └─ else → FlutterwaveProvider → Flutterwave API
           ├─ Store pending record
           └─ Return { authorization_url, reference }

Payment complete → Webhook fires
           │
           ├─ Verify signature (HMAC-SHA512 Paystack / HMAC-SHA256 FLW)
           ├─ Normalise to NormalisedPaymentData
           ├─ handleChargeSuccess(data)
           │       └─ Route by transaction_type → domain handler
           └─ Domain handler updates DB, sends notifications/emails
```

---

## Flutterwave Reference Convention

All Flutterwave payment references are prefixed with `FLW-` (e.g. `FLW-COHORT-1234567890-abc12345`). This prefix is used by `PaymentProviderFactory.getProviderForReference(ref)` to route verification calls to the correct provider without a DB lookup.

---

## Adding a New Revenue Source

1. Add `transaction_type` to `PaymentMetadata` in `src/types/webhook.ts`
2. Implement initiation in the appropriate service using `PaymentProviderFactory.getProvider(currency).initializePayment(...)`
3. Add a detection function (`isXxx`) and handler (`processXxx`) in `webhook.controller.ts`
4. Register the detection in `handleChargeSuccess`
5. Add fee env var (Group A: default `10`; Group B: default `1.5`)
