/**
 * Tests for StoreService
 * 
 * Tests core store operations: store management, products, analytics
 */

import { StoreService } from '../services/store.service';
import { calculateEligibleSubtotal } from '../types/store';
import {
  createMockSupabaseClient,
  createMockQueryBuilder,
  testFixtures,
} from './test-utils';

describe('StoreService', () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let storeService: StoreService;

  const testStore = {
    id: 'store-123',
    user_id: testFixtures.user.id,
    business_id: testFixtures.business.id,
    name: 'Test Store',
    slug: 'test-store',
    is_live: true,
    appearance: { theme: 'light' },
    created_at: new Date().toISOString(),
  };

  const testProduct = {
    id: 'product-123',
    store_id: 'store-123',
    name: 'Test Product',
    price: 5000,
    status: 'published',
    cover_image: null,
    images: [],
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    storeService = new StoreService(mockSupabase as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // getStoreBySlug
  // ==========================================================================
  describe('getStoreBySlug', () => {
    it('should return store when found by slug', async () => {
      const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: testStore, error: null }),
      };
      mockSupabase.from.mockReturnValue(queryBuilder);

      const result = await storeService.getStoreBySlug('test-store');

      expect(mockSupabase.from).toHaveBeenCalledWith('stores');
      expect(queryBuilder.eq).toHaveBeenCalledWith('slug', 'test-store');
      expect(result.slug).toBe('test-store');
    });

    it('should throw 404 when store not found', async () => {
      const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
      };
      mockSupabase.from.mockReturnValue(queryBuilder);

      await expect(storeService.getStoreBySlug('non-existent'))
        .rejects.toMatchObject({ message: 'Store not found', statusCode: 404 });
    });
  });

  // ==========================================================================
  // getStoreById
  // ==========================================================================
  describe('getStoreById', () => {
    it('should return store when found by ID', async () => {
      const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: testStore, error: null }),
      };
      mockSupabase.from.mockReturnValue(queryBuilder);

      const result = await storeService.getStoreById('store-123');

      expect(mockSupabase.from).toHaveBeenCalledWith('stores');
      expect(result.id).toBe('store-123');
    });

    it('should filter by businessId when provided', async () => {
      const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: testStore, error: null }),
      };
      mockSupabase.from.mockReturnValue(queryBuilder);

      await storeService.getStoreById('store-123', 'business-123');

      // Should have been called twice: once for id, once for business_id
      expect(queryBuilder.eq).toHaveBeenCalledWith('id', 'store-123');
      expect(queryBuilder.eq).toHaveBeenCalledWith('business_id', 'business-123');
    });

    it('should throw 404 when store not found', async () => {
      const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
      };
      mockSupabase.from.mockReturnValue(queryBuilder);

      await expect(storeService.getStoreById('non-existent'))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ==========================================================================
  // getStoreOrders
  // ==========================================================================
  describe('getStoreOrders', () => {
    it('serializes the product filter as valid JSON containment', async () => {
      const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        filter: jest.fn().mockReturnThis(),
        then: (resolve: (value: unknown) => void) =>
          resolve({ data: [], error: null, count: 0 }),
      };
      mockSupabase.from.mockReturnValue(queryBuilder);

      await storeService.getStoreOrders('store-123', {
        page: 1,
        limit: 10,
        product_id: 'product-123',
      });

      expect(queryBuilder.filter).toHaveBeenCalledWith(
        'items',
        'cs',
        JSON.stringify([{ product_id: 'product-123' }]),
      );
    });
  });

  // ==========================================================================
  // getStoresByBusiness
  // ==========================================================================
  describe('getStoresByBusiness', () => {
    it('should return stores with analytics', async () => {
      const stores = [testStore];
      const orders = [
        { store_id: 'store-123', total: 5000, status: 'paid' },
        { store_id: 'store-123', total: 3000, status: 'fulfilled' },
      ];

      let callCount = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        callCount++;
        if (table === 'stores') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            order: jest.fn().mockResolvedValue({ data: stores, error: null }),
          };
        }
        if (table === 'store_orders') {
          return {
            select: jest.fn().mockReturnThis(),
            in: jest.fn().mockReturnThis(),
            // Chain from in to final result
            then: (resolve: any) => resolve({ data: orders, error: null }),
          };
        }
        return {
          select: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({ data: orders, error: null }),
        };
      });

      const result = await storeService.getStoresByBusiness('business-123');

      expect(mockSupabase.from).toHaveBeenCalledWith('stores');
      expect(result).toHaveLength(1);
      expect(result[0].order_count).toBe(2);
      expect(result[0].total_revenue).toBe(8000);
    });

    it('should return empty array when no stores', async () => {
      mockSupabase.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue({ data: [], error: null }),
      });

      const result = await storeService.getStoresByBusiness('empty-business');

      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // getStoreAnalytics
  // ==========================================================================
  describe('getStoreAnalytics', () => {
    it('should calculate analytics correctly', async () => {
      const orders = [
        { id: 'o1', total: 5000, status: 'paid', customer_email: 'a@test.com' },
        { id: 'o2', total: 3000, status: 'fulfilled', customer_email: 'b@test.com' },
        { id: 'o3', total: 2000, status: 'paid', customer_email: 'a@test.com' }, // Same customer
      ];

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'store_orders') {
          const builder: any = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            in: jest.fn().mockResolvedValue({ data: orders, error: null }),
          };
          return builder;
        }
        if (table === 'products') {
          // select with count option returns result directly
          const builder: any = {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            then: (resolve: (value: unknown) => void) =>
              Promise.resolve({ count: 10, error: null }).then(resolve),
          };
          return builder;
        }
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
        };
      });

      const result = await storeService.getStoreAnalytics('store-123');

      expect(result.total_revenue).toBe(10000);
      expect(result.total_orders).toBe(3);
      expect(result.total_customers).toBe(2); // Unique emails
      expect(result.total_products).toBe(10);
    });

    it('should validate business ownership when businessId provided', async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'stores') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
          };
        }
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
        };
      });

      await expect(storeService.getStoreAnalytics('store-123', 'wrong-business'))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ==========================================================================
  // deleteProduct
  // ==========================================================================
  describe('deleteProduct', () => {
    it('should delete product after ownership validation', async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'stores') {
          // validateStoreOwnership -> getStoreById
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: testStore, error: null }),
          };
        }
        if (table === 'products') {
          // deleteProduct calls select() first (to fetch file URLs) then delete()
          const eqMock = jest.fn().mockReturnThis();
          eqMock.mockReturnValueOnce({ eq: jest.fn().mockResolvedValue({ data: null, error: null }) });
          return {
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                eq: jest.fn().mockReturnValue({
                  single: jest.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
            delete: jest.fn().mockReturnValue({ eq: eqMock }),
          };
        }
        if (table === 'product_module_links' || table === 'product_circle_links') {
          // deleteProductModuleLink -> delete().eq() on both the module link
          // table and the legacy circle link table
          return {
            delete: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: null, error: null }),
            }),
          };
        }
        return { select: jest.fn().mockReturnThis() };
      });

      await storeService.deleteProduct('store-123', 'product-123', testFixtures.user.id);

      expect(mockSupabase.from).toHaveBeenCalledWith('products');
    });
  });

  // ==========================================================================
  // createStore
  // ==========================================================================
  describe('createStore', () => {
    it('should create store with generated slug', async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'stores') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }), // No existing slug
            insert: jest.fn().mockReturnThis(),
          };
        }
        return { select: jest.fn().mockReturnThis() };
      });

      // Mock insert chain
      const insertBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn()
          .mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } }) // Check slug
          .mockResolvedValueOnce({ data: { ...testStore, name: 'New Store' }, error: null }), // Return created
        insert: jest.fn().mockReturnThis(),
      };

      mockSupabase.from.mockReturnValue(insertBuilder);

      const result = await storeService.createStore(
        testFixtures.user.id,
        testFixtures.business.id,
        { name: 'New Store' }
      );

      expect(mockSupabase.from).toHaveBeenCalledWith('stores');
      expect(result.name).toBe('New Store');
    });

    it('should throw 409 when slug already exists', async () => {
      mockSupabase.from.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: { id: 'existing' }, error: null }),
      });

      await expect(
        storeService.createStore(testFixtures.user.id, testFixtures.business.id, { name: 'Test', slug: 'existing-slug' })
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // ==========================================================================
  // getPublicProduct — fee bearer resolution
  // ==========================================================================
  describe('getPublicProduct', () => {
    it('should resolve paystack_fee_bearer from business.paystack_fee_bearer', async () => {
      const businessData = {
        id: 'business-123',
        name: 'Test Business',
        paystack_subaccount_code: null,
        paystack_fee_bearer: 'customer',
      };

      const storeData = {
        id: 'store-123',
        name: 'Test Store',
        slug: 'test-store',
        is_live: true,
        appearance: {} as any,
        paystack_subaccount_code: null,
        business: businessData,
      };

      const storesBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest
          .fn()
          .mockResolvedValue({ data: storeData, error: null }),
      };

      const productsBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest
          .fn()
          .mockResolvedValue({ data: { ...testProduct }, error: null }),
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'stores') return storesBuilder;
        if (table === 'products') return productsBuilder;
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest
            .fn()
            .mockResolvedValue({ data: null, error: null }),
          single: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      });

      jest.spyOn(storeService, 'getProductCategories').mockResolvedValue([]);
      jest.spyOn(storeService, 'getProductModuleLink').mockResolvedValue(null);

      const result = await storeService.getPublicProduct(
        'test-store',
        'product-123',
      );

      expect(result.store.paystack_fee_bearer).toBe('customer');
    });

    it('should default to "subaccount" when business.paystack_fee_bearer is null', async () => {
      const businessData = {
        id: 'business-123',
        name: 'Test Business',
        paystack_subaccount_code: null,
        paystack_fee_bearer: null,
      };

      const storeData = {
        id: 'store-123',
        name: 'Test Store',
        slug: 'test-store',
        is_live: true,
        appearance: {} as any,
        paystack_subaccount_code: null,
        business: businessData,
      };

      const storesBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest
          .fn()
          .mockResolvedValue({ data: storeData, error: null }),
      };

      const productsBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest
          .fn()
          .mockResolvedValue({ data: { ...testProduct }, error: null }),
      };

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'stores') return storesBuilder;
        if (table === 'products') return productsBuilder;
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest
            .fn()
            .mockResolvedValue({ data: null, error: null }),
          single: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
      });

      jest.spyOn(storeService, 'getProductCategories').mockResolvedValue([]);
      jest.spyOn(storeService, 'getProductModuleLink').mockResolvedValue(null);

      const result = await storeService.getPublicProduct(
        'test-store',
        'product-123',
      );

      expect(result.store.paystack_fee_bearer).toBe('subaccount');
    });
  });

  // ==========================================================================
  // calculateEligibleSubtotal
  // ==========================================================================
  describe('calculateEligibleSubtotal', () => {
    const items = [
      { product_id: 'prod-a', lineTotal: 1000 },
      { product_id: 'prod-b', lineTotal: 2000 },
      { product_id: 'prod-c', lineTotal: 3000 },
    ];

    it('should return full sum when applies_to is "all"', () => {
      const discount = { applies_to: 'all' as const, product_ids: [] };
      const result = calculateEligibleSubtotal(items, discount);
      expect(result).toBe(6000);
    });

    it('should return sum of matching products when applies_to is "specific"', () => {
      const discount = {
        applies_to: 'specific' as const,
        product_ids: ['prod-a', 'prod-c'],
      };
      const result = calculateEligibleSubtotal(items, discount);
      expect(result).toBe(4000);
    });

    it('should return 0 when no products match', () => {
      const discount = {
        applies_to: 'specific' as const,
        product_ids: ['prod-x'],
      };
      const result = calculateEligibleSubtotal(items, discount);
      expect(result).toBe(0);
    });
  });

  // ==========================================================================
  // validateDiscountCode — product scoping
  // ==========================================================================
  describe('validateDiscountCode product scoping', () => {
    const validDiscountRow = {
      id: 'disc-1',
      store_id: 'store-123',
      code: 'SCOPE10',
      type: 'percentage' as const,
      value: 10,
      is_active: true,
      usage_count: 0,
      max_usage: null,
      expires_at: null,
      applies_to: 'all' as const,
      product_ids: [] as string[],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    function mockDiscountQuery(data: any) {
      const builder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data, error: null }),
      };
      mockSupabase.from.mockReturnValue(builder);
    }

    it('should apply to full subtotal when applies_to is "all" with items', async () => {
      const discount = { ...validDiscountRow, applies_to: 'all', product_ids: [] };
      mockDiscountQuery(discount);

      const result = await storeService.validateDiscountCode('store-123', 'SCOPE10', {
        items: [
          { product_id: 'prod-a', line_total: 1000 },
          { product_id: 'prod-b', line_total: 2000 },
        ],
      });

      expect(result.valid).toBe(true);
      expect(result.discountAmount).toBe(300); // 10% of 3000
    });

    it('should only discount eligible items when applies_to is "specific"', async () => {
      const discount = {
        ...validDiscountRow,
        applies_to: 'specific' as const,
        product_ids: ['prod-a', 'prod-c'],
      };
      mockDiscountQuery(discount);

      const result = await storeService.validateDiscountCode('store-123', 'SCOPE10', {
        items: [
          { product_id: 'prod-a', line_total: 1000 },
          { product_id: 'prod-b', line_total: 2000 },
          { product_id: 'prod-c', line_total: 3000 },
        ],
      });

      expect(result.valid).toBe(true);
      expect(result.discountAmount).toBe(400); // 10% of 4000 (prod-a + prod-c)
    });

    it('should return valid:false when no items match a specific code', async () => {
      const discount = {
        ...validDiscountRow,
        applies_to: 'specific' as const,
        product_ids: ['prod-x'],
      };
      mockDiscountQuery(discount);

      const result = await storeService.validateDiscountCode('store-123', 'SCOPE10', {
        items: [
          { product_id: 'prod-a', line_total: 1000 },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.message).toBe('No eligible items for this code');
    });

    it('should fall back to subtotal when applies_to is "all" and no items given', async () => {
      const discount = { ...validDiscountRow, applies_to: 'all', product_ids: [] };
      mockDiscountQuery(discount);

      const result = await storeService.validateDiscountCode('store-123', 'SCOPE10', {
        subtotal: 5000,
      });

      expect(result.valid).toBe(true);
      expect(result.discountAmount).toBe(500); // 10% of 5000
    });

    it('should reject subtotal-only call for a "specific" code', async () => {
      const discount = {
        ...validDiscountRow,
        applies_to: 'specific' as const,
        product_ids: ['prod-a'],
      };
      mockDiscountQuery(discount);

      const result = await storeService.validateDiscountCode('store-123', 'SCOPE10', {
        subtotal: 5000,
      });

      expect(result.valid).toBe(false);
      expect(result.message).toBe('This code applies to specific products');
    });

    it('should cap fixed discount to eligible subtotal', async () => {
      const discount = {
        ...validDiscountRow,
        type: 'fixed' as const,
        value: 10000,
        applies_to: 'specific' as const,
        product_ids: ['prod-a'],
      };
      mockDiscountQuery(discount);

      const result = await storeService.validateDiscountCode('store-123', 'SCOPE10', {
        items: [{ product_id: 'prod-a', line_total: 3000 }],
      });

      expect(result.valid).toBe(true);
      expect(result.discountAmount).toBe(3000); // capped to eligible subtotal
    });
  });

  // ==========================================================================
  // isDiscountApplicable
  // ==========================================================================
  describe('isDiscountApplicable', () => {
    const baseDiscount = {
      id: 'disc-1',
      store_id: 'store-123',
      code: 'TEST',
      type: 'percentage' as const,
      value: 10,
      is_active: true,
      usage_count: 0,
      max_usage: null,
      expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    it('should return true when an "all" discount exists', async () => {
      const builder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({
          data: [{ ...baseDiscount, applies_to: 'all', product_ids: [] }],
          error: null,
        }),
      };
      mockSupabase.from.mockReturnValue(builder);

      const result = await storeService.isDiscountApplicable('store-123', ['prod-a']);
      expect(result).toBe(true);
    });

    it('should return true when product_ids intersect', async () => {
      const builder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({
          data: [
            {
              ...baseDiscount,
              applies_to: 'specific',
              product_ids: ['prod-a', 'prod-c'],
            },
          ],
          error: null,
        }),
      };
      mockSupabase.from.mockReturnValue(builder);

      const result = await storeService.isDiscountApplicable('store-123', ['prod-b', 'prod-c']);
      expect(result).toBe(true);
    });

    it('should return false when no codes match product_ids', async () => {
      const builder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({
          data: [
            {
              ...baseDiscount,
              applies_to: 'specific',
              product_ids: ['prod-x'],
            },
          ],
          error: null,
        }),
      };
      mockSupabase.from.mockReturnValue(builder);

      const result = await storeService.isDiscountApplicable('store-123', ['prod-a']);
      expect(result).toBe(false);
    });

    it('should return false when only expired/inactive codes exist', async () => {
      const builder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        or: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({
          data: [
            {
              ...baseDiscount,
              is_active: false,
              applies_to: 'all',
              product_ids: [],
            },
          ],
          error: null,
        }),
      };
      mockSupabase.from.mockReturnValue(builder);

      const result = await storeService.isDiscountApplicable('store-123', ['prod-a']);
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // Modifier groups — inline options
  // ==========================================================================
  describe('createModifierGroup with inline options', () => {
    it('persists options in one insert and returns them on the created group', async () => {
      jest
        .spyOn(crypto, 'randomUUID')
        .mockReturnValue('00000000-0000-0000-0000-000000000001');

      const groupRow = {
        id: 'group-1',
        store_id: 'store-123',
        name: 'Crust',
        kind: 'modifier',
        options: [
          {
            id: '00000000-0000-0000-0000-000000000001',
            modifier_group_id: null,
            name: 'Thin',
            price_delta: 0,
            position: 0,
          },
        ],
      };
      const builder = createMockQueryBuilder(groupRow);
      mockSupabase.from.mockReturnValue(builder);

      const result = await storeService.createModifierGroup('store-123', {
        name: 'Crust',
        options: [{ name: 'Thin' }],
      });

      expect(mockSupabase.from).toHaveBeenCalledWith('modifier_groups');
      const insertCall = builder.insert.mock.calls[0][0];
      expect(insertCall.options).toHaveLength(1);
      expect(insertCall.options[0].name).toBe('Thin');
      expect(insertCall.options[0].position).toBe(0);
      expect(result.options).toHaveLength(1);
      expect(result.options_count).toBe(1);
    });

    it('returns an empty options list when none are supplied', async () => {
      const builder = createMockQueryBuilder({
        id: 'group-1',
        store_id: 'store-123',
        name: 'Crust',
      });
      mockSupabase.from.mockReturnValue(builder);

      const result = await storeService.createModifierGroup('store-123', {
        name: 'Crust',
      });

      expect(result.options).toEqual([]);
      expect(result.options_count).toBe(0);
    });
  });

  describe('updateModifierGroup with inline options', () => {
    it('replaces the options array and reloads the group', async () => {
      // First call (assert ownership) resolves the owned group; subsequent
      // call (count) resolves the group with its new options.
      const ownedGroup = { id: 'group-1', store_id: 'store-123' };
      const updatedGroup = { ...ownedGroup, name: 'Crust', options: [] };
      const builder = createMockQueryBuilder(ownedGroup);
      mockSupabase.from.mockReturnValue(builder);
      builder.single
        .mockResolvedValueOnce({ data: ownedGroup, error: null })
        .mockResolvedValueOnce({ data: updatedGroup, error: null });

      const result = await storeService.updateModifierGroup('store-123', 'group-1', {
        name: 'Crust',
        options: [{ name: 'Thin' }],
      });

      const replaceUpdate = builder.update.mock.calls.find(
        (call: any[]) => call[0].options !== undefined,
      );
      expect(replaceUpdate[0].options).toHaveLength(1);
      expect(replaceUpdate[0].options[0].name).toBe('Thin');
      expect(result).toBeDefined();
    });
  });
});
