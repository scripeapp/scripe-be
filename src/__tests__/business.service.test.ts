/**
 * Tests for BusinessService
 * 
 * Tests core business operations: CRUD, membership, and content attachment
 */

import BusinessService from '../services/business.service';
import {
  createMockSupabaseClient,
  createMockQueryBuilder,
  testFixtures,
} from './test-utils';

describe('BusinessService', () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let businessService: InstanceType<typeof BusinessService>;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    businessService = new BusinessService(mockSupabase as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // getBusinessById
  // ==========================================================================
  describe('getBusinessById', () => {
    it('should return business when found', async () => {
      const queryBuilder = createMockQueryBuilder(testFixtures.business);
      mockSupabase.from.mockReturnValue(queryBuilder);

      const result = await businessService.getBusinessById(testFixtures.business.id);

      expect(mockSupabase.from).toHaveBeenCalledWith('businesses');
      expect(queryBuilder.select).toHaveBeenCalledWith('*');
      expect(queryBuilder.eq).toHaveBeenCalledWith('id', testFixtures.business.id);
      expect(result).toEqual(testFixtures.business);
    });

    it('should return null when business not found (PGRST116)', async () => {
      // Mock the PGRST116 error which indicates no rows found
      const queryBuilder = createMockQueryBuilder(null, { code: 'PGRST116', message: 'Not found' });
      mockSupabase.from.mockReturnValue(queryBuilder);

      const result = await businessService.getBusinessById('non-existent-id');

      expect(result).toBeNull();
    });

    it('should throw error on other database failures', async () => {
      const queryBuilder = createMockQueryBuilder(null, { code: 'OTHER', message: 'DB Error' });
      mockSupabase.from.mockReturnValue(queryBuilder);

      await expect(businessService.getBusinessById(testFixtures.business.id))
        .rejects.toMatchObject({ message: 'DB Error' });
    });
  });

  // ==========================================================================
  // getBusinessBySlug
  // ==========================================================================
  describe('getBusinessBySlug', () => {
    it('should return business when found by slug', async () => {
      const businessWithStore = { ...testFixtures.business, store: [{ id: 'store-1' }] };
      const queryBuilder = createMockQueryBuilder(businessWithStore);
      mockSupabase.from.mockReturnValue(queryBuilder);

      const result = await businessService.getBusinessBySlug(testFixtures.business.slug!);

      expect(mockSupabase.from).toHaveBeenCalledWith('businesses');
      expect(queryBuilder.eq).toHaveBeenCalledWith('slug', testFixtures.business.slug);
      // The service converts store array to single object
      expect(result?.store).toEqual({ id: 'store-1' });
    });

    it('should return null for non-existent slug (PGRST116)', async () => {
      const queryBuilder = createMockQueryBuilder(null, { code: 'PGRST116' });
      mockSupabase.from.mockReturnValue(queryBuilder);

      const result = await businessService.getBusinessBySlug('non-existent-slug');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // userHasBusinesses
  // ==========================================================================
  describe('userHasBusinesses', () => {
    it('should return true when user owns a business', async () => {
      // Mock businesses query returning owned business
      const businessQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [{ id: '1' }], error: null }),
      };
      
      mockSupabase.from.mockReturnValue(businessQueryBuilder);

      const result = await businessService.userHasBusinesses(testFixtures.user.id);

      expect(result).toBe(true);
    });

    it('should return true when user is member of a business', async () => {
      // Mock businesses query returning empty (no owned)
      const businessQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [], error: null }),
      };

      // Mock memberships query returning a membership
      const membershipsQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [{ id: '1' }], error: null }),
      };

      let callCount = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        callCount++;
        if (table === 'businesses') return businessQueryBuilder;
        if (table === 'memberships') return membershipsQueryBuilder;
        return businessQueryBuilder;
      });

      const result = await businessService.userHasBusinesses(testFixtures.user.id);

      expect(result).toBe(true);
    });

    it('should return false when user has no businesses or memberships', async () => {
      // Mock both queries returning empty
      const emptyQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue({ data: [], error: null }),
      };

      mockSupabase.from.mockReturnValue(emptyQueryBuilder);

      const result = await businessService.userHasBusinesses('non-existent-user');

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // deleteBusiness
  // ==========================================================================
  describe('deleteBusiness', () => {
    it('should soft delete business by setting status to deleted', async () => {
      const updateBuilder = {
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ data: { id: testFixtures.business.id }, error: null }),
      };
      mockSupabase.from.mockReturnValue(updateBuilder);

      await businessService.deleteBusiness(testFixtures.business.id);

      expect(mockSupabase.from).toHaveBeenCalledWith('businesses');
      expect(updateBuilder.update).toHaveBeenCalledWith({ status: 'deleted' });
      expect(updateBuilder.eq).toHaveBeenCalledWith('id', testFixtures.business.id);
    });

    it('should throw error when deletion fails', async () => {
      const updateBuilder = {
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ data: null, error: { message: 'Delete failed' } }),
      };
      mockSupabase.from.mockReturnValue(updateBuilder);

      await expect(businessService.deleteBusiness(testFixtures.business.id))
        .rejects.toMatchObject({ message: 'Delete failed' });
    });
  });

  // ==========================================================================
  // createBusiness (simplified - tests core flow)
  // ==========================================================================
  describe('createBusiness', () => {
    const createInput = { name: 'New Business' };

    it('should create business and return it', async () => {
      const createdBusiness = {
        ...testFixtures.business,
        name: createInput.name,
      };

      // Mock the businesses insert chain
      const businessInsertBuilder = {
        insert: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: createdBusiness, error: null }),
      };

      // Mock the roles query
      const rolesQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: { id: 'owner-role-id' }, error: null }),
      };

      // Mock the memberships insert
      const membershipsInsertBuilder = {
        insert: jest.fn().mockResolvedValue({ data: null, error: null }),
      };

      // Mock content attachment queries (they should not fail)
      const contentUpdateBuilder = {
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue({ data: [], error: null }),
      };

      mockSupabase.from.mockImplementation((table: string) => {
        switch (table) {
          case 'businesses':
            return businessInsertBuilder;
          case 'roles':
            return rolesQueryBuilder;
          case 'memberships':
            return membershipsInsertBuilder;
          default:
            // Content tables
            return contentUpdateBuilder;
        }
      });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const result = await businessService.createBusiness(testFixtures.user.id, createInput);
      consoleSpy.mockRestore();

      expect(result.name).toBe(createInput.name);
      expect(mockSupabase.from).toHaveBeenCalledWith('businesses');
    });
  });
});
