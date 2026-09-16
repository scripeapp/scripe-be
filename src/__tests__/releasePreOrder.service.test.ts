/**
 * Tests for StoreService pre-order release flow.
 *
 * Covers per-item release, whole-order status resolution, the correct buyer
 * email per product type, and the guard that blocks status changes on orders
 * still awaiting release.
 */

jest.mock('../utils/storeEmails.util', () => ({
  storeEmailService: {
    sendDigitalProductLinks: jest.fn().mockResolvedValue(undefined),
    sendPreOrderReleaseNotification: jest.fn().mockResolvedValue(undefined),
    sendFulfillmentNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

import { StoreService } from '../services/store.service';
import { storeEmailService } from '../utils/storeEmails.util';
import { createMockSupabaseClient } from './test-utils';

type OrderItem = {
  product_id: string;
  product_type: string;
  is_pre_order: boolean;
};

describe('StoreService pre-order release', () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let storeService: StoreService;

  const storeId = 'store-123';
  const store = { name: 'Test Store', business_id: 'biz-123' };

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    storeService = new StoreService(mockSupabase as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Wire `from()` for the release flow. `orderUpdate` captures every
   * store_orders update so tests can assert the persisted status and items.
   */
  function setupReleaseMocks(options: {
    orders: Array<{ id: string; payment_reference?: string; items: OrderItem[] }>;
    product: { id: string; type: string; name: string; pre_order_message: string | null };
  }) {
    const orderUpdate = jest
      .fn()
      .mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) });
    const productUpdate = jest
      .fn()
      .mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'store_orders') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          update: orderUpdate,
          then: (resolve: any) =>
            resolve({ data: options.orders, error: null }),
        };
      }
      if (table === 'stores') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: store, error: null }),
        };
      }
      if (table === 'products') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest
            .fn()
            .mockResolvedValue({ data: options.product, error: null }),
          update: productUpdate,
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    return { orderUpdate, productUpdate };
  }

  function lastOrderUpdate(orderUpdate: jest.Mock) {
    const calls = orderUpdate.mock.calls;
    return calls[calls.length - 1][0];
  }

  it('releases a physical order into the paid shipping flow', async () => {
    const { orderUpdate } = setupReleaseMocks({
      orders: [
        {
          id: 'order-1',
          payment_reference: 'ref-1',
          items: [
            { product_id: 'prod-1', product_type: 'physical', is_pre_order: true },
          ],
        },
      ],
      product: {
        id: 'prod-1',
        type: 'physical',
        name: 'Vinyl Record',
        pre_order_message: 'Ships next week',
      },
    });

    const result = await storeService.releasePreOrderProduct(storeId, 'prod-1');

    expect(result).toEqual({ released_count: 1, fulfilled_count: 0 });
    expect(storeEmailService.sendPreOrderReleaseNotification).toHaveBeenCalledTimes(1);
    expect(storeEmailService.sendDigitalProductLinks).not.toHaveBeenCalled();
    expect(lastOrderUpdate(orderUpdate).status).toBe('paid');
  });

  it('releases a digital order as fulfilled and emails download links', async () => {
    const { orderUpdate } = setupReleaseMocks({
      orders: [
        {
          id: 'order-2',
          payment_reference: 'ref-2',
          items: [
            { product_id: 'prod-2', product_type: 'digital', is_pre_order: true },
          ],
        },
      ],
      product: {
        id: 'prod-2',
        type: 'digital',
        name: 'E-Album',
        pre_order_message: null,
      },
    });

    const result = await storeService.releasePreOrderProduct(storeId, 'prod-2');

    expect(result).toEqual({ released_count: 0, fulfilled_count: 1 });
    expect(storeEmailService.sendDigitalProductLinks).toHaveBeenCalledTimes(1);
    expect(storeEmailService.sendPreOrderReleaseNotification).not.toHaveBeenCalled();

    const update = lastOrderUpdate(orderUpdate);
    expect(update.status).toBe('fulfilled');
    expect(update.fulfilled_at).toBeDefined();
  });

  it('keeps an order in pre_order while another pre-order item is unreleased', async () => {
    const { orderUpdate } = setupReleaseMocks({
      orders: [
        {
          id: 'order-3',
          payment_reference: 'ref-3',
          items: [
            { product_id: 'prod-a', product_type: 'physical', is_pre_order: true },
            { product_id: 'prod-b', product_type: 'physical', is_pre_order: true },
          ],
        },
      ],
      product: {
        id: 'prod-a',
        type: 'physical',
        name: 'Item A',
        pre_order_message: null,
      },
    });

    const result = await storeService.releasePreOrderProduct(storeId, 'prod-a');

    expect(result).toEqual({ released_count: 0, fulfilled_count: 0 });

    const update = lastOrderUpdate(orderUpdate);
    expect(update.status).toBe('pre_order');
    const items = update.items as OrderItem[];
    expect(items.find((item) => item.product_id === 'prod-a')?.is_pre_order).toBe(false);
    expect(items.find((item) => item.product_id === 'prod-b')?.is_pre_order).toBe(true);
  });

  it('returns zero counts when no pre-order orders contain the product', async () => {
    setupReleaseMocks({
      orders: [
        {
          id: 'order-4',
          items: [
            { product_id: 'other', product_type: 'physical', is_pre_order: true },
          ],
        },
      ],
      product: {
        id: 'prod-missing',
        type: 'physical',
        name: 'Unsold',
        pre_order_message: null,
      },
    });

    const result = await storeService.releasePreOrderProduct(
      storeId,
      'prod-missing',
    );

    expect(result).toEqual({ released_count: 0, fulfilled_count: 0 });
    expect(storeEmailService.sendPreOrderReleaseNotification).not.toHaveBeenCalled();
    expect(storeEmailService.sendDigitalProductLinks).not.toHaveBeenCalled();
  });

  it('rejects status changes on an order still in pre_order', async () => {
    mockSupabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest
        .fn()
        .mockResolvedValue({ data: { id: 'order-5', status: 'pre_order' }, error: null }),
    } as any);

    await expect(
      storeService.updateOrderStatus(storeId, 'order-5', 'fulfilled'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
