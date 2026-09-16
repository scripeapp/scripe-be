# Backend Response: Subscription & Gating API Verification

**Date:** 2026-01-17  
**From:** Backend Team  
**Subject:** Re: Confirmation of Subscription Endpoints & Feature Gating API

---

## Summary

All requested endpoints are **implemented and verified**. We have updated the `/usage` endpoint to match your expected response format.

---

## Endpoint Status

| Endpoint                                                    | Status         | Notes                                       |
| ----------------------------------------------------------- | -------------- | ------------------------------------------- |
| `GET /api/businesses/:businessId/subscription`              | ✅ Ready       | Returns subscription details                |
| `GET /api/businesses/:businessId/subscription/usage`        | ✅ **Updated** | Now returns `plan`, `resources`, `features` |
| `POST /api/businesses/:businessId/subscription/initiate`    | ✅ Ready       | Returns Paystack URL                        |
| `POST /api/businesses/:businessId/subscription/cancel`      | ✅ Ready       | Cancels via Paystack                        |
| `POST /api/businesses/:businessId/subscription/change-plan` | ✅ Ready       | Handles upgrade/downgrade                   |
| `GET /api/businesses/:businessId/subscription/invoices`     | ✅ Ready       | Returns payment history                     |

---

## /usage Endpoint - Updated Response Format

**Endpoint:** `GET /api/businesses/:businessId/subscription/usage`

```json
{
  "success": true,
  "data": {
    "plan": "starter" | "plus" | "pro",
    "resources": {
      "publications": { "used": 1, "limit": 3, "available": 2 },
      "products": { "used": 5, "limit": "unlimited", "available": "unlimited" },
      "team_members": { "used": 2, "limit": 10, "available": 8 },
      "website_pages": { "used": 3, "limit": 10, "available": 7 },
      "crm_contacts": { "used": 50, "limit": 1000, "available": 950 },
      "segments": { "used": 1, "limit": 5, "available": 4 },
      "campaigns_per_month": { "used": 0, "limit": 5, "available": 5 },
      "sessions": { "used": 2, "limit": 10, "available": 8 }
    },
    "features": {
      "events": true,
      "store": true,
      "digital_downloads": true,
      "courses": false,
      "memberships": false,
      "services_bookings": true,
      "advanced_page_builder": false,
      "custom_domain": false,
      "custom_roles": false,
      "email_support": true,
      "priority_support": false,
      "advanced_analytics": false
    }
  }
}
```

### Key Changes Made

1. ✅ Added `plan` field at root level
2. ✅ Wrapped resource usage in `resources` object
3. ✅ Added `available` calculation for each resource
4. ✅ Added `features` object with boolean flags

---

## Resource Counting Verification

| Resource              | Counting Logic                                |
| --------------------- | --------------------------------------------- |
| `publications`        | Count of publications where `business_id = ?` |
| `products`            | Count of products in stores owned by business |
| `team_members`        | Count of active memberships for business      |
| `website_pages`       | Count of websites where `business_id = ?`     |
| `crm_contacts`        | Count of unified CRM contacts for business    |
| `segments`            | Count of segments where `business_id = ?`     |
| `campaigns_per_month` | Campaigns created this calendar month         |
| `sessions`            | Count of non-deleted sessions for business    |

---

## Feature Access Matrix

| Feature                 | Starter | Plus | Pro |
| ----------------------- | :-----: | :--: | :-: |
| `events`                |   ✅    |  ✅  | ✅  |
| `store`                 |   ✅    |  ✅  | ✅  |
| `digital_downloads`     |   ✅    |  ✅  | ✅  |
| `courses`               |   ❌    |  ❌  | ✅  |
| `memberships`           |   ❌    |  ❌  | ✅  |
| `services_bookings`     |   ❌    |  ✅  | ✅  |
| `advanced_page_builder` |   ❌    |  ✅  | ✅  |
| `custom_domain`         |   ❌    |  ❌  | ✅  |
| `custom_roles`          |   ❌    |  ❌  | ✅  |
| `email_support`         |   ✅    |  ✅  | ✅  |
| `priority_support`      |   ❌    |  ❌  | ✅  |
| `advanced_analytics`    |   ❌    |  ❌  | ✅  |

> **Note:** Feature flags are loaded from the `plan_limits` database table and cached. Any changes to plan features in the database will require a server restart to take effect (or call to `planLimitsService.clearCache()`).

---

## Missing businessId Handling

**Q: When a user has no business yet, what should these endpoints return?**

**A:**

- These endpoints require `:businessId` in the URL path
- If the business doesn't exist, a 404 error is returned
- For users without a business, the frontend should:
  1. Check for businesses via `GET /api/business/check`
  2. Redirect to business creation flow if none exist
  3. Only call subscription endpoints after business is created

New businesses are automatically assigned `plan: "starter"` with default limits.

---

## Fee Bearer Options

For the store/business subaccount settings, the `paystack_fee_bearer` field accepts:

| Value          | Description                         |
| -------------- | ----------------------------------- |
| `"subaccount"` | Merchant absorbs fees (default)     |
| `"customer"`   | Customer pays fees (added to total) |

---

## Questions?

If you need any further clarification or encounter issues with the response format, please reach out. We can arrange a sync call to debug together.
