# Frontend API Documentation: Store & Payment Integration

## Overview

This document details the store checkout, subaccount management, and fee integration endpoints for frontend implementation.

---

## Authentication

All authenticated endpoints require:

```
Authorization: Bearer <access_token>
business_id: <uuid>  // Header for business context
```

---

## 1. Store Checkout

### POST `/api/store/checkout/initiate`

**Auth**: None (Public)

Initiates a payment for store purchase. Paystack generates the reference.

#### Request Body

```json
{
  "store_id": "uuid",
  "customer": {
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "+234801234567", // optional
    "address": "123 Main St" // optional
  },
  "items": [
    {
      "product_id": "uuid",
      "variant_id": "uuid | null", // optional
      "quantity": 2,
      "slot": {
        // required for service products only
        "startTime": "09:00",
        "endTime": "10:00",
        "date": "2026-01-20"
      }
    }
  ],
  "discount_code": "SAVE10", // optional
  "callback_url": "https://...", // optional
  "payment_reference": "custom_ref" // optional - if omitted, Paystack generates
}
```

#### Success Response (200)

```json
{
  "success": true,
  "message": "Checkout initiated successfully",
  "data": {
    "authorization_url": "https://checkout.paystack.com/xxx",
    "reference": "T544111498869692", // Paystack-issued
    "amount": 5000, // Items total (Naira)
    "platform_fee": 75, // 1.5% platform fee
    "paystack_fee": 177.03, // Estimated Paystack fee
    "total_charged": 5252.03 // Final amount customer pays
  }
}
```

#### Error Response (4xx)

```json
{
  "success": false,
  "error": "CHECKOUT_ERROR",
  "message": "Insufficient stock for Product Name"
}
```

---

## 2. Store Subaccount Management

### GET `/api/store/subaccount`

**Auth**: Required | **Permission**: `store.settings.read`

Get store-level Paystack subaccount override settings.

#### Query Parameters

| Param      | Type | Required | Description |
| ---------- | ---- | -------- | ----------- |
| `store_id` | uuid | Yes      | Store ID    |

#### Success Response (200)

```json
{
  "success": true,
  "message": "Store subaccount retrieved successfully",
  "data": {
    "paystack_subaccount_code": "ACCT_xxx" | null,
    "paystack_fee_bearer": "customer" | "subaccount" | null
  }
}
```

---

### PATCH `/api/store/subaccount`

**Auth**: Required | **Permission**: `store.settings.update`

Update store-level Paystack subaccount override (for franchise support).

#### Request Body

```json
{
  "store_id": "uuid",
  "paystack_subaccount_code": "ACCT_xxx", // or null to clear
  "paystack_fee_bearer": "customer" // or "subaccount" or null
}
```

#### Success Response (200)

```json
{
  "success": true,
  "message": "Store subaccount updated successfully",
  "data": null
}
```

---

## 3. Business Subaccount Management

### GET `/api/business/subaccount`

**Auth**: Required | **Permission**: `business.settings.read`

Get business-level Paystack subaccount settings.

#### Query Parameters

| Param         | Type | Required | Description |
| ------------- | ---- | -------- | ----------- |
| `business_id` | uuid | Yes      | Business ID |

#### Success Response (200)

```json
{
  "success": true,
  "data": {
    "paystack_subaccount_code": "ACCT_xxx" | null,
    "paystack_fee_bearer": "customer" | "subaccount" | null
  }
}
```

---

### PATCH `/api/business/subaccount`

**Auth**: Required | **Permission**: `business.settings.update`

Update business-level Paystack subaccount settings.

#### Request Body

```json
{
  "business_id": "uuid",
  "paystack_subaccount_code": "ACCT_xxx",
  "paystack_fee_bearer": "customer"
}
```

---

## 4. Fee Calculation Logic

### Platform Fee

- **Rate**: 1.5% of order total
- **Applied when**: `fee_bearer = "customer"`

### Paystack Fee (Nigeria)

- **Rate**: 1.5% + ₦100 flat
- **Cap**: ₦2,000 max
- **Waiver**: ₦100 flat fee waived for transactions < ₦2,500

### Formula

```
If fee_bearer = "customer":
  platform_fee = order_total × 0.015
  intermediate = order_total + platform_fee
  paystack_fee = min((intermediate + flat) / 0.985 - intermediate, 2000)
  total_charged = intermediate + paystack_fee

If fee_bearer = "subaccount":
  total_charged = order_total (merchant absorbs fees)
```

---

## 5. Subaccount Resolution Priority

During checkout, the system resolves Paystack subaccount in this order:

1. **Store-level** override (`stores.paystack_subaccount_code`)
2. **Business-level** setting (`businesses.paystack_subaccount_code`)
3. **Owner's personal** subaccount (`sub_accounts.paystack_subaccount_code`)

---

## 6. Transaction Identification

Payments are identified by `metadata.transaction_type` in webhooks:

| Type           | Value              |
| -------------- | ------------------ |
| Store Purchase | `"store_purchase"` |
| Event Ticket   | `"event_ticket"`   |
| Subscription   | `"subscription"`   |

---

## Common Error Codes

| Error                | Description                             |
| -------------------- | --------------------------------------- |
| `CHECKOUT_ERROR`     | General checkout failure                |
| `PRODUCT_NOT_FOUND`  | Product ID invalid or not published     |
| `INSUFFICIENT_STOCK` | Not enough stock for requested quantity |
| `SLOT_UNAVAILABLE`   | Service booking slot not available      |
| `INVALID_DISCOUNT`   | Discount code invalid or expired        |
