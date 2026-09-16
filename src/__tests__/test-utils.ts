/**
 * Shared test utilities for surge-be
 * 
 * Provides mock factories, request/response helpers, and common test fixtures
 * for consistent testing across the codebase.
 */

import { Request, Response } from 'express';

// ============================================================================
// SUPABASE MOCK FACTORY
// ============================================================================

/**
 * Creates a mock Supabase client for testing
 * 
 * @example
 * const mockSupabase = createMockSupabaseClient();
 * mockSupabase.from.mockReturnValue({
 *   select: jest.fn().mockReturnThis(),
 *   eq: jest.fn().mockReturnThis(),
 *   single: jest.fn().mockResolvedValue({ data: mockData, error: null })
 * });
 */
export function createMockSupabaseClient() {
  const mockFrom = jest.fn();
  const mockStorage = {
    from: jest.fn().mockReturnValue({
      upload: jest.fn().mockResolvedValue({ data: { path: 'test/path' }, error: null }),
      getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'https://example.com/test.jpg' } }),
      remove: jest.fn().mockResolvedValue({ data: null, error: null }),
    }),
  };

  const mockAuth = {
    getUser: jest.fn().mockResolvedValue({ 
      data: { user: { id: 'test-user-id', email: 'test@example.com' } }, 
      error: null 
    }),
    admin: {
      getUserById: jest.fn().mockResolvedValue({
        data: { user: { id: 'test-user-id', email: 'test@example.com' } },
        error: null
      }),
    },
  };

  const mockRpc = jest.fn().mockResolvedValue({ data: null, error: null });

  return {
    from: mockFrom,
    storage: mockStorage,
    auth: mockAuth,
    rpc: mockRpc,
  };
}

/**
 * Creates a mock query builder chain for Supabase
 * 
 * @param resolvedData - The data to resolve with
 * @param resolvedError - Optional error to resolve with
 */
export function createMockQueryBuilder(resolvedData: any, resolvedError: any = null) {
  const chain: any = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    like: jest.fn().mockReturnThis(),
    ilike: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    contains: jest.fn().mockReturnThis(),
    containedBy: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
    maybeSingle: jest.fn().mockResolvedValue({ data: resolvedData, error: resolvedError }),
    then: jest.fn((resolve) => resolve({ data: resolvedData, error: resolvedError })),
  };

  // Make all methods chainable
  Object.keys(chain).forEach(key => {
    if (key !== 'single' && key !== 'maybeSingle' && key !== 'then') {
      chain[key].mockReturnValue(chain);
    }
  });

  return chain;
}

// ============================================================================
// EXPRESS MOCK FACTORIES
// ============================================================================

/**
 * Creates a mock Express Request object
 */
export function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    get: jest.fn(),
    ...overrides,
  };
}

/**
 * Creates a mock Express Response object with spied methods
 */
export function createMockResponse(): Partial<Response> {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    end: jest.fn(),
  };
  return res;
}

/**
 * Creates a mock authenticated request with Supabase client
 */
export function createAuthenticatedRequest(
  userId: string,
  additionalOverrides: Partial<Request> = {}
): Partial<Request> & { user_id: string; supabase: ReturnType<typeof createMockSupabaseClient> } {
  const mockSupabase = createMockSupabaseClient();
  return {
    ...createMockRequest(additionalOverrides),
    user_id: userId,
    supabase: mockSupabase,
  } as any;
}

// ============================================================================
// TEST DATA FIXTURES
// ============================================================================

export const testFixtures = {
  /**
   * Sample user data
   */
  user: {
    id: 'test-user-id-123',
    email: 'test@example.com',
    full_name: 'Test User',
    phone_number: '+2348012345678',
  },

  /**
   * Sample business data
   */
  business: {
    id: 'test-business-id-123',
    name: 'Test Islamic Academy',
    slug: 'test-islamic-academy',
    description: 'A test business for unit testing',
    logo_url: null,
    type: 'school',
    owner_id: 'test-user-id-123',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },

  /**
   * Sample session data
   */
  session: {
    id: 'test-session-id-123',
    title: 'Tafsir Class',
    description: 'Weekly Quran study',
    visibility: 'public',
    pricing_type: 'free',
    price: null,
    status: 'active',
    business_id: 'test-business-id-123',
    created_by: 'test-user-id-123',
    created_at: new Date().toISOString(),
  },

  /**
   * Sample event data
   */
  event: {
    id: 'test-event-id-123',
    title: 'Quran Competition',
    description: 'Annual recitation competition',
    event_date: '2025-03-15',
    start_time: '10:00',
    end_time: '16:00',
    location: 'Main Hall',
    is_free: true,
    status: 'published',
    business_id: 'test-business-id-123',
  },

  /**
   * Sample address data
   */
  address: {
    id: 'test-address-id-123',
    user_id: 'test-user-id-123',
    label: 'Home',
    full_name: 'Test User',
    phone: '+2348012345678',
    address_line_1: '123 Test Street',
    city: 'Lagos',
    state: 'Lagos',
    country: 'Nigeria',
    is_default: true,
  },

  /**
   * Sample store order data
   */
  storeOrder: {
    id: 'test-order-id-123',
    store_id: 'test-store-id-123',
    customer_name: 'Test Customer',
    customer_email: 'customer@example.com',
    customer_phone: '+2348012345678',
    total_amount: 15000,
    status: 'pending',
    payment_reference: 'TXN-123456',
  },
};

// ============================================================================
// WEBHOOK TEST HELPERS
// ============================================================================

/**
 * Creates a mock Paystack webhook payload
 */
export function createPaystackWebhookPayload(
  event: string,
  overrides: Record<string, any> = {}
) {
  const basePayload = {
    event,
    data: {
      reference: `TXN-${Date.now()}`,
      amount: 500000, // 5000 NGN in kobo
      currency: 'NGN',
      status: 'success',
      customer: {
        email: 'test@example.com',
        customer_code: 'CUS_test123',
      },
      metadata: {},
      ...overrides.data,
    },
  };

  return { ...basePayload, ...overrides };
}

/**
 * Generates a valid Paystack webhook signature for testing
 */
export function generatePaystackSignature(payload: object, secret: string): string {
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return hash;
}

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Asserts that a response is a successful API response
 */
export function expectSuccessResponse(res: any, statusCode = 200) {
  expect(res.status).toHaveBeenCalledWith(statusCode);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      success: true,
    })
  );
}

/**
 * Asserts that a response is an error API response
 */
export function expectErrorResponse(res: any, statusCode: number) {
  expect(res.status).toHaveBeenCalledWith(statusCode);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      success: false,
    })
  );
}

// ============================================================================
// ASYNC TEST HELPERS
// ============================================================================

/**
 * Waits for all pending promises to resolve
 */
export function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Creates a delayed promise for testing async behavior
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
