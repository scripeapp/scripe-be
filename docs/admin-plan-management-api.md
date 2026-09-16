# Admin API Documentation: Subscription Plan Management

## Overview

These endpoints allow admins to manage the subscription plans (`starter`, `plus`, `pro`) and custom plans. All endpoints require `super_admin` role unless specified otherwise.

---

## Authentication

All endpoints require:

```
Authorization: Bearer <access_token>
```

---

## 1. List All Plans

### GET `/api/admin/plans`

**Auth**: `super_admin`

Retrieves all subscription plans with their full configurations.

#### Success Response (200)

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "plan": "starter",
      "price_monthly": 0,
      "price_yearly": 0,
      "paystack_plan_code": null,
      "limits": {
        "publications": 1,
        "sessions": 3
        // ...
      },
      "features": {
        "courses": false,
        "memberships": false
        // ...
      }
    }
    // ...
  ]
}
```

---

## 2. Get Plan Statistics

### GET `/api/admin/plans/stats`

**Auth**: `support` | `super_admin`

Get a count of how many businesses are subscribed to each plan tier.

#### Success Response (200)

```json
{
  "success": true,
  "data": {
    "starter": 150,
    "plus": 45,
    "pro": 12
  }
}
```

---

## 3. Create / Update Plan

### POST `/api/admin/plans` (Create)

### PUT `/api/admin/plans/:id` (Update)

**Auth**: `super_admin`

Create a new plan or update an existing one. **Updating a plan automatically clears the plan config cache across the system.**

#### Request Body

```json
{
  "plan": "custom_plan", // required for create
  "price_monthly": 500000, // kobo (₦5,000)
  "price_yearly": 5000000, // kobo (₦50,000)
  "paystack_plan_code": "PLN_xxx",
  "limits": {
    "publications": 5,
    "sessions": 20,
    "products": "unlimited"
    // ... all limit keys
  },
  "features": {
    "courses": true,
    "memberships": true
    // ... all feature boolean keys
  }
}
```

---

## 4. Delete Plan

### DELETE `/api/admin/plans/:id`

**Auth**: `super_admin`

Deletes a plan.

> [!WARNING]
> You cannot delete a plan that is currently assigned to one or more businesses. You must migrate users to a different plan first.

---

## 5. Clear Plan Cache

### POST `/api/admin/plans/cache/clear`

**Auth**: `super_admin`

Manually invalidate the server-side cache for plan configurations. Useful if database values were changed manually via Supabase dashboard.

---

## Resource Limit Keys

- `publications`
- `sessions`
- `products`
- `website_pages`
- `crm_contacts`
- `team_members`
- `segments`
- `campaigns_per_month`

## Feature Flag Keys

- `events`
- `store`
- `digital_downloads`
- `courses`
- `memberships`
- `services_bookings`
- `advanced_page_builder`
- `custom_domain`
- `custom_roles`
- `email_support`
- `priority_support`
- `advanced_analytics`
