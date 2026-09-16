# Hilaq API Reference

This document provides a comprehensive reference for the Hilaq Backend API. For interactive documentation, visit `/api/docs` when running the development server.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Common Response Format](#common-response-format)
4. [Error Codes](#error-codes)
5. [API Modules](#api-modules)
   - [Business](#business)
   - [Store](#store)
   - [Session](#session)
   - [Events](#events)
   - [User](#user)
   - [Webhook](#webhook)

---

## Overview

**Base URL**: `https://api.hilaq.com` (Production) | `http://localhost:3000` (Development)

**API Version**: 1.0.0

**Content-Type**: `application/json`

---

## Authentication

The Hilaq API uses **JWT Bearer tokens** for authentication. Include the token in the `Authorization` header:

```http
Authorization: Bearer <your-jwt-token>
```

### Obtaining Tokens

Tokens are obtained through Supabase authentication. The client-side application handles token management.

### Protected Routes

Most API routes require authentication. Unauthenticated requests to protected routes return:

```json
{
  "success": false,
  "message": "Authentication required",
  "statusCode": 401
}
```

---

## Common Response Format

All API responses follow a consistent structure:

### Success Response

```json
{
  "success": true,
  "message": "Operation completed successfully",
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "totalPages": 10
  }
}
```

### Error Response

```json
{
  "success": false,
  "message": "Error description",
  "details": { ... },
  "statusCode": 400
}
```

---

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid input or validation error |
| 401 | Unauthorized - Authentication required or invalid token |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource does not exist |
| 409 | Conflict - Resource already exists (e.g., duplicate slug) |
| 422 | Unprocessable Entity - Validation failed |
| 500 | Internal Server Error - Unexpected server error |

---

## API Modules

### Business

Manage businesses (organizations) within Hilaq.

#### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/business` | ✅ | List user's businesses |
| POST | `/api/business` | ✅ | Create new business |
| GET | `/api/business/has` | ✅ | Check if user has businesses |
| GET | `/api/business/slug/{slug}` | ❌ | Get business by slug (public) |
| GET | `/api/business/{id}` | ✅ | Get business by ID |
| PATCH | `/api/business/{id}` | ✅ | Update business |
| DELETE | `/api/business/{id}` | ✅ | Delete (soft) business |
| GET | `/api/business/categories` | ❌ | List business categories |

#### Create Business

```http
POST /api/business
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "My Islamic Learning Center"
}
```

**Response**:
```json
{
  "success": true,
  "message": "Business created successfully",
  "data": {
    "id": "uuid",
    "name": "My Islamic Learning Center",
    "slug": "my-islamic-learning-center",
    "status": "active",
    "owner_user_id": "user-uuid",
    "created_at": "2025-01-15T00:00:00Z"
  }
}
```

---

### Store

Manage e-commerce stores within businesses.

#### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/store` | ✅ | Get user's store |
| POST | `/api/store` | ✅ | Create/init store |
| PATCH | `/api/store/{id}` | ✅ | Update store settings |
| POST | `/api/store/{id}/publish` | ✅ | Publish/unpublish store |
| GET | `/api/store/s/{slug}` | ❌ | Get public store by slug |
| GET | `/api/store/{id}/products` | ✅ | List products |
| POST | `/api/store/{id}/products` | ✅ | Add product |
| PATCH | `/api/store/{id}/products/{productId}` | ✅ | Update product |
| DELETE | `/api/store/{id}/products/{productId}` | ✅ | Delete product |
| GET | `/api/store/{id}/orders` | ✅ | List orders |
| GET | `/api/store/{id}/analytics` | ✅ | Get store analytics |

#### Store Analytics Response

```json
{
  "success": true,
  "data": {
    "total_revenue": 50000,
    "total_orders": 25,
    "total_customers": 18,
    "total_products": 12
  }
}
```

---

### Session

Manage learning sessions (halqahs, talks, workshops).

#### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/sessions/user` | ✅ | Get user's sessions |
| GET | `/api/sessions/business/{businessId}` | ✅ | Get business sessions |
| GET | `/api/sessions/public` | ❌ | List public sessions |
| GET | `/api/sessions/{id}` | ❌ | Get session details |
| POST | `/api/sessions` | ✅ | Create session |
| PATCH | `/api/sessions/{id}` | ✅ | Update session |
| DELETE | `/api/sessions/{id}` | ✅ | Delete session |
| POST | `/api/sessions/{id}/join` | ✅ | Join session |
| POST | `/api/sessions/{id}/leave` | ✅ | Leave session |
| GET | `/api/sessions/{id}/occurrences` | ❌ | List occurrences |
| POST | `/api/sessions/{id}/occurrences` | ✅ | Create occurrence |

#### Create Session

```http
POST /api/sessions
Content-Type: application/json
Authorization: Bearer <token>

{
  "title": "Weekly Quran Study",
  "description": "Study of Surah Al-Baqarah",
  "business_id": "business-uuid",
  "session_type": "study",
  "visibility": "public",
  "access_type": "free",
  "cadence": "recurring"
}
```

---

### Events

Manage events (conferences, workshops, gatherings).

#### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/events` | ❌ | List all events |
| GET | `/api/events/{id}` | ❌ | Get event details |
| POST | `/api/events` | ✅ | Create event |
| PATCH | `/api/events/{id}` | ✅ | Update event |
| DELETE | `/api/events/{id}` | ✅ | Delete event |
| GET | `/api/events/{id}/questions` | ❌ | List Q&A questions |
| POST | `/api/events/{id}/questions` | ✅ | Ask question |
| POST | `/api/events/{id}/questions/{qId}/answer` | ✅ | Answer question |

---

### User

Manage user preferences and addresses.

#### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/user/preferences` | ✅ | Get preferences |
| PATCH | `/api/user/preferences` | ✅ | Update preferences |
| GET | `/api/user/addresses` | ✅ | List addresses |
| POST | `/api/user/addresses` | ✅ | Add address |
| PATCH | `/api/user/addresses/{id}` | ✅ | Update address |
| DELETE | `/api/user/addresses/{id}` | ✅ | Delete address |
| POST | `/api/user/addresses/{id}/default` | ✅ | Set default address |

#### User Preferences

```json
{
  "last_active_store_id": "store-uuid",
  "last_active_publication_id": "pub-uuid",
  "timezone": "Africa/Lagos",
  "currency": "NGN",
  "locale": "en",
  "theme": "light"
}
```

---

### Webhook

Handle payment webhooks from Paystack.

#### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/webhook/paystack` | ❌* | Paystack payment webhooks |
| POST | `/api/webhook/paystack/free` | ❌ | Free ticket processing |

> *Paystack webhooks use HMAC signature verification instead of JWT auth.

#### Paystack Webhook Events

- `charge.success` - Payment completed
- `subscription.create` - New subscription
- `subscription.not_renew` - Subscription cancelled

---

## Rate Limiting

The API implements rate limiting to ensure fair usage:

- **Standard routes**: 100 requests per minute
- **Authentication routes**: 10 requests per minute
- **Webhook routes**: Unlimited (signature verified)

---

## Pagination

List endpoints support pagination via query parameters:

| Parameter | Default | Max | Description |
|-----------|---------|-----|-------------|
| page | 1 | - | Page number |
| limit | 10 | 100 | Items per page |

**Example**:
```http
GET /api/events?page=2&limit=20
```

**Response Meta**:
```json
{
  "meta": {
    "page": 2,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

---

## Filtering & Sorting

Many list endpoints support filtering:

```http
GET /api/events?status=published&category=workshop
GET /api/sessions/public?session_type=study&access_type=free
GET /api/store/{id}/products?status=published&search=quran
```

---

## Changelog

### Version 1.0.0 (January 2025)
- Initial API release
- Core modules: Business, Store, Session, Events, User
- Payment integration with Paystack
- OpenAPI 3.0 documentation

---

## Support

For API support or to report issues:
- **Email**: support@hilaq.com
- **Documentation**: https://docs.hilaq.com
- **Swagger UI**: `/api/docs` (development only)
