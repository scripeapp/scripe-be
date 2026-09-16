# Store API Updates: Data Retrieval

This document outlines the recent updates to the Store API, specifically regarding data retrieval with pagination, filtering, and search capabilities.

## Overview

New query parameters have been added to listing endpoints to support server-side pagination and filtering. All listing endpoints now return a `PaginatedResult` structure.

### Common Response Structure

```typescript
interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}
```

## Endpoints

### 1. Get Products

**Endpoint:** `GET /api/store/product`

**Query Parameters:**
- `page`: (optional) Page number, defaults to 1.
- `limit`: (optional) Items per page, defaults to 10.
- `status`: (optional) Filter by status: `published` or `draft`.
- `search`: (optional) Search string for product name or description.

**Example:**
```http
GET /api/store/product?page=1&limit=20&status=published&search=shirt
```

### 2. Get Orders

**Endpoint:** `GET /api/store/order`

**Query Parameters:**
- `page`: (optional) Page number, defaults to 1.
- `limit`: (optional) Items per page, defaults to 10.
- `status`: (optional) Filter by status: `paid`, `fulfilled`, `cancelled`, or `refunded`.
- `search`: (optional) Search string for customer name, email, or order ID (payment reference).

**Example:**
```http
GET /api/store/order?page=1&limit=50&status=paid
```

### 3. Get Discounts

**Endpoint:** `GET /api/store/discount`

**Query Parameters:**
- `page`: (optional) Page number, defaults to 1.
- `limit`: (optional) Items per page, defaults to 10.
- `is_active`: (optional) Filter by active status: `true` or `false`.

**Example:**
```http
GET /api/store/discount?page=1&is_active=true
```

## Implementation Notes for Frontend

1.  **Param encoding:** Boolean `is_active` should be passed as string `"true"` or `"false"`.
2.  **Debouncing:** Search inputs should be debounced (e.g., 300-500ms) to avoid excessive API calls.
3.  **Loading state:** UI should show a loading state while fetching new pages or applying filters.
