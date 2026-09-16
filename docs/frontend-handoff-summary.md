# Frontend Handoff: Admin Plan Management & Business Subaccount

**Date:** Jan 18, 2026
**Summary:** This document details the new API endpoints and response formats for Managing Subscription Plans (Admin) and Business Payment Settings (Subaccount).

---

## 🏛 1. Admin Plan Management

Used for the Admin Dashboard to manage global plan limits and features.

### Endpoints

- **`GET /api/admin/plans`**: List all plans (`starter`, `plus`, `pro`) with their full limit objects and feature flags. (**Admin only**)
- **`GET /api/admin/plans/stats`**: Get business distribution counts across plans (e.g. `{"starter": 100, "pro": 5}`).
- **`PUT /api/admin/plans/:id`**: Update plan limits, features, or prices.
  - _Automated Cache Clearing:_ Updating a plan automatically clears the server-side cache so changes apply immediately.

---

## 💳 2. Business Subaccount (Payment Settings)

Used for merchants to configure their bank details and fee options.

### Endpoints

- **`GET /api/business/subaccount?business_id={id}`**:
  - Fetches subaccount details.
  - **New:** Now resolves bank names and account numbers directly from Paystack.
- **`PATCH /api/business/subaccount`**:
  - Update any field: `business_name`, `settlement_bank` (name or code), `account_number`, `paystack_fee_bearer`.
  - **Robustness:** You can now send just one field to update (e.g., just change the `business_name`) without needing to resend bank details.
  - **Bank Resolution:** You can send the bank name (e.g. "Access Bank") and the backend will resolve it to the correct Paystack bank code.

### Public Banks Proxy

- **`GET /api/banks`**:
  - Returns a list of Nigerian banks for user selection.
  - No auth required.

---

## 📊 3. Subscription Usage & Feature Gating

Used for frontend logic to hide/show features or prompt for upgrades.

- **`GET /api/businesses/:businessId/subscription/usage`**:
  - Returns an extended report with `plan`, `resources` (used/limit/available), and `features` (boolean flags).
  - Use these feature flags to dynamically render your UI components.

---

## 🛠 Integration Notes

1. **Fee Bearer:** The `paystack_fee_bearer` can be set to `"subaccount"` (merchant pays fees) or `"customer"` (customer pays fees).
2. **Audit Logging:** All admin plan changes and subaccount creations are automatically logged for security and auditing.
3. **Status Check:** Use `/api/business/check` to determine if a user needs to be redirected to the "Create Business" flow before they can access subaccount or subscription settings.

---

### Links to Detailed Specs:

- [Detailed Admin API Specs](file:///c:/Users/USER/Desktop/hilaq/surge-be/docs/admin-plan-management-api.md)
- [Subscription Usage Spec](file:///c:/Users/USER/Desktop/hilaq/surge-be/docs/backend-subscription-api-response.md)
