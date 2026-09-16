/**
 * Membership Integration Tests
 */

import { Request, Response } from 'express';
import { handlePaystackWebhook } from '../controllers/webhook.controller';
import { subscriptionController } from '../controllers/subscription.controller';
import crypto from 'node:crypto';

// Mock Supabase
jest.mock('../config/supabase', () => {
  const mockChain = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn(),
  };
  return {
    supabase: { from: jest.fn().mockReturnValue(mockChain) },
  };
});

jest.mock('../config/supabaseAdmin', () => {
  const mockChain = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    single: jest.fn(),
  };
  return {
    __esModule: true,
    default: { from: jest.fn().mockReturnValue(mockChain) },
  };
});

// Mock Email Service
jest.mock('../services/email.service', () => ({
  emailService: {
    sendAuditEvent: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock Publication Subscription Service
jest.mock('../services/publication-subscription.service', () => ({
  publicationSubscriptionService: {
    handleSubscriptionDisabled: jest.fn().mockResolvedValue(undefined),
    handlePaymentFailed: jest.fn().mockResolvedValue(undefined),
  },
}));

const createMockReq = (params: any = {}, query: any = {}, body: any = {}, headers: any = {}): Partial<Request> => {
  const { supabase } = require('../config/supabase');
  return {
    params,
    query,
    body,
    headers,
    supabase,
    user_id: 'user-1'
  } as any;
};

const createMockRes = (): Partial<Response> => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createPaystackSignature = (body: any): string => {
  return crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || 'test_secret_key')
    .update(JSON.stringify(body))
    .digest('hex');
};

describe('Membership Enhancements Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Subscriber Management API', () => {
    it('should retrieve subscribers for a product', async () => {
      const { supabase } = require('../config/supabase');
      const mockSubscribers = [
        {
          id: 'sub-1',
          user_id: 'user-1',
          status: 'active',
          users: { name: 'John Doe', email: 'john@example.com', preferences: { profile_image: 'avatar.jpg' } }
        }
      ];

      (supabase.from().select().eq().order as jest.Mock).mockResolvedValue({ data: mockSubscribers, error: null });

      const req = createMockReq({ productId: 'prod-1' });
      const res = createMockRes();

      await subscriptionController.getProductSubscribers(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            user_name: 'John Doe',
            user_email: 'john@example.com',
            user_avatar: 'avatar.jpg'
          })
        ])
      }));
    });
  });

  describe('Paystack Webhook - Store Membership', () => {
    it('should process store_membership charge.success', async () => {
      const supabaseAdmin = require('../config/supabaseAdmin').default;
      
      // Mock product fetch
      (supabaseAdmin.from().select().eq().single as jest.Mock)
        .mockResolvedValueOnce({ data: { id: 'prod-1', store_id: 'store-1', type: 'membership' }, error: null }) // product check
        .mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } }); // existing sub check (none found)

      // Mock subscription insert
      (supabaseAdmin.from().insert().select().single as jest.Mock)
        .mockResolvedValue({ data: { id: 'new-sub-1', status: 'active' }, error: null });

      const body = {
        event: 'charge.success',
        data: {
          reference: 'T-123',
          amount: 500000, // 5000 NGN
          status: 'success',
          metadata: {
            subscription_type: 'store_membership',
            product_id: 'prod-1',
            user_id: 'user-1',
            full_name: 'Test Subscriber',
            email: 'sub@example.com'
          },
          subscription_code: 'SUB_CODE_123',
          customer: {
            customer_code: 'CUST_CODE_123',
            email_token: 'TOKEN_123'
          }
        }
      };

      const signature = createPaystackSignature(body);
      const req = createMockReq({}, {}, body, { 'x-paystack-signature': signature });
      const res = createMockRes();

      await handlePaystackWebhook(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(supabaseAdmin.from).toHaveBeenCalledWith('store_subscriptions');
      expect(supabaseAdmin.from().insert).toHaveBeenCalledWith(expect.objectContaining({
        product_id: 'prod-1',
        user_id: 'user-1',
        paystack_subscription_code: 'SUB_CODE_123'
      }));
    });

    it('should handle subscription.disable for store membership', async () => {
      const supabaseAdmin = require('../config/supabaseAdmin').default;
      
      // Mock subscription update
      (supabaseAdmin.from().update().eq().select().single as jest.Mock)
        .mockResolvedValue({ data: { id: 'sub-1', status: 'cancelled' }, error: null });

      const body = {
        event: 'subscription.disable',
        data: {
          subscription_code: 'SUB_CODE_123'
        }
      };

      const signature = createPaystackSignature(body);
      const req = createMockReq({}, {}, body, { 'x-paystack-signature': signature });
      const res = createMockRes();

      await handlePaystackWebhook(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(supabaseAdmin.from).toHaveBeenCalledWith('store_subscriptions');
      expect(supabaseAdmin.from().update).toHaveBeenCalledWith(expect.objectContaining({
        status: 'cancelled'
      }));
    });
  });

  describe('Phase 5: Member-Exclusive Content', () => {
    describe('CRUD Authorization', () => {
      it('should allow merchant to create content', async () => {
        const { supabase } = require('../config/supabase');
        const mockChain = supabase.from();
        
        // Reset all relevant mocks locally
        (mockChain.single as jest.Mock).mockReset();
        (mockChain.limit as jest.Mock).mockReset();
        (mockChain.select as jest.Mock).mockReturnThis();
        (mockChain.eq as jest.Mock).mockReturnThis();
        (mockChain.order as jest.Mock).mockReturnThis();
        (mockChain.insert as jest.Mock).mockReturnThis();

        // 1. validateProductMerchantAccess (single)
        (mockChain.single as jest.Mock).mockResolvedValueOnce({ 
          data: { id: 'prod-1', store_id: 'store-1', stores: { user_id: 'user-1' } }, 
          error: null 
        });

        // 2. Get max position (limit)
        (mockChain.limit as jest.Mock).mockResolvedValueOnce({
          data: [{ position: 5 }],
          error: null
        });
        
        // 3. createContent (single)
        (mockChain.single as jest.Mock).mockResolvedValueOnce({ 
          data: { id: 'cont-1', title: 'New Content' }, 
          error: null 
        });

        const req = createMockReq({}, {}, { product_id: 'prod-1', title: 'New Content' });
        const res = createMockRes();

        await subscriptionController.createContent(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('should deny non-owner from creating content', async () => {
        const { supabase } = require('../config/supabase');
        
        // Mock product/store owner check (owner is user-2)
        (supabase.from().select().eq().single as jest.Mock).mockResolvedValue({ 
          data: { id: 'prod-1', store_id: 'store-1', stores: { user_id: 'user-2' } }, 
          error: null 
        });

        const req = createMockReq({}, {}, { product_id: 'prod-1', title: 'New Content' });
        const res = createMockRes();

        await subscriptionController.createContent(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(403);
      });
    });

    describe('Secure Delivery', () => {
      it('should return full content for merchant', async () => {
        const { supabase } = require('../config/supabase');
        
        // Mock product/store owner check
        (supabase.from().select().eq().single as jest.Mock).mockResolvedValueOnce({ 
          data: { id: 'prod-1', store_id: 'store-1', stores: { user_id: 'user-1' } }, 
          error: null 
        });
        
        // Mock content fetch
        (supabase.from().select().eq().order as jest.Mock).mockResolvedValue({ 
          data: [{ id: 'c1', title: 'Secret', content: { url: 'hidden.com', text: 'shhh' } }], 
          error: null 
        });

        const req = createMockReq({ productId: 'prod-1' });
        const res = createMockRes();

        await subscriptionController.getMembershipContent(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ content: { url: 'hidden.com', text: 'shhh' } })
          ])
        }));
      });

      it('should return full content for subscriber', async () => {
        const { supabase } = require('../config/supabase');
        
        // Mock product/store owner check (not merchant)
        (supabase.from().select().eq().single as jest.Mock).mockResolvedValueOnce({ 
          data: { id: 'prod-1', store_id: 'store-1', stores: { user_id: 'user-2' } }, 
          error: null 
        });

        // Mock subscription check (active)
        (supabase.from().select().eq().eq().eq().limit as jest.Mock).mockResolvedValueOnce({ 
          data: [{ id: 's1' }], 
          error: null 
        });
        
        // Mock content fetch
        (supabase.from().select().eq().order as jest.Mock).mockResolvedValue({ 
          data: [{ id: 'c1', title: 'Secret', content: { url: 'hidden.com', text: 'shhh' } }], 
          error: null 
        });

        const req = createMockReq({ productId: 'prod-1' });
        const res = createMockRes();

        await subscriptionController.getMembershipContent(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ content: { url: 'hidden.com', text: 'shhh' } })
          ])
        }));
      });

      it('should omit sensitive fields for non-subscribers', async () => {
        const { supabase } = require('../config/supabase');
        
        // Mock product/store owner check (not merchant)
        (supabase.from().select().eq().single as jest.Mock).mockResolvedValueOnce({ 
          data: { id: 'prod-1', store_id: 'store-1', stores: { user_id: 'user-2' } }, 
          error: null 
        });

        // Mock subscription check (not found)
        (supabase.from().select().eq().eq().eq().limit as jest.Mock).mockResolvedValueOnce({ 
          data: [], 
          error: null 
        });
        
        // Mock content fetch
        (supabase.from().select().eq().order as jest.Mock).mockResolvedValue({ 
          data: [{ id: 'c1', title: 'Secret', content: { type: 'video', url: 'hidden.com', text: 'shhh' } }], 
          error: null 
        });

        const req = createMockReq({ productId: 'prod-1' });
        const res = createMockRes();

        await subscriptionController.getMembershipContent(req as Request, res as Response);

        expect(res.status).toHaveBeenCalledWith(200);
        const responseData = (res.json as jest.Mock).mock.calls[0][0].data;
        expect(responseData[0].content).toEqual({ type: 'video' });
        expect(responseData[0].content.url).toBeUndefined();
        expect(responseData[0].content.text).toBeUndefined();
      });
    });
  });
});
