/**
 * Tests for UserService
 *
 * Tests user preferences and profile operations
 */

import { UserService } from "../services/user.service";
import {
  createMockSupabaseClient,
  createMockQueryBuilder,
  testFixtures,
} from "./test-utils";

describe("UserService", () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let userService: UserService;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    userService = new UserService(mockSupabase as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // getUserPreferences
  // ==========================================================================
  describe("getUserPreferences", () => {
    it("should return user preferences with defaults", async () => {
      // Mock user_preferences query
      const prefQueryBuilder = createMockQueryBuilder({
        last_active_store_id: "store-123",
        last_active_publication_id: null,
      });

      // Mock users query
      const userQueryBuilder = createMockQueryBuilder({
        preferences: {
          timezone: "Africa/Lagos",
          currency: "NGN",
          locale: "en",
          theme: "dark",
        },
      });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "user_preferences") return prefQueryBuilder;
        if (table === "users") return userQueryBuilder;
        return createMockQueryBuilder(null);
      });

      const result = await userService.getUserPreferences(testFixtures.user.id);

      expect(result.last_active_store_id).toBe("store-123");
      expect(result.last_active_publication_id).toBeNull();
      expect(result.theme).toBe("dark");
    });

    it("should return defaults when preferences are not set", async () => {
      // Mock user_preferences returning no record (PGRST116)
      const prefQueryBuilder = createMockQueryBuilder(null, {
        code: "PGRST116",
      });

      // Mock users with no preferences
      const userQueryBuilder = createMockQueryBuilder({
        preferences: null,
      });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "user_preferences") return prefQueryBuilder;
        if (table === "users") return userQueryBuilder;
        return createMockQueryBuilder(null);
      });

      const result = await userService.getUserPreferences(testFixtures.user.id);

      expect(result.last_active_store_id).toBeNull();
      expect(result.timezone).toBe("Africa/Lagos");
      expect(result.currency).toBe("NGN");
      expect(result.locale).toBe("en");
      expect(result.theme).toBe("light");
    });

    it("should fall back when the stored theme is invalid", async () => {
      const prefQueryBuilder = createMockQueryBuilder(null, {
        code: "PGRST116",
      });
      const userQueryBuilder = createMockQueryBuilder({
        preferences: { theme: "sepia" },
      });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "user_preferences") return prefQueryBuilder;
        if (table === "users") return userQueryBuilder;
        return createMockQueryBuilder(null);
      });

      const result = await userService.getUserPreferences(testFixtures.user.id);

      expect(result.theme).toBe("light");
    });

    it("should throw error on database failure", async () => {
      const queryBuilder = createMockQueryBuilder(null, {
        message: "DB Error",
        code: "OTHER",
      });
      mockSupabase.from.mockReturnValue(queryBuilder);

      await expect(
        userService.getUserPreferences(testFixtures.user.id),
      ).rejects.toMatchObject({ message: "DB Error" });
    });
  });

  // ==========================================================================
  // updateUserPreferences
  // ==========================================================================
  describe("updateUserPreferences", () => {
    it("should update last_active_store_id in user_preferences", async () => {
      const upsertBuilder = createMockQueryBuilder({
        user_id: testFixtures.user.id,
      });
      mockSupabase.from.mockReturnValue(upsertBuilder);

      await userService.updateUserPreferences(testFixtures.user.id, {
        last_active_store_id: "new-store-id",
      });

      expect(mockSupabase.from).toHaveBeenCalledWith("user_preferences");
      expect(upsertBuilder.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: testFixtures.user.id,
          last_active_store_id: "new-store-id",
        }),
        { onConflict: "user_id" },
      );
    });

    it("should update general preferences in users table", async () => {
      // Mock fetching existing preferences
      const fetchBuilder = createMockQueryBuilder({
        preferences: { timezone: "Africa/Lagos" },
      });

      // Mock update
      const updateBuilder = createMockQueryBuilder({
        id: testFixtures.user.id,
      });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "users") {
          // Return different builders based on what's being done
          return {
            ...fetchBuilder,
            update: jest.fn().mockReturnValue(updateBuilder),
          };
        }
        return createMockQueryBuilder(null);
      });

      await userService.updateUserPreferences(testFixtures.user.id, {
        theme: "dark",
        currency: "USD",
      });

      expect(mockSupabase.from).toHaveBeenCalledWith("users");
    });

    it("should throw error when upsert fails", async () => {
      // The upsert call doesn't chain, it directly returns { data, error }
      const mockUpsertResult = {
        data: null,
        error: { message: "Upsert failed" },
      };
      const queryBuilder = {
        upsert: jest.fn().mockResolvedValue(mockUpsertResult),
      };
      mockSupabase.from.mockReturnValue(queryBuilder);

      await expect(
        userService.updateUserPreferences(testFixtures.user.id, {
          last_active_store_id: "store-id",
        }),
      ).rejects.toMatchObject({ message: "Upsert failed" });
    });
  });

  // ==========================================================================
  // getLastActiveStoreId
  // ==========================================================================
  describe("getLastActiveStoreId", () => {
    it("should return last_active_store_id from preferences", async () => {
      // Mock getUserPreferences returning a store ID
      const prefQueryBuilder = createMockQueryBuilder({
        last_active_store_id: "active-store-123",
        last_active_publication_id: null,
      });

      const userQueryBuilder = createMockQueryBuilder({
        preferences: {},
      });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "user_preferences") return prefQueryBuilder;
        if (table === "users") return userQueryBuilder;
        return createMockQueryBuilder(null);
      });

      const result = await userService.getLastActiveStoreId(
        testFixtures.user.id,
      );

      expect(result).toBe("active-store-123");
    });

    it("should fallback to first store when no preference set", async () => {
      // Mock preferences with no last_active_store_id
      const prefQueryBuilder = createMockQueryBuilder({
        last_active_store_id: null,
        last_active_publication_id: null,
      });

      const userQueryBuilder = createMockQueryBuilder({
        preferences: {},
      });

      // Mock stores query for fallback
      const storesQueryBuilder = createMockQueryBuilder({
        id: "first-store-id",
      });

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "user_preferences") return prefQueryBuilder;
        if (table === "users") return userQueryBuilder;
        if (table === "stores") return storesQueryBuilder;
        return createMockQueryBuilder(null);
      });

      const result = await userService.getLastActiveStoreId(
        testFixtures.user.id,
      );

      expect(result).toBe("first-store-id");
    });

    it("should return null when user has no stores", async () => {
      const prefQueryBuilder = createMockQueryBuilder({
        last_active_store_id: null,
        last_active_publication_id: null,
      });

      const userQueryBuilder = createMockQueryBuilder({
        preferences: {},
      });

      const storesQueryBuilder = createMockQueryBuilder(null);

      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "user_preferences") return prefQueryBuilder;
        if (table === "users") return userQueryBuilder;
        if (table === "stores") return storesQueryBuilder;
        return createMockQueryBuilder(null);
      });

      const result = await userService.getLastActiveStoreId(
        testFixtures.user.id,
      );

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // getUserProfile
  // ==========================================================================
  describe("getUserProfile", () => {
    const mockUserData = { id: testFixtures.user.id };
    const mockNotes = [
      { id: "note-1", content: "Test note", is_private: false },
    ];
    const mockHalqahs = [
      { id: "halqah-1", title: "Test halqah", status: "published" },
    ];
    const mockPosts = [
      { id: "post-1", title: "Test post", status: "published" },
    ];
    const mockEvents = [{ id: "event-1", title: "Test event" }];
    const mockPublication = {
      id: "pub-1",
      name: "Test Publication",
      user_id: mockUserData,
    };
    const mockStore = { slug: "test-store" };

    it("should return complete profile data", async () => {
      // Mock all required queries
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "users") return createMockQueryBuilder(mockUserData);
        if (table === "notes") return createMockQueryBuilder(mockNotes);
        if (table === "halqahs") return createMockQueryBuilder(mockHalqahs);
        if (table === "posts") return createMockQueryBuilder(mockPosts);
        if (table === "events") return createMockQueryBuilder(mockEvents);
        if (table === "publications")
          return createMockQueryBuilder(mockPublication);
        if (table === "subscriptions")
          return {
            ...createMockQueryBuilder(null),
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ count: 10, error: null }),
            }),
          };
        if (table === "stores") return createMockQueryBuilder(mockStore);
        if (table === "products")
          return {
            ...createMockQueryBuilder(null),
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ count: 5, error: null }),
            }),
          };
        return createMockQueryBuilder(null);
      });

      const result = await userService.getUserProfile(testFixtures.user.id);

      expect(result.notes).toEqual(mockNotes);
      expect(result.halqahs).toEqual(mockHalqahs);
      expect(result.posts).toEqual(mockPosts);
      expect(result.events).toEqual(mockEvents);
      expect(result.publication).toBeDefined();
      expect(result.store).toEqual(mockStore);
    });

    it("should return empty arrays when user has no content", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "users") return createMockQueryBuilder(mockUserData);
        if (table === "publications")
          return createMockQueryBuilder(null, { code: "PGRST116" });
        if (table === "stores")
          return createMockQueryBuilder(null, { code: "PGRST116" });
        if (table === "subscriptions" || table === "products")
          return {
            ...createMockQueryBuilder(null),
            select: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ count: 0, error: null }),
            }),
          };
        return createMockQueryBuilder([]);
      });

      const result = await userService.getUserProfile(testFixtures.user.id);

      expect(result.notes).toEqual([]);
      expect(result.halqahs).toEqual([]);
      expect(result.posts).toEqual([]);
      expect(result.events).toEqual([]);
      expect(result.publication).toBeNull();
      expect(result.store).toBeNull();
      expect(result.productsCount).toBe(0);
    });

    it("should throw 404 when user not found", async () => {
      mockSupabase.from.mockReturnValue(
        createMockQueryBuilder(null, {
          code: "PGRST116",
          message: "User not found",
        }),
      );

      await expect(
        userService.getUserProfile("non-existent-id"),
      ).rejects.toMatchObject({ message: "User not found", statusCode: 404 });
    });

    it("should throw error on database failure", async () => {
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === "users") return createMockQueryBuilder(mockUserData);
        // Simulate notes query failure
        return createMockQueryBuilder(null, { message: "Database error" });
      });

      await expect(
        userService.getUserProfile(testFixtures.user.id),
      ).rejects.toMatchObject({ message: "Database error" });
    });
  });
});
