/**
 * Tests for CatalogService
 *
 * Verifies the unified store catalog: merging of products, events, and courses
 * with unified pagination, sorting, and status/search filtering.
 */

import { CatalogService } from '../services/catalog.service';
import { createMockSupabaseClient } from './test-utils';

describe('CatalogService', () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;

  const now = new Date().toISOString();

  const product = {
    id: 'product-1',
    store_id: 'store-1',
    name: 'Digital Wallet',
    price: 5000,
    currency: 'NGN',
    type: 'digital',
    status: 'published',
    cover_image: null,
    slug: 'digital-wallet',
    sku: 'SKU-1',
    stock: 5,
    orders_count: 3,
    created_at: now,
  };

  const event = {
    id: 'event-1',
    event_name: 'Design Conference',
    status: 'published',
    cover_image: null,
    event_url: 'https://events.example.com/design-conf',
    created_at: now,
  };

  const course = {
    id: 'course-1',
    title: 'Intro to Design',
    price: 15000,
    payment_currency: 'NGN',
    cover_image_url: null,
    created_at: now,
  };

  const tableChains: Record<string, Record<string, any>> = {};

  function mockTable(table: string, chain: Record<string, any>) {
    tableChains[table] = chain;
    mockSupabase.from.mockImplementation((t: string) => tableChains[t] || buildQueryChain());
  }

  function buildQueryChain(rows: any[] = [], count = 0, error: Error | null = null) {
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      ilike: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      then: jest.fn((resolve) => resolve({ data: rows, error, count })),
    };
  }

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete tableChains.products;
    delete tableChains.events;
    delete tableChains.courses;
  });

  it('should merge products, events, and courses into a unified list', async () => {
    mockTable('products', buildQueryChain([product], 1));
    mockTable('events', buildQueryChain([event], 1));
    mockTable('courses', buildQueryChain([course], 1));

    const service = new CatalogService(mockSupabase as any);
    const result = await service.listCatalog({
      storeId: 'store-1',
      businessId: 'business-1',
      page: 1,
      limit: 10,
    });

    expect(result.meta.total).toBe(3);
    expect(result.data).toHaveLength(3);

    const kinds = result.data.map((item) => item.kind).sort();
    expect(kinds).toEqual(['course', 'event', 'product']);

    const productItem = result.data.find((item) => item.kind === 'product');
    expect(productItem).toMatchObject({
      id: 'product-1',
      name: 'Digital Wallet',
      price: 5000,
      type: 'digital',
      status: 'published',
      slug: 'digital-wallet',
      sku: null,
      stock: 5,
    });

    const eventItem = result.data.find((item) => item.kind === 'event');
    expect(eventItem).toMatchObject({
      id: 'event-1',
      name: 'Design Conference',
      type: 'event',
      status: 'published',
      sku: null,
      stock: null,
    });

    const courseItem = result.data.find((item) => item.kind === 'course');
    expect(courseItem).toMatchObject({
      id: 'course-1',
      name: 'Intro to Design',
      price: 15000,
      currency: 'NGN',
      type: 'course',
      status: 'published',
    });
  });

  it("sums tracked variant stock for a variant-based product instead of reporting its own null stock column as unlimited", async () => {
    const variantProduct = { ...product, id: 'product-2', stock: null };
    mockTable('products', buildQueryChain([variantProduct], 1));
    mockTable('events', buildQueryChain([], 0));
    mockTable('courses', buildQueryChain([], 0));
    mockTable(
      'product_variants',
      buildQueryChain(
        [
          { product_id: 'product-2', stock: 120 },
          { product_id: 'product-2', stock: 30 },
        ],
        2,
      ),
    );

    const service = new CatalogService(mockSupabase as any);
    const result = await service.listCatalog({
      storeId: 'store-1',
      businessId: 'business-1',
      page: 1,
      limit: 10,
    });

    const productItem = result.data.find((item) => item.kind === 'product');
    expect(productItem).toMatchObject({ id: 'product-2', stock: 150 });
  });

  it("falls back to the product's own stock column when it has no variants", async () => {
    mockTable('products', buildQueryChain([product], 1));
    mockTable('events', buildQueryChain([], 0));
    mockTable('courses', buildQueryChain([], 0));
    mockTable('product_variants', buildQueryChain([], 0));

    const service = new CatalogService(mockSupabase as any);
    const result = await service.listCatalog({
      storeId: 'store-1',
      businessId: 'business-1',
      page: 1,
      limit: 10,
    });

    const productItem = result.data.find((item) => item.kind === 'product');
    expect(productItem).toMatchObject({ id: 'product-1', stock: 5 });
  });

  it('should return an empty list when no store or business is provided', async () => {
    const service = new CatalogService(mockSupabase as any);
    const result = await service.listCatalog({ page: 1, limit: 10 });

    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
  });

  it('should paginate across merged sources', async () => {
    const products = [
      { ...product, id: 'p1', created_at: '2026-01-06T00:00:00Z' },
      { ...product, id: 'p2', created_at: '2026-01-03T00:00:00Z' },
    ];
    const events = [
      { ...event, id: 'e1', created_at: '2026-01-05T00:00:00Z' },
      { ...event, id: 'e2', created_at: '2026-01-02T00:00:00Z' },
    ];
    const courses = [
      { ...course, id: 'c1', created_at: '2026-01-04T00:00:00Z' },
      { ...course, id: 'c2', created_at: '2026-01-01T00:00:00Z' },
    ];
    mockTable('products', buildQueryChain(products, 2));
    mockTable('events', buildQueryChain(events, 2));
    mockTable('courses', buildQueryChain(courses, 2));

    const service = new CatalogService(mockSupabase as any);
    const result = await service.listCatalog({
      storeId: 'store-1',
      businessId: 'business-1',
      page: 2,
      limit: 2,
    });

    expect(result.data.map((item) => item.id)).toEqual(['c1', 'p2']);
    expect(result.meta).toMatchObject({ total: 6, page: 2, limit: 2, totalPages: 3 });
  });

  it('should use database-authoritative facets with the complete filter set', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: [
        { facet: 'types', value: 'digital', label: 'digital', count: 7200 },
        { facet: 'channels', value: 'pos', label: 'pos', count: 6100 },
      ],
      error: null,
    });

    const service = new CatalogService(mockSupabase as any);
    const result = await (service as any).buildFacets('store-1', {
      status: 'published',
      search: 'wallet',
      types: ['digital', 'physical'],
      categoryIds: ['11111111-1111-4111-8111-111111111111'],
      availability: ['in_stock', 'low_stock'],
      channels: ['pos'],
      priceMin: 1000,
      priceMax: 9000,
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-12-31T23:59:59.999Z',
      supplierIds: ['22222222-2222-4222-8222-222222222222'],
      createdByIds: ['33333333-3333-4333-8333-333333333333'],
    }, 0, 0);

    expect(mockSupabase.rpc).toHaveBeenCalledWith('get_product_catalog_facets', {
      p_store_id: 'store-1',
      p_status: 'published',
      p_search: 'wallet',
      p_types: ['digital', 'physical'],
      p_category_ids: ['11111111-1111-4111-8111-111111111111'],
      p_availability: ['in_stock', 'low_stock'],
      p_channels: ['pos'],
      p_price_min: 1000,
      p_price_max: 9000,
      p_created_from: '2026-01-01T00:00:00.000Z',
      p_created_to: '2026-12-31T23:59:59.999Z',
      p_supplier_ids: ['22222222-2222-4222-8222-222222222222'],
      p_created_by_ids: ['33333333-3333-4333-8333-333333333333'],
    });
    expect(result.types).toEqual([{ value: 'digital', label: 'digital', count: 7200 }]);
    expect(result.channels[0].count).toBe(6100);
  });

  it('should not fetch products when storeId is missing', async () => {
    mockTable('events', buildQueryChain([], 0));
    mockTable('courses', buildQueryChain([], 0));

    const service = new CatalogService(mockSupabase as any);
    const result = await service.listCatalog({
      businessId: 'business-1',
      page: 1,
      limit: 10,
    });

    expect(mockSupabase.from).not.toHaveBeenCalledWith('products');
    expect(result.meta.total).toBe(0);
  });

  it('should propagate database errors', async () => {
    mockTable('products', buildQueryChain([], 0));
    mockTable('events', buildQueryChain([], 0, new Error('boom')));
    mockTable('courses', buildQueryChain([], 0));

    const service = new CatalogService(mockSupabase as any);
    await expect(
      service.listCatalog({ storeId: 'store-1', businessId: 'business-1', page: 1, limit: 10 }),
    ).rejects.toThrow('boom');
  });
});
