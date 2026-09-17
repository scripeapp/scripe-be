import crypto from "crypto";
import { Response } from "express";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";
import { StoreService, PRODUCT_PUBLIC_COLUMNS } from "../services/store.service";
import { ApprovalWorkflowService } from "../services/approval-workflow.service";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";
import { AnalyticsService } from "../services/analytics.service";
import {
  Product,
  ModuleLinkType,
  ModifierGroupUpsert,
  ModifierOption,
} from "../types/store";
import type { ModuleLinkTypeValue } from "../types/store";
import { storeEmailService } from "../utils/storeEmails.util";
import { AvailabilityService } from "../services/availability.service";
import { BookingService } from "../services/booking.service";
import { moduleRegistryService } from "../services/module-registry.service";
import { DeliveryService } from "../services/delivery/delivery.service";
import { shipbubbleConfig } from "../config/shipbubble";
import { supabaseAdmin } from "../config/supabase";

/**
 * Store Controller
 * Class-based controller with descriptive method names
 * Follows established patterns with validation at route level
 */
class StoreController {
  // ============================================================================
  // Store Management
  // ============================================================================

  /**
   * Initialize a new store for the authenticated user
   * POST /api/store/init
   */
  async initializeStore(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { name, slug, registered_business_name } = req.body;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      const store = await service.initUserStore(
        req.user_id!,
        {
          name,
          slug,
          registered_business_name,
        },
        businessId,
      );

      return ApiResponse.created(res, "Store initialized successfully", store);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "INIT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get the active store within the current business context
   * GET /api/store/me
   */
  async getUserStore(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = req.businessId!;
      const service = new StoreService(req.supabase);
      const store = await service.loadStoreByQuery({
        userId: req.user_id!,
        requesterId: req.user_id!,
        businessId, // New filter
      });

      const resolvedStore = this.resolveStoreDetails(store);
      return ApiResponse.success(
        res,
        "Store loaded successfully",
        resolvedStore,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LOAD_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Save/update store settings
   * POST /api/store/save
   */
  async saveStore(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, ...updates } = req.body;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      const store = await service.saveUserStore(
        req.user_id!,
        store_id,
        updates,
        businessId,
      );

      return ApiResponse.success(res, "Store saved successfully", store);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "SAVE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Toggle store live status
   * PATCH /api/store/publish
   */
  async publishStore(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, is_live, slug } = req.body;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      const store = await service.setStorePublication(
        req.user_id!,
        store_id,
        {
          is_live,
          slug,
        },
        businessId,
      );

      return ApiResponse.success(res, "Store publication updated", store);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "PUBLISH_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Multi-Store Support
  // ============================================================================

  /**
   * List all stores for the current business
   * GET /api/store/list
   */
  async listUserStores(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = req.businessId!;
      if (!businessId) {
        return ApiResponse.badRequest(res, "Business context required");
      }

      const service = new StoreService(req.supabase);
      const stores = await service.getStoresByBusiness(businessId);

      return ApiResponse.success(res, "Stores retrieved successfully", stores);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LIST_STORES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get a specific store by ID within business context
   * GET /api/store/:storeId
   */
  async getStoreById(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { storeId } = req.params;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      const store = await service.getStoreById(storeId, businessId);

      const resolvedStore = this.resolveStoreDetails(store);
      return ApiResponse.success(
        res,
        "Store loaded successfully",
        resolvedStore,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_STORE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a new store for a business
   * POST /api/store/create
   */
  async createNewStore(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { name, slug, sells_in_person } = req.body;
      const businessId = req.businessId!;

      if (!businessId) {
        return ApiResponse.badRequest(res, "Business context required");
      }

      const service = new StoreService(req.supabase);
      const store = await service.createStore(req.user_id!, businessId, {
        name,
        slug,
        sells_in_person,
      });

      return ApiResponse.created(res, "Store created successfully", store);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_STORE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get store subaccount override settings
   * GET /api/store/subaccount?store_id=...
   */
  async getStoreSubaccount(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.query as { store_id: string };

      const service = new StoreService(req.supabase);
      const subaccount = await service.getStoreSubaccount(store_id);

      return ApiResponse.success(
        res,
        "Store subaccount retrieved successfully",
        subaccount,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_STORE_SUBACCOUNT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update store subaccount override settings (for franchises)
   * PATCH /api/store/subaccount
   */
  async updateStoreSubaccount(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, paystack_subaccount_code } = req.body;
      const businessId = req.businessId;

      const service = new StoreService(req.supabase);
      await service.updateStoreSubaccount(
        store_id,
        req.user_id!,
        {
          paystack_subaccount_code,
        },
        businessId,
      );

      return ApiResponse.success(
        res,
        "Store subaccount updated successfully",
        null,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_STORE_SUBACCOUNT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get store analytics (revenue, orders, customers, products)
   * GET /api/store/analytics?store_id=...
   */
  async getStoreAnalytics(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, branch_id } = req.query as {
        store_id: string;
        branch_id?: string;
      };
      const businessId = req.businessId!;

      if (!store_id) {
        return ApiResponse.badRequest(
          res,
          "store_id query parameter is required",
        );
      }

      const service = new StoreService(req.supabase);
      const analytics = await service.getStoreAnalytics(
        store_id,
        businessId,
        branch_id,
      );

      return ApiResponse.success(
        res,
        "Analytics retrieved successfully",
        analytics,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_ANALYTICS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get the POS overview (registers, open sessions, and sales analytics)
   * GET /api/store/pos/analytics?store_id=&range=30d
   */
  async getPosAnalytics(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, range } = req.query as {
        store_id: string;
        range?: string;
      };
      const businessId = req.businessId!;

      if (!store_id) {
        return ApiResponse.badRequest(
          res,
          "store_id query parameter is required",
        );
      }

      const service = new AnalyticsService(req.supabase);
      const analytics = await service.getPosOverview(
        store_id,
        businessId,
        (range as "7d" | "30d" | "all") || "30d",
      );

      return ApiResponse.success(res, "POS analytics retrieved", analytics);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_POS_ANALYTICS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get public store by slug
   * GET /api/store/public/:slug
   */
  async loadPublicStore(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;

      const service = new StoreService(req.supabase);
      const store = await service.loadStoreByQuery({ slug });

      if (store) {
        // Track store view (fire and forget)
        const analytics = new AnalyticsService(req.supabase);
        analytics
          .trackEvent({
            event_type: "page_view", // or "store_view" if preferred
            resource_id: store.id,
            resource_type: "store",
            store_id: store.id,
            business_id: store.business_id || undefined,
            metadata: {
              slug,
              visitor_ip:
                req.headers["x-forwarded-for"] || req.socket.remoteAddress,
              user_agent: req.headers["user-agent"],
              referer: req.headers["referer"],
              source: req.query.ref || req.query.source,
            },
          })
          .catch((err) => console.error("Auto-tracking error:", err));
      }

      if (!store) {
        return ApiResponse.notFound(res, "Store not found or not live");
      }

      // Get published products for this store
      const { data: products } = await req.supabase
        .from("products")
        .select("*")
        .eq("store_id", store.id)
        .eq("status", "published");

      // Resolve subaccount metadata with priority: Store -> Business fallback
      // (This logic is now centralized in resolveStoreDetails, called below)

      // Strip sensitive fields from products
      const safeProducts = (products || []).map((p: Product) =>
        service.transformToPublicProduct(p),
      );

      const resolvedStore = this.resolveStoreDetails(store);

      return ApiResponse.success(res, "Store loaded successfully", {
        ...resolvedStore,
        products: safeProducts,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LOAD_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get public order by payment reference
   * GET /api/store/public/order/:reference
   */
  async getPublicOrderByReference(req: any, res: Response): Promise<Response> {
    try {
      const { reference } = req.params;
      const { supabaseAdmin } = await import("../config/supabase");

      // Use supabaseAdmin to bypass RLS, ensuring we only return the exact matched order
      const { data: order, error } = await supabaseAdmin
        .from("store_orders")
        .select("*, store_id(slug, name, id, appearance)")
        .eq("payment_reference", reference)
        .limit(1)
        .maybeSingle();

      if (error || !order) {
        return ApiResponse.notFound(
          res,
          "Order not found or invalid reference",
        );
      }

      return ApiResponse.success(res, "Order retrieved successfully", {
        ...order,
        customer: {
          name: order.customer_name,
          email: order.customer_email,
          phone: order.customer_phone,
          address: order.customer_address,
        },
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LOAD_ORDER_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Product Management
  // ============================================================================

  /**
   * Add a new product
   * POST /api/store/product
   */
  async addProduct(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, product } = req.body;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      const newProduct = await service.addProduct(
        store_id,
        product,
        req.user_id!,
        businessId,
      );

      return ApiResponse.created(res, "Product added successfully", newProduct);
    } catch (err: any) {
      console.error("ADD_PRODUCT_ERROR:", err);
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "ADD_PRODUCT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update a product
   * PATCH /api/store/product
   */
  async updateProduct(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, product_id, updates } = req.body;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      const updatedProduct = await service.updateProduct(
        store_id,
        product_id,
        updates,
        req.user_id!,
        businessId,
      );

      return ApiResponse.success(
        res,
        "Product updated successfully",
        updatedProduct,
      );
    } catch (err: any) {
      console.error("UPDATE_PRODUCT_ERROR:", err);
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_PRODUCT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete a product
   * DELETE /api/store/product/:productId
   */
  async deleteProduct(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { productId } = req.params;
      const user_id = req.user_id;

      // Validate productId is provided
      if (!productId) {
        return res.status(400).json({
          success: false,
          error: "Product ID is missing",
        });
      }

      // Fetch product with store relationship to verify business scoping
      const { data: product, error: fetchError } = await req.supabase
        .from("products")
        .select("id, store_id, stores!inner(business_id)")
        .eq("id", productId)
        .single();

      // Product not found - return success (idempotent)
      if (fetchError || !product) {
        return res.status(200).json({
          success: true,
          message: "Product already deleted",
        });
      }

      // Verify business scoping: stores.business_id must match resolved businessId
      const storeBusinessId = (product as any).stores?.business_id;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      // Use service to delete, which also validates ownership
      await service.deleteProduct(
        product.store_id,
        productId,
        req.user_id!,
        businessId,
      );

      return res.status(200).json({
        success: true,
        message: "Product deleted successfully",
      });
    } catch (err: any) {
      console.error("Delete product error:", err);
      return res.status(500).json({
        success: false,
        error: "DELETE_PRODUCT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/store/products/:productId/release
   * Release a pre-order product: fulfils all waiting pre_order orders
   * and delivers download links to buyers.
   */
  async releasePreOrderProduct(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id } = req.body;
      const businessId = req.businessId;

      if (!productId || !store_id) {
        return res.status(400).json({
          success: false,
          error: "productId and store_id are required",
        });
      }

      const service = new StoreService(req.supabase);
      const result = await service.releasePreOrderProduct(
        store_id,
        productId,
        businessId,
      );

      const updatedCount = result.released_count + result.fulfilled_count;
      return res.status(200).json({
        success: true,
        message: `Pre-order released. ${updatedCount} order(s) updated.`,
        data: result,
      });
    } catch (err: any) {
      console.error("Release pre-order error:", err);
      return res.status(500).json({
        success: false,
        error: "RELEASE_PRE_ORDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * List all linkable items from a given module (or all modules) for the business.
   * GET /api/store/linkable-items?module_type=publication|form|event_type
   * If module_type is omitted, returns items grouped by all module types.
   */
  async getModuleLinkableItems(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const businessId = req.businessId;
      if (!businessId) {
        return ApiResponse.error(res, "Business context required", 400);
      }

      const moduleType = req.query.module_type as string | undefined;

      if (moduleType) {
        // Validate module type
        const validTypes = Object.values(ModuleLinkType);
        if (!validTypes.includes(moduleType as ModuleLinkTypeValue)) {
          return ApiResponse.error(
            res,
            `Invalid module_type. Must be one of: ${validTypes.join(", ")}`,
            400,
          );
        }

        const items = await moduleRegistryService.listForBusiness(
          req.supabase,
          moduleType as ModuleLinkTypeValue,
          businessId,
        );

        return ApiResponse.success(res, "Linkable items fetched", items);
      }

      // No filter — return all module types grouped
      const allItems = await moduleRegistryService.listAllForBusiness(
        req.supabase,
        businessId,
      );

      return ApiResponse.success(res, "All linkable items fetched", allItems);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("getModuleLinkableItems error:", message);
      return ApiResponse.error(res, message, 500);
    }
  }

  /**
   * Get public product details
   * GET /api/store/public/:slug/product/:productId
   */
  async loadPublicProduct(req: any, res: Response): Promise<Response> {
    try {
      const { slug, productId } = req.params;
      const branchId = (req.query.branch_id as string) || undefined;

      const service = new StoreService(req.supabase);
      const result = await service.getPublicProduct(slug, productId, branchId);

      if (result && result.product) {
        // Auto-track product view
        const analytics = new AnalyticsService(req.supabase);
        const storeId = result.store?.id;
        const businessId = result.store?.business_id || undefined;

        if (storeId) {
          analytics
            .trackEvent({
              event_type: "product_view",
              resource_id: result.product.id,
              resource_type: "product",
              store_id: storeId,
              business_id: businessId,
              metadata: {
                slug,
                product_name: result.product.name,
                visitor_ip:
                  req.headers["x-forwarded-for"] || req.socket.remoteAddress,
                user_agent: req.headers["user-agent"],
                referer: req.headers["referer"],
                source: req.query.ref || req.query.source,
              },
            })
            .catch((err) => console.error("Auto-tracking product error:", err));
        }
      }

      return ApiResponse.success(res, "Product loaded successfully", result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LOAD_PRODUCT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get all published products for a public store
   * GET /api/store/public/:slug/products
   */
  async loadPublicProducts(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const rawPage = parseInt(req.query.page as string, 10);
      const rawLimit = parseInt(req.query.limit as string, 10);
      const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;

      // Verify store exists and is live
      const { data: store, error: storeError } = await req.supabase
        .from("stores")
        .select("id, name, slug, is_live")
        .eq("slug", slug)
        .eq("is_live", true)
        .single();

      if (storeError || !store) {
        return res.status(404).json({
          success: false,
          error: "Store not found or not live",
        });
      }

      // Fetch published products
      const offset = (page - 1) * limit;
      const {
        data: products,
        error: productsError,
        count,
      } = await req.supabase
        .from("products")
        .select(PRODUCT_PUBLIC_COLUMNS as "*", { count: "exact" })
        .eq("store_id", store.id)
        .eq("status", "published")
        .range(offset, offset + limit - 1)
        .order("created_at", { ascending: false });

      if (productsError) {
        throw productsError;
      }

      const service = new StoreService(req.supabase);
      const branchId = (req.query.branch_id as string) || undefined;
      const branchFilteredProducts = await service.applyBranchOverrides<Product>(
        products || [],
        branchId,
      );

      // category_ids isn't a column on products — batch-attach it the same
      // way the merchant listing does, so category filtering (e.g. the /pos
      // menu grid) works off this public endpoint too.
      const productIds = branchFilteredProducts.map((p: any) => p.id);
      let categoryIdsByProduct: Record<string, string[]> = {};
      if (productIds.length > 0) {
        const { data: categoryLinks } = await req.supabase
          .from("product_categories")
          .select("product_id, category_id")
          .in("product_id", productIds);
        (categoryLinks || []).forEach((link: any) => {
          if (!categoryIdsByProduct[link.product_id]) {
            categoryIdsByProduct[link.product_id] = [];
          }
          categoryIdsByProduct[link.product_id].push(link.category_id);
        });
      }

      const safeProducts = branchFilteredProducts.map((p: Product) =>
        service.transformToPublicProduct({
          ...p,
          category_ids: categoryIdsByProduct[p.id] || [],
        }),
      );

      return res.status(200).json({
        success: true,
        data: {
          store: {
            id: store.id,
            name: store.name,
            slug: store.slug,
          },
          products: safeProducts,
          meta: {
            total: count || 0,
            page,
            limit,
            totalPages: Math.ceil((count || 0) / limit),
          },
        },
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LOAD_PRODUCTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get public reviews for a store
   * GET /api/store/public/:slug/reviews
   */
  async getPublicReviews(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const { product_id, page, limit } = req.query;

      const service = new StoreService(req.supabase);
      const result = await service.getPublicStoreReviews(slug, {
        product_id: product_id as string,
        page: page ? parseInt(page as string) : undefined,
        limit: limit ? parseInt(limit as string) : undefined,
      });

      return ApiResponse.success(res, "Reviews loaded successfully", result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LOAD_REVIEWS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Submit a review (public)
   * POST /api/store/public/:slug/reviews
   */
  async submitReview(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const data = req.body;

      const service = new StoreService(req.supabase);
      await service.submitStoreReview(slug, data);

      return ApiResponse.success(res, "Review submitted successfully");
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "SUBMIT_REVIEW_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get store products
   * GET /api/store/product
   */
  async getProducts(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { page, limit, status, search, store_id, category_id, menu_id, uncategorized } =
        req.query as any;

      const service = new StoreService(req.supabase);
      const result = await service.getStoreProducts(store_id, {
        page: parseInt(page),
        limit: parseInt(limit),
        status,
        search,
        category_id,
        menu_id,
        uncategorized: uncategorized === "true",
      });

      return ApiResponse.success(
        res,
        "Products retrieved successfully",
        result,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PRODUCTS_ERROR",
        message: err.message,
      });
    }
  }

  async listSuppliers(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, active_only } = req.query as {
        store_id: string;
        active_only?: "true" | "false";
      };
      const suppliers = await new StoreService(req.supabase).listSuppliers(
        store_id,
        active_only === "true",
      );
      return ApiResponse.success(res, "Suppliers retrieved successfully", suppliers);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  async createSupplier(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, ...payload } = req.body;
      const supplier = await new StoreService(req.supabase).createSupplier(store_id, payload);
      return ApiResponse.success(res, "Supplier created successfully", supplier);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  async updateSupplier(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id, ...payload } = req.body;
      const supplier = await new StoreService(req.supabase).updateSupplier(
        store_id,
        supplierId,
        payload,
      );
      return ApiResponse.success(res, "Supplier updated successfully", supplier);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  async deleteSupplier(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id } = req.query as { store_id: string };
      await new StoreService(req.supabase).deleteSupplier(store_id, supplierId);
      return ApiResponse.success(res, "Supplier deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({ success: false, message: err.message });
    }
  }

  async getSupplierDashboard(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id } = req.query as { store_id: string };
      const dashboard = await new StoreService(req.supabase).getSupplierDashboard(store_id, supplierId);
      return ApiResponse.success(res, "Supplier dashboard retrieved successfully", dashboard);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  async createSupplierProduct(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id, ...payload } = req.body;
      const mapping = await new StoreService(req.supabase).createSupplierProduct(
        store_id,
        supplierId,
        payload,
      );
      return ApiResponse.created(res, "Supplier product linked successfully", mapping);
    } catch (error: unknown) {
      const err = error as { statusCode?: number; message?: string };
      return res.status(err.statusCode ?? 500).json({ success: false, message: err.message ?? "Could not link supplier product" });
    }
  }

  async updateSupplierProduct(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId, supplierProductId } = req.params;
      const { store_id, ...payload } = req.body;
      const mapping = await new StoreService(req.supabase).updateSupplierProduct(
        store_id,
        supplierId,
        supplierProductId,
        payload,
      );
      return ApiResponse.success(res, "Supplier product updated successfully", mapping);
    } catch (error: unknown) {
      const err = error as { statusCode?: number; message?: string };
      return res.status(err.statusCode ?? 500).json({ success: false, message: err.message ?? "Could not update supplier product" });
    }
  }

  async deleteSupplierProduct(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId, supplierProductId } = req.params;
      const { store_id } = req.query as { store_id: string };
      await new StoreService(req.supabase).deleteSupplierProduct(store_id, supplierId, supplierProductId);
      return ApiResponse.success(res, "Supplier product removed successfully", null);
    } catch (error: unknown) {
      const err = error as { statusCode?: number; message?: string };
      return res.status(err.statusCode ?? 500).json({ success: false, message: err.message ?? "Could not remove supplier product" });
    }
  }

  async listStockReceipts(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id, page, page_size } = req.query as unknown as {
        store_id: string;
        page: number;
        page_size: number;
      };
      const result = await new StoreService(req.supabase).listStockReceipts(
        store_id,
        supplierId,
        page,
        page_size,
      );
      return ApiResponse.success(res, "Stock receipts retrieved successfully", result);
    } catch (error: unknown) {
      const err = error as { message?: string };
      return ApiResponse.serverError(res, err.message ?? "Could not retrieve stock receipts");
    }
  }

  async createStockReceipt(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id, ...payload } = req.body;
      const receipt = await new StoreService(req.supabase).createStockReceipt(
        store_id,
        supplierId,
        payload,
        req.user_id!,
      );
      return ApiResponse.created(res, "Stock receipt completed successfully", receipt);
    } catch (error: unknown) {
      const err = error as { statusCode?: number; message?: string };
      return res.status(err.statusCode ?? 500).json({ success: false, message: err.message ?? "Could not complete stock receipt" });
    }
  }

  async createPurchaseOrder(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, ...payload } = req.body;
      const order = await new StoreService(req.supabase).createPurchaseOrder(store_id, payload, req.user_id!);
      return ApiResponse.created(res, "Purchase order created successfully", order);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "CREATE_PURCHASE_ORDER_ERROR", message: err.message });
    }
  }

  async listPurchaseOrders(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, status, page, page_size } = req.query as { store_id: string; status?: string; page?: string; page_size?: string };
      const orders = await new StoreService(req.supabase).listPurchaseOrders(store_id, status, page ? parseInt(page, 10) : 1, page_size ? parseInt(page_size, 10) : 20);
      return ApiResponse.success(res, "Purchase orders retrieved successfully", orders);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  async getPurchaseOrder(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id } = req.query as { store_id: string };
      const order = await new StoreService(req.supabase).getPurchaseOrder(store_id, req.params.purchaseOrderId);
      return ApiResponse.success(res, "Purchase order retrieved successfully", order);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "GET_PURCHASE_ORDER_ERROR", message: err.message });
    }
  }

  async updatePurchaseOrder(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, ...updates } = req.body;
      const order = await new StoreService(req.supabase).updatePurchaseOrder(store_id, req.params.purchaseOrderId, updates);
      return ApiResponse.success(res, "Purchase order updated successfully", order);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "UPDATE_PURCHASE_ORDER_ERROR", message: err.message });
    }
  }

  async sendPurchaseOrder(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id } = req.body;
      const order = await new StoreService(req.supabase).sendPurchaseOrder(store_id, req.params.purchaseOrderId);
      return ApiResponse.success(res, "Purchase order sent to supplier", order);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "SEND_PURCHASE_ORDER_ERROR", message: err.message });
    }
  }

  async createSupplierBill(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id, ...payload } = req.body;
      const bill = await new StoreService(req.supabase).createSupplierBill(store_id, supplierId, payload, req.user_id!);
      return ApiResponse.success(res, "Supplier bill created successfully", bill);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "CREATE_SUPPLIER_BILL_ERROR", message: err.message });
    }
  }

  async updateSupplierBill(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId, billId } = req.params;
      const { store_id, status } = req.body;
      const bill = await new StoreService(req.supabase).updateSupplierBillStatus(store_id, supplierId, billId, status);
      return ApiResponse.success(res, "Supplier bill updated successfully", bill);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "UPDATE_SUPPLIER_BILL_ERROR", message: err.message });
    }
  }

  async listSupplierBills(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id, page, page_size } = req.query as { store_id: string; page?: string; page_size?: string };
      const result = await new StoreService(req.supabase).listSupplierBills(
        store_id,
        supplierId,
        page ? parseInt(page, 10) : 1,
        page_size ? parseInt(page_size, 10) : 20,
      );
      return ApiResponse.success(res, "Supplier bills retrieved successfully", result);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  async getSupplierBillItems(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId, billId } = req.params;
      const { store_id } = req.query as { store_id: string };
      const items = await new StoreService(req.supabase).getSupplierBillItems(store_id, supplierId, billId);
      return ApiResponse.success(res, "Bill line items retrieved successfully", items);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "GET_BILL_ITEMS_ERROR", message: err.message });
    }
  }

  async addSupplierBillItem(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId, billId } = req.params;
      const { store_id, ...payload } = req.body;
      const item = await new StoreService(req.supabase).addSupplierBillItem(store_id, supplierId, billId, payload);
      return ApiResponse.created(res, "Bill line item added successfully", item);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "ADD_BILL_ITEM_ERROR", message: err.message });
    }
  }

  async listSupplierPayments(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id, page, page_size } = req.query as { store_id: string; page?: string; page_size?: string };
      const result = await new StoreService(req.supabase).listSupplierPayments(
        store_id,
        supplierId,
        page ? parseInt(page, 10) : 1,
        page_size ? parseInt(page_size, 10) : 20,
      );
      return ApiResponse.success(res, "Supplier payments retrieved successfully", result);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }

  async createSupplierPayment(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { supplierId } = req.params;
      const { store_id, ...payload } = req.body;
      const payment = await new StoreService(req.supabase).createSupplierPayment(store_id, supplierId, payload, req.user_id!);
      return ApiResponse.created(res, "Supplier payment recorded successfully", payment);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "CREATE_SUPPLIER_PAYMENT_ERROR", message: err.message });
    }
  }

  // Store-wide bills dashboard (Payments > Bill pay) — see StoreService for
  // how this differs from the supplier-scoped bill endpoints above.

  async listBills(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, status, category, supplier_id, search, page, page_size } = req.query as {
        store_id: string; status?: string; category?: string; supplier_id?: string; search?: string; page?: string; page_size?: string;
      };
      const result = await new StoreService(req.supabase).listBills(store_id, {
        status,
        category,
        supplier_id,
        search,
        page: page ? parseInt(page, 10) : 1,
        page_size: page_size ? parseInt(page_size, 10) : 20,
      });
      return ApiResponse.success(res, "Bills retrieved successfully", result);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "LIST_BILLS_ERROR", message: err.message });
    }
  }

  async getBillMetrics(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id } = req.query as { store_id: string };
      const metrics = await new StoreService(req.supabase).getBillMetrics(store_id);
      return ApiResponse.success(res, "Bill metrics retrieved successfully", metrics);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "BILL_METRICS_ERROR", message: err.message });
    }
  }

  async getBill(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { billId } = req.params;
      const { store_id } = req.query as { store_id: string };
      const bill = await new StoreService(req.supabase).getBillById(store_id, billId);
      return ApiResponse.success(res, "Bill retrieved successfully", bill);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "GET_BILL_ERROR", message: err.message });
    }
  }

  async createBill(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, ...payload } = req.body;
      const bill = await new StoreService(req.supabase).createBillWithItems(store_id, payload, req.user_id!);

      // A submitted (not draft) bill is gated against the business's active
      // Bills/All approval workflow, if one exists.
      let gated = false;
      if (bill.status === "pending" && req.businessId) {
        try {
          const gateResult = await new ApprovalWorkflowService(req.supabase).gateSubmission(req.businessId, {
            subjectType: "bill",
            subjectId: bill.id,
            amount: Number(bill.amount),
            subjectLabel: `Bill ${bill.bill_number}`,
            requestedBy: req.user_id!,
            requestedByEmail: req.user?.email ?? null,
          });
          gated = gateResult.gated;
        } catch (gateError) {
          // The bill row already exists at this point — no cross-table
          // transaction is available here — so a blocking gate error (e.g.
          // a step with zero eligible approvers) must undo it rather than
          // leaving an orphaned, untracked "pending" bill behind a failed
          // response the caller believes never took effect.
          try {
            await req.supabase.from("supplier_bills").delete().eq("id", bill.id);
          } catch {
            // best-effort cleanup; the gating error still surfaces below
          }
          throw gateError;
        }
      }

      return ApiResponse.created(res, "Bill created successfully", { ...bill, approval_gated: gated });
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "CREATE_BILL_ERROR", message: err.message });
    }
  }

  async deleteBill(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { billId } = req.params;
      const { store_id } = req.query as { store_id: string };
      await new StoreService(req.supabase).deleteBill(store_id, billId);
      return ApiResponse.success(res, "Bill deleted successfully", null);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "DELETE_BILL_ERROR", message: err.message });
    }
  }

  async approveBill(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { billId } = req.params;
      const { store_id } = req.body;
      if (req.businessId && await new ApprovalWorkflowService(req.supabase).getPendingApprovalRequest(req.businessId, "bill", billId)) {
        return res.status(409).json({
          success: false,
          error: "APPROVE_BILL_ERROR",
          message: "This bill requires multi-step approval — use the approvals inbox instead",
        });
      }
      const bill = await new StoreService(req.supabase).approveBill(store_id, billId);
      return ApiResponse.success(res, "Bill approved", bill);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "APPROVE_BILL_ERROR", message: err.message });
    }
  }

  async getBillApprovalRequest(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { billId } = req.params;
      if (!req.businessId) {
        return res.status(400).json({ success: false, error: "GET_BILL_APPROVAL_REQUEST_ERROR", message: "Business context required" });
      }
      const request = await new ApprovalWorkflowService(req.supabase).getRequestForSubject(req.businessId, "bill", billId);
      return ApiResponse.success(res, "Bill approval request retrieved", request);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "GET_BILL_APPROVAL_REQUEST_ERROR", message: err.message });
    }
  }

  async payBill(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { billId } = req.params;
      const { store_id } = req.body;
      if (!req.businessId) {
        return res.status(400).json({ success: false, error: "PAY_BILL_ERROR", message: "Business context required" });
      }
      const result = await new StoreService(req.supabase).confirmBillPayment(
        store_id,
        req.businessId,
        billId,
        req.user_id!,
        req.user?.email ?? null,
      );
      return ApiResponse.created(
        res,
        result.gated ? "Payment submitted for transfer approval" : "Payment sent",
        result,
      );
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "PAY_BILL_ERROR", message: err.message });
    }
  }

  async rejectBill(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { billId } = req.params;
      const { store_id, reason } = req.body;
      if (req.businessId && await new ApprovalWorkflowService(req.supabase).getPendingApprovalRequest(req.businessId, "bill", billId)) {
        return res.status(409).json({
          success: false,
          error: "REJECT_BILL_ERROR",
          message: "This bill requires multi-step approval — use the approvals inbox instead",
        });
      }
      const bill = await new StoreService(req.supabase).rejectBill(store_id, billId, reason);
      return ApiResponse.success(res, "Bill rejected", bill);
    } catch (err: any) {
      return res.status(err?.statusCode || 500).json({ success: false, error: "REJECT_BILL_ERROR", message: err.message });
    }
  }

  /**
   * Get single product details
   * GET /api/store/product/:productId
   */
  async getProduct(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const product = await service.getStoreProduct(
        store_id,
        productId,
        req.businessId,
      );

      return ApiResponse.success(
        res,
        "Product retrieved successfully",
        product,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PRODUCT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get the compact management read model used by product details.
   * GET /api/store/product/:productId/dashboard
   */
  async getProductDashboard(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id } = req.query as { store_id: string };
      const service = new StoreService(req.supabase);
      const dashboard = await service.getProductDashboard(
        store_id,
        productId,
        req.businessId,
      );

      return ApiResponse.success(
        res,
        "Product dashboard retrieved successfully",
        dashboard,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PRODUCT_DASHBOARD_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get user's downloadable products
   * GET /api/store/downloads/my
   */
  async getUserDownloads(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { DigitalProductService } =
        await import("../services/digital-product.service");
      const service = new DigitalProductService(req.supabase);

      const downloads = await service.getUserDownloads(req.user_id!);

      return ApiResponse.success(
        res,
        "Downloads retrieved successfully",
        downloads,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_DOWNLOADS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Generate download link (authenticated or public with order verification)
   * POST /api/store/downloads/generate/:productId
   */
  async generateDownloadLink(req: any, res: Response): Promise<Response> {
    try {
      const { productId } = req.params;
      const { order_id } = req.body; // Expect order_id in body for verification

      const { DigitalProductService } =
        await import("../services/digital-product.service");
      // Use auth supabase if available, or public client
      const supabaseClient = (req as any).supabase || req.supabase;
      const userId = (req as any).user_id;

      const service = new DigitalProductService(supabaseClient);
      const result = await service.getDownloadUrl(
        order_id,
        productId,
        userId,
        req.ip,
      );

      return ApiResponse.success(res, "Download link generated", result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GENERATE_LINK_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Inventory Management
  // ============================================================================

  /**
   * Get stock movements log
   * GET /api/store/inventory/movements
   */
  /**
   * Flat inventory view — physical products with variants and per-branch
   * balances. Replaces paging the whole product catalogue to get physical
   * items.
   * GET /api/store/inventory/products
   */
  async getInventoryProducts(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, page, page_size, search } = req.query as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const result = await service.getInventoryProducts(store_id, {
        ...(page ? { page: parseInt(page) } : {}),
        ...(page_size ? { pageSize: parseInt(page_size) } : {}),
        ...(search ? { search } : {}),
      });
      return ApiResponse.success(res, "Inventory products retrieved", result);
    } catch (err: any) {
      console.error("Inventory products error:", err);
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_INVENTORY_PRODUCTS_ERROR",
        message: err.message,
      });
    }
  }

  async getInventoryMovements(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, page, page_size, product_id, exclude_reasons } =
        req.query as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const { movements, total } = await service.getStockMovements(store_id, {
        ...(page ? { page: parseInt(page) } : {}),
        ...(page_size ? { pageSize: parseInt(page_size) } : {}),
        ...(product_id ? { productId: product_id } : {}),
        ...(exclude_reasons
          ? { excludeReasons: String(exclude_reasons).split(",") }
          : {}),
      });

      return ApiResponse.success(
        res,
        "Stock movements retrieved",
        { movements, total },
      );
    } catch (err: any) {
      console.error("Inventory log error:", err);
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "INVENTORY_LOG_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Helper to resolve store details with business fallback
   */
  private resolveStoreDetails(store: any) {
    if (!store) return null;

    const resolvedSubaccount =
      store.paystack_subaccount_code ||
      store.business?.paystack_subaccount_code;

    // Fee bearer is configured only at the business level; default is 'subaccount'
    const resolvedFeeBearer =
      store.business?.paystack_fee_bearer || "subaccount";

    return {
      ...store,
      paystack_subaccount_code: resolvedSubaccount,
      paystack_fee_bearer: resolvedFeeBearer,
    };
  }

  /**
   * Bulk update inventory
   * POST /api/store/inventory/update
   */
  async updateInventory(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, updates } = req.body;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      await service.bulkUpdateStock(store_id, updates, req.user_id!);

      return ApiResponse.success(res, "Inventory updated successfully");
    } catch (err: any) {
      console.error("[updateInventory]", {
        message: err?.message,
        details: err?.details,
        hint: err?.hint,
        code: err?.code,
      });
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_INVENTORY_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Stock transfers (branch → branch)
  // ============================================================================

  /** Create a draft transfer. POST /api/store/inventory/transfers */
  async createTransfer(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, ...input } = req.body;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const transfer = await service.createStockTransfer(store_id, input);
      return ApiResponse.created(res, "Transfer created", transfer);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_TRANSFER_ERROR",
        message: err.message,
      });
    }
  }

  /** List transfers for a store. GET /api/store/inventory/transfers */
  async listTransfers(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, page, page_size } = req.query as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const data = await service.listStockTransfers(
        store_id,
        page ? parseInt(page) : 1,
        page_size ? parseInt(page_size) : 10,
      );
      return ApiResponse.success(res, "Transfers retrieved", data);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LIST_TRANSFERS_ERROR",
        message: err.message,
      });
    }
  }

  /** Get a single transfer with its lines. GET /api/store/inventory/transfers/:id */
  async getTransfer(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.query as any;
      const { id } = req.params as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const data = await service.getStockTransfer(store_id, id);
      return ApiResponse.success(res, "Transfer retrieved", data);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_TRANSFER_ERROR",
        message: err.message,
      });
    }
  }

  /** Dispatch a draft transfer. POST /api/store/inventory/transfers/:id/send */
  async sendTransfer(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.body;
      const { id } = req.params as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      await service.sendStockTransfer(store_id, id, req.user_id!);
      return ApiResponse.success(res, "Transfer sent");
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "SEND_TRANSFER_ERROR",
        message: err.message,
      });
    }
  }

  /** Accept an in-transit transfer. POST /api/store/inventory/transfers/:id/receive */
  async receiveTransfer(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, lines } = req.body;
      const { id } = req.params as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      await service.receiveStockTransfer(store_id, id, lines, req.user_id!);
      return ApiResponse.success(res, "Transfer received");
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "RECEIVE_TRANSFER_ERROR",
        message: err.message,
      });
    }
  }

  /** Cancel a transfer. POST /api/store/inventory/transfers/:id/cancel */
  async cancelTransfer(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.body;
      const { id } = req.params as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      await service.cancelStockTransfer(store_id, id, req.user_id!);
      return ApiResponse.success(res, "Transfer cancelled");
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CANCEL_TRANSFER_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Stock counts (cycle counts)
  // ============================================================================

  /** Create a draft stock count. POST /api/store/inventory/stock-counts */
  async createStockCount(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, ...input } = req.body;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const count = await service.createStockCount(store_id, input, req.user_id!);
      return ApiResponse.created(res, "Stock count created", count);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_STOCK_COUNT_ERROR",
        message: err.message,
      });
    }
  }

  /** List stock counts for a store. GET /api/store/inventory/stock-counts */
  async listStockCounts(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, page, page_size } = req.query as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const data = await service.listStockCounts(
        store_id,
        page ? parseInt(page) : 1,
        page_size ? parseInt(page_size) : 10,
      );
      return ApiResponse.success(res, "Stock counts retrieved", data);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LIST_STOCK_COUNTS_ERROR",
        message: err.message,
      });
    }
  }

  /** Get a single count with its lines. GET /api/store/inventory/stock-counts/:id */
  async getStockCount(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.query as any;
      const { id } = req.params as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const data = await service.getStockCount(store_id, id);
      return ApiResponse.success(res, "Stock count retrieved", data);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_STOCK_COUNT_ERROR",
        message: err.message,
      });
    }
  }

  /** Add a line to an in-progress count. POST /api/store/inventory/stock-counts/:id/lines */
  async addStockCountLine(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, ...input } = req.body;
      const { id } = req.params as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      await service.addStockCountLine(store_id, id, input);
      return ApiResponse.success(res, "Line added to stock count");
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "ADD_STOCK_COUNT_LINE_ERROR",
        message: err.message,
      });
    }
  }

  /** Apply a draft count (writes variances to stock). POST /api/store/inventory/stock-counts/:id/apply */
  async applyStockCount(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.body;
      const { id } = req.params as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      await service.applyStockCount(store_id, id, req.user_id!);
      return ApiResponse.success(res, "Stock count applied");
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "APPLY_STOCK_COUNT_ERROR",
        message: err.message,
      });
    }
  }

  /** Discard an in-progress count. POST /api/store/inventory/stock-counts/:id/cancel */
  async cancelStockCount(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.body;
      const { id } = req.params as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      await service.cancelStockCount(store_id, id);
      return ApiResponse.success(res, "Stock count discarded");
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CANCEL_STOCK_COUNT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get low stock products
   * GET /api/store/inventory/low-stock
   */
  async getLowStockProducts(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, limit, threshold } = req.query as any;
      const businessId = req.businessId!;

      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId);

      const products = await service.getLowStockProducts(
        store_id,
        limit ? parseInt(limit) : 10,
        threshold ? parseInt(threshold) : 5,
      );

      return ApiResponse.success(res, "Low stock products retrieved", products);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_LOW_STOCK_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create an order after payment
   * POST /api/store/order/create
   */
  async createOrder(req: any, res: Response): Promise<Response> {
    try {
      const { store_id, payment_reference, customer, items, discount_code } =
        req.body;

      const service = new StoreService(req.supabase);
      const result = await service.createOrder({
        store_id,
        payment_reference,
        customer,
        items,
        discount_code,
      });

      return ApiResponse.created(res, "Order created successfully", result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_ORDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * List registers for a store, optionally filtered by branch/status.
   * GET /api/store/registers?store_id=&branch_id=&status=
   */
  async listRegisters(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, branch_id, status } = req.query as {
        store_id: string;
        branch_id?: string;
        status?: "active" | "inactive";
      };
      const service = new StoreService(req.supabase);
      const registers = await service.listRegisters(store_id, { branch_id, status });
      return ApiResponse.success(res, "Registers retrieved", registers);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LIST_REGISTERS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a named register for a store.
   * POST /api/store/registers
   */
  async createRegister(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, name, branch_id, device_type } = req.body;
      const service = new StoreService(req.supabase);
      const register = await service.createRegister(
        store_id,
        { name, branch_id, device_type },
        req.user_id!,
      );
      return ApiResponse.created(res, "Register created", register);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_REGISTER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update a register (rename, reassign branch, change device type/status).
   * PATCH /api/store/registers/:registerId
   */
  async updateRegister(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { registerId } = req.params;
      const service = new StoreService(req.supabase);
      const register = await service.updateRegister(registerId, req.body);
      return ApiResponse.success(res, "Register updated", register);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_REGISTER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete a register (blocked while it has an open shift).
   * DELETE /api/store/registers/:registerId
   */
  async deleteRegister(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { registerId } = req.params;
      const service = new StoreService(req.supabase);
      await service.deleteRegister(registerId);
      return ApiResponse.success(res, "Register deleted", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_REGISTER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Generate a one-time pairing code for a register (merchant dashboard) —
   * the cashier reads it off this screen and types it into /pos to link
   * that device to this register.
   * POST /api/store/registers/:registerId/pairing-code
   */
  async generateRegisterPairingCode(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { registerId } = req.params;
      // supabaseAdmin: RLS blocks the hash write on the user-scoped client.
      const service = new StoreService(supabaseAdmin);
      const { code, expiresAt } = await service.generateRegisterPairingCode(registerId);
      return ApiResponse.success(res, "Pairing code generated", {
        code,
        expires_at: expiresAt,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GENERATE_PAIRING_CODE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Revoke a paired device's access — it must be re-paired with a new code.
   * POST /api/store/registers/:registerId/unpair
   */
  async unpairRegisterDevice(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { registerId } = req.params;
      const service = new StoreService(req.supabase);
      const register = await service.unpairRegisterDevice(registerId);
      return ApiResponse.success(res, "Device unpaired", register);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UNPAIR_REGISTER_DEVICE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * List staff PINs for a store (never returns pin_hash).
   * GET /api/store/pos-staff?store_id=
   */
  async listPosStaff(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.query as { store_id: string };
      const service = new StoreService(req.supabase);
      const staff = await service.listPosStaff(store_id);
      return ApiResponse.success(res, "Staff retrieved", staff);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LIST_POS_STAFF_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a staff PIN.
   * POST /api/store/pos-staff
   */
  async createPosStaff(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, name, pin, user_id, branch_id } = req.body;
      const service = new StoreService(req.supabase);
      const staff = await service.createPosStaff(
        store_id,
        { name, pin, user_id, branch_id },
        req.user_id!,
      );
      return ApiResponse.created(res, "Staff added", staff);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_POS_STAFF_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update a staff member (rename, reset PIN, activate/deactivate).
   * PATCH /api/store/pos-staff/:staffId
   */
  async updatePosStaff(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { staffId } = req.params;
      const service = new StoreService(req.supabase);
      const staff = await service.updatePosStaff(staffId, req.body);
      return ApiResponse.success(res, "Staff updated", staff);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_POS_STAFF_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete a staff member.
   * DELETE /api/store/pos-staff/:staffId
   */
  async deletePosStaff(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { staffId } = req.params;
      const service = new StoreService(req.supabase);
      await service.deletePosStaff(staffId);
      return ApiResponse.success(res, "Staff removed", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_POS_STAFF_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Resolve a PIN to a staff member — device-auth only, scoped to the
   * paired device's own store.
   * POST /api/store/pos/staff/verify-pin
   */
  async verifyPosStaffPin(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      if (!req.deviceRegister) {
        return res.status(401).json({
          success: false,
          error: "UNAUTHENTICATED",
          message: "No paired device found",
        });
      }
      const { pin, expected_staff_id } = req.body;
      const service = new StoreService(supabaseAdmin);
      const staff = await service.verifyPosStaffPin(
        req.deviceRegister.store_id,
        pin,
        req.deviceRegister.branch_id,
        expected_staff_id,
      );
      if (!staff) {
        return res.status(401).json({
          success: false,
          error: "INVALID_PIN",
          message: "That PIN doesn't match any active staff member.",
        });
      }
      return ApiResponse.success(res, "PIN verified", staff);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "VERIFY_POS_STAFF_PIN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Exchange a one-time pairing code for a long-lived device token — no
   * dashboard login involved, this is what /pos calls the first time a
   * cashier's device connects.
   * POST /api/store/pos/pair
   */
  async pairRegisterDevice(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { pairing_code } = req.body;
      const service = new StoreService(supabaseAdmin);
      const { deviceToken, register } = await service.pairRegisterDevice(pairing_code);
      return ApiResponse.success(res, "Register paired", {
        device_token: deviceToken,
        register,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "PAIR_REGISTER_DEVICE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * A paired device's session context — store/branch/register basics the
   * /pos screen needs to render its top bar, without any dashboard login.
   * GET /api/store/pos/session
   */
  async getPosSession(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      if (!req.deviceRegister) {
        return res.status(401).json({
          success: false,
          error: "UNAUTHENTICATED",
          message: "No paired device found",
        });
      }
      const service = new StoreService(supabaseAdmin);
      const register = await service.getRegisterByDeviceToken(
        req.headers["x-register-device-token"] as string,
      );
      return ApiResponse.success(res, "Session retrieved", register);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_POS_SESSION_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Open a register shift for a named register, with a starting cash float.
   * POST /api/store/register/shift/open
   */
  async openRegisterShift(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { register_id, starting_float, staff_id } = req.body;
      const service = new StoreService(req.supabase);
      const shift = await service.openRegisterShift(
        register_id,
        req.user_id || null,
        starting_float,
        staff_id,
      );
      return ApiResponse.created(res, "Register shift opened", shift);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "OPEN_REGISTER_SHIFT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Close an open register shift, reconciling counted vs. expected cash.
   * POST /api/store/register/shift/close
   */
  async closeRegisterShift(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { shift_id, counted_cash, notes, staff_id } = req.body;
      const service = new StoreService(req.supabase);
      const shift = await service.closeRegisterShift(
        shift_id,
        req.user_id || null,
        counted_cash,
        notes,
        req.deviceRegister?.id,
        staff_id,
      );
      return ApiResponse.success(res, "Register shift closed", shift);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CLOSE_REGISTER_SHIFT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * The register's currently-open shift, if any.
   * GET /api/store/register/shift/current?register_id=
   */
  async getCurrentRegisterShift(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { register_id } = req.query as { register_id: string };
      const service = new StoreService(req.supabase);
      const shift = await service.getOpenRegisterShift(register_id);
      return ApiResponse.success(res, "Current register shift retrieved", shift);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CURRENT_REGISTER_SHIFT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Float, cash sales so far, and expected cash for an open shift — the
   * close-register modal calls this when it opens so a cashier can see
   * what they're reconciling against before typing in a counted-cash
   * number.
   * GET /api/store/register/shift/:shiftId/summary
   */
  async getRegisterShiftSummary(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { shiftId } = req.params as { shiftId: string };
      const service = new StoreService(req.supabase);
      const summary = await service.getRegisterShiftSummary(
        shiftId,
        req.deviceRegister?.id,
      );
      return ApiResponse.success(res, "Shift summary retrieved", summary);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_REGISTER_SHIFT_SUMMARY_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Price a ticket without creating an order — the POS screen calls this as
   * the ticket changes to show a real, tax/service-charge-inclusive total.
   * POST /api/store/pos/order/preview
   */
  async previewPosOrder(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, branch_id, fulfillment_type, items, discount_code } =
        req.body;
      const service = new StoreService(req.supabase);
      const pricing = await service.previewPosOrder({
        store_id,
        branch_id,
        fulfillment_type,
        items,
        discount_code,
      });
      return ApiResponse.success(res, "Pricing preview", pricing);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "PREVIEW_POS_ORDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Ring up a till sale from the POS screen.
   * POST /api/store/pos/order
   */
  async createPosOrder(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const {
        store_id,
        branch_id,
        register_id,
        fulfillment_type,
        customer,
        items,
        discount_code,
        payment_method,
        register_shift_id,
        notes,
        staff_id,
        idempotency_key,
      } = req.body;

      // A device-paired request already has its store/branch/register
      // identity locked to its own token (see authenticateUserOrRegisterDevice)
      // — the cross-business ownership check below only applies to the
      // dashboard-session path, where req.businessId is actually resolved.
      if (!req.deviceRegister) {
        const { data: store, error: storeError } = await req.supabase
          .from("stores")
          .select("id, business_id")
          .eq("id", store_id)
          .single();

        if (storeError || !store) {
          return res.status(400).json({
            success: false,
            error: "STORE_NOT_FOUND",
            message: "Store not found",
          });
        }

        const businessId = req.businessId!;
        if (businessId && store.business_id !== businessId) {
          return res.status(403).json({
            success: false,
            error: "UNAUTHORIZED",
            message: "Store does not belong to the selected business",
          });
        }
      }

      const service = new StoreService(req.supabase);
      const { order, unattachedToShift } = await service.createPosOrder({
        store_id,
        branch_id,
        register_id,
        fulfillment_type,
        customer,
        items,
        discount_code,
        payment_method,
        register_shift_id,
        notes,
        createdBy: req.user_id || null,
        staffId: staff_id,
        idempotencyKey: idempotency_key,
      });

      return ApiResponse.created(res, "Order created", { order, unattachedToShift });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_POS_ORDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a manual order (merchant dashboard)
   * POST /api/store/order
   */
  async createManualOrder(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const {
        store_id,
        customer,
        items,
        notes,
        mark_as_paid = true,
        payment_method = "online",
        branch_id = null,
        fulfillment_type = null,
      } = req.body;
      const user_id = req.user_id;

      // Verify store business scoping
      const { data: store, error: storeError } = await req.supabase
        .from("stores")
        .select("id, business_id, name, after_purchase")
        .eq("id", store_id)
        .single();

      if (storeError || !store) {
        return res.status(400).json({
          success: false,
          error: "Store not found",
        });
      }

      const businessId = req.businessId!;
      if (businessId && store.business_id !== businessId) {
        return res.status(403).json({
          error: "Unauthorized: Store does not belong to the selected business",
        });
      }

      // Verify products exist and are published
      const productIds = items.map((item: any) => item.product_id);
      const { data: products, error: productsError } = await req.supabase
        .from("products")
        .select(
          "id, name, price, stock, status, store_id, type, orders_count, service",
        )
        .in("id", productIds)
        .eq("store_id", store_id)
        .eq("status", "published");

      if (productsError) {
        return res.status(500).json({
          success: false,
          error: "Failed to validate products",
        });
      }

      // Check all products were found
      const foundIds = new Set(products?.map((p: any) => p.id) || []);
      const missingIds = productIds.filter((id: string) => !foundIds.has(id));
      if (missingIds.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Products not found or unpublished: ${missingIds.join(", ")}`,
        });
      }

      // Calculate totals
      const subtotal = items.reduce(
        (sum: number, item: any) => sum + item.price * item.quantity,
        0,
      );
      const discount = 0;
      const total = subtotal - discount;

      // Availability Guards for service products
      const availabilityService = new AvailabilityService(req.supabase);

      // Check product-specific availability for services (slot validation)
      for (const item of items) {
        const product = products.find((p: any) => p.id === item.product_id);
        if (!product) continue;

        if (product.type === "service") {
          if (!item.slot) {
            return res.status(400).json({
              success: false,
              error: "SLOT_REQUIRED",
              message: `Product ${product.name} requires a booking slot`,
            });
          }
          const slotStatus = await availabilityService.validateSlotAvailability(
            item.product_id,
            item.slot,
          );
          if (!slotStatus.isAvailable) {
            return res.status(409).json({
              success: false,
              error: "SLOT_UNAVAILABLE",
              message: `Selected slot for ${product.name} is unavailable: ${slotStatus.reason}`,
            });
          }
        }
        // Note: Physical and digital products no longer require availability checks for purchase
      }

      // Generate order number
      const { count } = await req.supabase
        .from("store_orders")
        .select("*", { count: "exact", head: true })
        .eq("store_id", store_id);

      const orderNumber = `ORD-${String((count || 0) + 1).padStart(4, "0")}`;

      // Generate payment reference for manual orders
      const paymentReference = createTransactionReference(REFERENCE_TYPES.ORDER);

      // Create order
      const now = new Date().toISOString();

      const orderData = {
        store_id,
        order_number: orderNumber,
        customer_name: customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone || null,
        customer_address: customer.address || null,
        items,
        subtotal,
        discount,
        total,
        currency: "NGN",
        status: mark_as_paid ? "paid" : "pending",
        payment_reference: paymentReference,
        payment_method,
        created_by: user_id,
        branch_id,
        fulfillment_type,
        shipping_carrier: null,
        shipping_tracking_number: null,
        shipping_status: null,
        shipped_at: null,
        delivered_at: null,
        notes: notes || null,
        created_at: now,
        updated_at: now,
        fulfilled_at: null,
      };

      const { data: savedOrder, error: orderError } = await req.supabase
        .from("store_orders")
        .insert([orderData])
        .select("*")
        .single();

      if (orderError) {
        console.error("Create manual order error:", orderError);
        return res.status(500).json({
          success: false,
          error: "Failed to create order",
        });
      }

      // Auto-fulfill all-digital orders when marked as paid,
      // mirroring the webhook path in StoreService.createOrder. Manual orders
      // otherwise land on "paid" and read as a physical/shipping order.
      if (
        mark_as_paid &&
        items.length > 0 &&
        items.every(
          (item: any) => {
            const product = products?.find((p: any) => p.id === item.product_id);
            const type = product?.type || item.product_type;
            return type === "digital";
          },
        )
      ) {
        savedOrder.status = "fulfilled";
        savedOrder.fulfilled_at = now;
        await req.supabase
          .from("store_orders")
          .update({ status: "fulfilled", fulfilled_at: now, updated_at: now })
          .eq("id", savedOrder.id);
      }

      // Update product stock and order counts
      for (const item of items) {
        const product = products?.find((p: any) => p.id === item.product_id);

        if (product) {
          const updates: any = {
            orders_count: Number(product.orders_count || 0) + Number(item.quantity),
            updated_at: now,
          };

          // Only update stock if it's being tracked (not null) and product is physical
          // (Service/Digital usually don't have finite 'stock' in this context unless specified)
          if (product.stock !== null && product.type === "physical") {
            updates.stock = Math.max(0, product.stock - item.quantity);
          }

          await req.supabase
            .from("products")
            .update(updates)
            .eq("id", item.product_id);
        }
      }

      const service = new StoreService(req.supabase);

      // Create bookings for service items
      try {
        const bookingService = new BookingService(req.supabase);
        for (const item of items) {
          const product = products?.find((p: any) => p.id === item.product_id);
          // Check if product is a service and has a slot
          if (product && product.type === "service" && item.slot) {
            // For manual orders created by merchant, we default to "confirmed"
            // because the merchant is explicitly creating the booking.
            const status = "confirmed";

            const booking = await bookingService.createBooking({
              order_id: savedOrder.id,
              product_id: item.product_id,
              store_id: store_id,
              customer_email: customer.email,
              customer_name: customer.name,
              booking_date: item.slot.date,
              start_time: item.slot.startTime,
              end_time: item.slot.endTime,
              status: status,
              duration_minutes: 60, // Default or fetch from product.service if validation needed
              approval_required: false, // Manual override
            });

            // Send confirmation email
            await storeEmailService.sendBookingConfirmation(
              booking,
              store.name,
              store.business_id,
            );
          }
        }
      } catch (err) {
        console.error("Failed to create bookings for manual order:", err);
        // Continue to finish order creation even if booking email fails,
        // though ideally we should alert.
      }

      // Upsert customer
      await service.upsertCustomer(store_id, customer, total);

      // Send receipt email if marked as paid
      if (mark_as_paid) {
        await storeEmailService.sendOrderConfirmation(
          savedOrder as any,
          store.name,
          store.business_id,
          store.after_purchase?.thank_you_message,
        );
      }

      return res.status(201).json({
        success: true,
        data: {
          id: savedOrder.id,
          order_number: savedOrder.order_number,
          store_id: savedOrder.store_id,
          customer: {
            name: savedOrder.customer_name,
            email: savedOrder.customer_email,
            phone: savedOrder.customer_phone,
            address: savedOrder.customer_address,
          },
          items: savedOrder.items,
          subtotal: savedOrder.subtotal,
          discount: savedOrder.discount,
          total: savedOrder.total_amount,
          currency: savedOrder.currency,
          status: savedOrder.status,
          payment_reference: savedOrder.payment_reference,
          payment_method: savedOrder.payment_method,
          branch_id: savedOrder.branch_id,
          fulfillment_type: savedOrder.fulfillment_type,
          shipping: null,
          notes: savedOrder.notes,
          created_at: savedOrder.created_at,
          updated_at: savedOrder.updated_at,
        },
      });
    } catch (err: any) {
      console.error("Create manual order error:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Failed to create order",
      });
    }
  }

  /**
   * Update order status
   * PATCH /api/store/order/status
   */
  async updateOrderStatus(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, order_id, status } = req.body;

      const service = new StoreService(req.supabase);
      const order = await service.updateOrderStatus(store_id, order_id, status);

      return ApiResponse.success(res, "Order status updated", order);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_ORDER_STATUS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update order shipping info
   * PATCH /api/store/order/shipping
   */
  async updateOrderShipping(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, order_id, updates } = req.body;

      const service = new StoreService(req.supabase);
      const order = await service.updateOrderShipping(
        store_id,
        order_id,
        updates,
      );

      return ApiResponse.success(res, "Shipping info updated", order);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_SHIPPING_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Add note to order
   * PATCH /api/store/order/note
   */
  async updateOrderNote(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, order_id, note } = req.body;

      const service = new StoreService(req.supabase);
      const order = await service.updateOrderNote(store_id, order_id, note);

      return ApiResponse.success(res, "Order note updated", order);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_NOTE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get store orders
   * GET /api/store/order
   */
  async getOrders(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { page, limit, status, search, store_id, branch_id, product_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const result = await service.getStoreOrders(store_id, {
        page: parseInt(page),
        limit: parseInt(limit),
        status,
        search,
        branch_id,
        product_id,
      });

      return ApiResponse.success(res, "Orders retrieved successfully", result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_ORDERS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get single store order by id
   * GET /api/store/order/:orderId
   */
  async getOrderById(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { orderId } = req.params as any;
      const { store_id } = req.query as any;

      if (!store_id) {
        return res.status(400).json({
          success: false,
          error: "GET_ORDER_ERROR",
          message: "store_id is required",
        });
      }

      const service = new StoreService(req.supabase);
      const order = await service.getStoreOrderById(store_id, orderId);

      return ApiResponse.success(res, "Order retrieved successfully", order);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_ORDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Fetch the current user's single purchase
   * GET /api/store/order/my-purchases/:id
   */
  async getUserPurchaseById(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const userId = req.user_id!;
      const { data: userData, error: userError } = await req.supabase
        .from("users")
        .select("email")
        .eq("id", userId)
        .single();

      if (userError) throw userError;

      const service = new StoreService(req.supabase);
      const purchases = await service.getUserPurchases({
        userId,
        email: userData?.email || null,
        orderId: req.params.id,
      });

      if (!purchases.length) {
        return ApiResponse.notFound(res, "Purchase not found");
      }

      return ApiResponse.success(
        res,
        "Purchase retrieved successfully",
        purchases[0],
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_USER_PURCHASE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Fetch the current user's purchases with product metadata
   * GET /api/store/order/my-purchases
   */
  async getUserPurchases(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const userId = req.user_id!;
      const { data: userData, error: userError } = await req.supabase
        .from("users")
        .select("email")
        .eq("id", userId)
        .single();

      if (userError) throw userError;

      const service = new StoreService(req.supabase);
      const purchases = await service.getUserPurchases({
        userId,
        email: userData?.email || null,
      });

      return ApiResponse.success(
        res,
        "Purchases retrieved successfully",
        purchases,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_USER_PURCHASES_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Discount Management
  // ============================================================================

  /**
   * Add a discount code
   * POST /api/store/discount
   */
  async addDiscountCode(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, code } = req.body;

      const service = new StoreService(req.supabase);
      const discountCode = await service.addDiscountCode(store_id, code);

      return ApiResponse.created(
        res,
        "Discount code created successfully",
        discountCode,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "ADD_DISCOUNT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update a discount code
   * PATCH /api/store/discount
   */
  async updateDiscountCode(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, code_id, updates } = req.body;

      const service = new StoreService(req.supabase);
      const discountCode = await service.updateDiscountCode(
        store_id,
        code_id,
        updates,
      );

      return ApiResponse.success(
        res,
        "Discount code updated successfully",
        discountCode,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_DISCOUNT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete a discount code
   * DELETE /api/store/discount
   */
  async deleteDiscountCode(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, code_id } = req.body;

      const service = new StoreService(req.supabase);
      await service.deleteDiscountCode(store_id, code_id);

      return ApiResponse.success(
        res,
        "Discount code deleted successfully",
        null,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_DISCOUNT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Validate a discount code
   * POST /api/store/discount/validate
   */
  async validateDiscountCode(req: any, res: Response): Promise<Response> {
    try {
      const { store_id, code, subtotal, items } = req.body;

      const service = new StoreService(req.supabase);
      const result = await service.validateDiscountCode(
        store_id,
        code,
        { subtotal, items },
      );

      return ApiResponse.success(res, "Discount code validated", result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "VALIDATE_DISCOUNT_ERROR",
        message: err.message,
      });
    }
  }

  async discountApplicable(req: any, res: Response): Promise<Response> {
    try {
      const { store_id, product_ids } = req.body;

      const service = new StoreService(req.supabase);
      const applicable = await service.isDiscountApplicable(
        store_id,
        product_ids,
      );

      return ApiResponse.success(res, "ok", { applicable });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DISCOUNT_APPLICABLE_ERROR",
        message: err.message,
      });
    }
  }

  async evaluateDiscounts(req: any, res: Response): Promise<Response> {
    try {
      const { store_id, items, customer_email, code } = req.body;
      const service = new StoreService(req.supabase);
      const result = await service.evaluateDiscounts({
        storeId: store_id,
        items,
        customerEmail: customer_email,
        code,
      });

      return ApiResponse.success(res, "Discounts evaluated", result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "EVALUATE_DISCOUNTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get store discounts
   * GET /api/store/discount
   */
  async getDiscounts(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { page, limit, is_active, kind, search, store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const result = await service.getStoreDiscounts(store_id, {
        page: parseInt(page),
        limit: parseInt(limit),
        is_active:
          is_active === "true"
            ? true
            : is_active === "false"
              ? false
              : undefined,
        kind,
        search,
      });

      return ApiResponse.success(
        res,
        "Discounts retrieved successfully",
        result,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_DISCOUNTS_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Store Deletion
  // ============================================================================

  /**
   * Delete store (only if no products or orders)
   * DELETE /api/store/delete
   */
  async deleteStore(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id } = req.query;
      const businessId = (req as any).businessId;

      const service = new StoreService(req.supabase);
      await service.deleteStore(req.user_id!, store_id as string, businessId);

      return ApiResponse.success(res, "Store deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_STORE_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Customer Management
  // ============================================================================

  /**
   * Get store customers
   * GET /api/store/customer
   */
  async getCustomers(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { page, limit, search, store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const result = await service.getStoreCustomers(store_id, {
        page: parseInt(page),
        limit: parseInt(limit),
        search,
      });

      return ApiResponse.success(
        res,
        "Customers retrieved successfully",
        result,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CUSTOMERS_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Checkout
  // ============================================================================

  /**
   * Initialize checkout with Paystack
   * POST /api/store/checkout/initiate
   */
  async initiateCheckout(req: any, res: Response): Promise<Response> {
    try {
      const {
        store_id,
        customer,
        items,
        discount_code,
        callback_url,
        payment_reference,
        delivery_method_id,
        delivery_fee,
        delivery_provider,
        delivery_service_code,
        delivery_courier_id,
        delivery_city,
        delivery_state,
        delivery_zip,
        user_id,
        selected_plan_id,
        currency,
        fulfillment_type,
        branch_id,
        utensils_requested,
        notes,
        qr_code,
      } = req.body;

      const service = new StoreService(req.supabase);
      const result = await service.initiateCheckout({
        store_id,
        customer,
        items,
        discount_code,
        callback_url,
        payment_reference,
        delivery_method_id,
        delivery_fee,
        delivery_provider,
        delivery_service_code,
        delivery_courier_id,
        delivery_city,
        delivery_state,
        delivery_zip,
        user_id: user_id || req.user_id,
        selected_plan_id,
        currency,
        fulfillment_type,
        branch_id,
        utensils_requested,
        notes,
        qr_code,
      });

      return ApiResponse.success(
        res,
        "Checkout initiated successfully",
        result,
      );
    } catch (err: any) {
      console.error("CHECKOUT_INITIATE_ERROR:", err);
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CHECKOUT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Issue a virtual account for a bank-transfer checkout
   * POST /api/store/checkout/bank-transfer
   */
  async initiateBankTransfer(req: any, res: Response): Promise<Response> {
    try {
      const service = new StoreService(req.supabase);
      const result = await service.initiateBankTransferCheckout({
        ...req.body,
        user_id: req.body.user_id || req.user_id,
      });

      return ApiResponse.success(
        res,
        "Bank transfer account issued successfully",
        result,
      );
    } catch (err: any) {
      console.error("BANK_TRANSFER_INITIATE_ERROR:", err);
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "BANK_TRANSFER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Poll the payment status of a checkout reference
   * GET /api/store/checkout/:reference/status
   */
  async getCheckoutStatus(req: any, res: Response): Promise<Response> {
    try {
      const service = new StoreService(req.supabase);
      const result = await service.getCheckoutStatus(req.params.reference);
      return ApiResponse.success(res, "Checkout status retrieved", result);
    } catch (err: any) {
      console.error("CHECKOUT_STATUS_ERROR:", err);
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CHECKOUT_STATUS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Process a free purchase (bypass Paystack)
   * POST /api/store/checkout/free
   */
  async processFreePurchase(req: any, res: Response): Promise<Response> {
    try {
      const {
        store_id,
        customer,
        items,
        discount_code,
        delivery_method_id,
        delivery_fee,
        delivery_provider,
        delivery_service_code,
        delivery_courier_id,
        delivery_city,
        delivery_state,
        fulfillment_type,
        branch_id,
        utensils_requested,
        notes,
      } = req.body;

      const service = new StoreService(req.supabase);
      const result = await service.processFreePurchase({
        store_id,
        customer,
        items,
        discount_code,
        delivery_method_id,
        delivery_fee,
        delivery_provider,
        delivery_service_code,
        delivery_courier_id,
        delivery_city,
        delivery_state,
        user_id: req.user_id,
        fulfillment_type,
        branch_id,
        utensils_requested,
        notes,
      });

      return ApiResponse.success(
        res,
        "Free purchase processed successfully",
        result,
      );
    } catch (err: any) {
      console.error("FREE_PURCHASE_ERROR:", err);
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "FREE_PURCHASE_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Category Management
  // ============================================================================

  /**
   * Get all categories for the authenticated user's store
   * GET /api/store/categories
   */
  async getCategories(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, parent_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const categories = await service.getStoreCategories(store_id, parent_id);

      return ApiResponse.success(
        res,
        "Categories retrieved successfully",
        categories,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CATEGORIES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a new category
   * POST /api/store/categories
   */
  async createCategory(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, name, description, is_active, position, parent_id } = req.body;

      const service = new StoreService(req.supabase);
      const category = await service.createStoreCategory(store_id, {
        name,
        description,
        is_active,
        position,
        parent_id,
      });

      return ApiResponse.created(
        res,
        "Category created successfully",
        category,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_CATEGORY_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update a category
   * PUT /api/store/categories/:id
   */
  async updateCategory(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id, name, description, is_active, position, parent_id } = req.body;

      const service = new StoreService(req.supabase);
      const category = await service.updateStoreCategory(store_id, id, {
        name,
        description,
        is_active,
        position,
        parent_id,
      });

      return ApiResponse.success(
        res,
        "Category updated successfully",
        category,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_CATEGORY_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete a category
   * DELETE /api/store/categories/:id
   */
  async deleteCategory(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.body;

      const service = new StoreService(req.supabase);
      await service.deleteStoreCategory(store_id, id);

      return ApiResponse.success(res, "Category deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_CATEGORY_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Reorder categories
   * PUT /api/store/categories/reorder
   */
  async reorderCategories(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, orders } = req.body;

      const service = new StoreService(req.supabase);
      await service.reorderStoreCategories(store_id, orders);

      return ApiResponse.success(
        res,
        "Categories reordered successfully",
        null,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "REORDER_CATEGORIES_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Store Branches (Food Store)
  // ============================================================================

  /**
   * Get store branches
   * GET /api/store/branches?store_id=...
   */
  async getBranches(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const branches = await service.getStoreBranches(store_id);

      return ApiResponse.success(
        res,
        "Branches retrieved successfully",
        branches,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_BRANCHES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a branch
   * POST /api/store/branches
   */
  async createBranch(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const {
        store_id,
        name,
        address,
        phone,
        business_hours,
        operation_types,
        prep_time_minutes,
        is_default,
        is_active,
        accepting_orders,
        tax_rate,
        service_charge_rates,
        manager,
        format,
      } = req.body;

      const service = new StoreService(req.supabase);
      const branch = await service.createStoreBranch(store_id, {
        name,
        address,
        phone,
        business_hours,
        operation_types,
        prep_time_minutes,
        is_default,
        is_active,
        accepting_orders,
        tax_rate,
        service_charge_rates,
        manager,
        format,
      } as any);

      return ApiResponse.created(res, "Branch created successfully", branch);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_BRANCH_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update a branch
   * PUT /api/store/branches/:id
   */
  async updateBranch(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const {
        store_id,
        name,
        address,
        phone,
        business_hours,
        operation_types,
        prep_time_minutes,
        is_default,
        is_active,
        accepting_orders,
        tax_rate,
        service_charge_rates,
        manager,
        format,
      } = req.body;

      const service = new StoreService(req.supabase);
      const branch = await service.updateStoreBranch(store_id, id, {
        name,
        address,
        phone,
        business_hours,
        operation_types,
        prep_time_minutes,
        is_default,
        is_active,
        accepting_orders,
        tax_rate,
        service_charge_rates,
        manager,
        format,
      } as any);

      return ApiResponse.success(res, "Branch updated successfully", branch);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_BRANCH_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete a branch
   * DELETE /api/store/branches/:id
   */
  async deleteBranch(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.body;

      const service = new StoreService(req.supabase);
      await service.deleteStoreBranch(store_id, id);

      return ApiResponse.success(res, "Branch deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_BRANCH_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Store QR Codes (Food Store)
  // ============================================================================

  /**
   * GET /api/store/qr-codes
   */
  async getQrCodes(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const qrCodes = await service.getStoreQrCodes(store_id);

      return ApiResponse.success(res, "QR codes retrieved successfully", qrCodes);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_QR_CODES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a QR code
   * POST /api/store/qr-codes
   */
  async createQrCode(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, label, branch_id } = req.body;

      const service = new StoreService(req.supabase);
      const qrCode = await service.createStoreQrCode(store_id, { label, branch_id });

      return ApiResponse.created(res, "QR code created successfully", qrCode);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_QR_CODE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update a QR code
   * PUT /api/store/qr-codes/:id
   */
  async updateQrCode(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id, label, branch_id, is_active } = req.body;

      const service = new StoreService(req.supabase);
      const qrCode = await service.updateStoreQrCode(store_id, id, {
        label,
        branch_id,
        is_active,
      });

      return ApiResponse.success(res, "QR code updated successfully", qrCode);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_QR_CODE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete a QR code
   * DELETE /api/store/qr-codes/:id
   */
  async deleteQrCode(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.body;

      const service = new StoreService(req.supabase);
      await service.deleteStoreQrCode(store_id, id);

      return ApiResponse.success(res, "QR code deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_QR_CODE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Public: resolve a scanned QR code to its branch + label.
   * GET /api/store/public/:slug/qr/:code
   */
  async getPublicStoreQrCode(req: any, res: Response): Promise<Response> {
    try {
      const { slug, code } = req.params;

      const service = new StoreService(req.supabase);
      const resolved = await service.getPublicStoreQrCode(slug, code);

      return ApiResponse.success(res, "QR code resolved successfully", resolved);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_QR_CODE_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Store Menus (Food Store)
  // ============================================================================

  async getMenus(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id } = req.query as any;
      const service = new StoreService(req.supabase);
      const menus = await service.getStoreMenus(store_id);
      return ApiResponse.success(res, "Menus retrieved successfully", menus);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_MENUS_ERROR",
        message: err.message,
      });
    }
  }

  async createMenu(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, name, description, position, availability, branch_ids, is_active } =
        req.body;
      const service = new StoreService(req.supabase);
      const menu = await service.createStoreMenu(store_id, {
        name,
        description,
        position,
        availability,
        branch_ids,
        is_active,
      } as any);
      return ApiResponse.created(res, "Menu created successfully", menu);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_MENU_ERROR",
        message: err.message,
      });
    }
  }

  async updateMenu(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id, name, description, position, availability, branch_ids, is_active } =
        req.body;
      const service = new StoreService(req.supabase);
      const menu = await service.updateStoreMenu(store_id, id, {
        name,
        description,
        position,
        availability,
        branch_ids,
        is_active,
      } as any);
      return ApiResponse.success(res, "Menu updated successfully", menu);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_MENU_ERROR",
        message: err.message,
      });
    }
  }

  async deleteMenu(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.body;
      const service = new StoreService(req.supabase);
      await service.deleteStoreMenu(store_id, id);
      return ApiResponse.success(res, "Menu deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_MENU_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Units are platform-defined and read-only. Store scoping is used only for
  // accurate product usage counts.
  async getUnits(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id } = req.query as { store_id: string };
      const service = new StoreService(req.supabase);
      const units = await service.getStoreUnits(
        store_id,
        req.user_id!,
        req.businessId,
      );
      return ApiResponse.success(res, "Units retrieved successfully", units);
    } catch (error: any) {
      const status = error?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_UNITS_ERROR",
        message: error?.message || "Failed to load units",
      });
    }
  }

  // Modifier Groups (Food Store)
  // ============================================================================

  async getModifierGroups(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, kind } = req.query as any;
      const service = new StoreService(req.supabase);
      const groups = await service.getModifierGroups(store_id, kind);
      return ApiResponse.success(
        res,
        "Modifier groups retrieved successfully",
        groups,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_MODIFIER_GROUPS_ERROR",
        message: err.message,
      });
    }
  }

  async createModifierGroup(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, ...payload } = req.body as ModifierGroupUpsert & {
        store_id: string;
      };
      const service = new StoreService(req.supabase);
      const group = await service.createModifierGroup(store_id, payload);
      return ApiResponse.created(res, "Modifier group created successfully", group);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_MODIFIER_GROUP_ERROR",
        message: err.message,
      });
    }
  }

  async getModifierGroup(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.query as { store_id: string };
      const service = new StoreService(req.supabase);
      const group = await service.getModifierGroup(store_id, id);
      return ApiResponse.success(res, "Modifier group retrieved successfully", group);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_MODIFIER_GROUP_ERROR",
        message: err.message,
      });
    }
  }

  async updateModifierGroup(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id, ...payload } = req.body as ModifierGroupUpsert & {
        store_id: string;
      };
      const service = new StoreService(req.supabase);
      const group = await service.updateModifierGroup(store_id, id, payload);
      return ApiResponse.success(res, "Modifier group updated successfully", group);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_MODIFIER_GROUP_ERROR",
        message: err.message,
      });
    }
  }

  async reorderModifierGroups(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, ordered_ids } = req.body as {
        store_id: string;
        ordered_ids: string[];
      };
      const service = new StoreService(req.supabase);
      await service.reorderModifierGroups(store_id, ordered_ids);
      return ApiResponse.success(res, "Modifier groups reordered successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "REORDER_MODIFIER_GROUPS_ERROR",
        message: err.message,
      });
    }
  }

  async reorderModifierOptions(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { groupId } = req.params;
      const { store_id, ordered_ids } = req.body as {
        store_id: string;
        ordered_ids: string[];
      };
      const service = new StoreService(req.supabase);
      await service.reorderModifierOptions(store_id, groupId, ordered_ids);
      return ApiResponse.success(res, "Modifier options reordered successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "REORDER_MODIFIER_OPTIONS_ERROR",
        message: err.message,
      });
    }
  }

  async deleteModifierGroup(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.body;
      const service = new StoreService(req.supabase);
      await service.deleteModifierGroup(store_id, id);
      return ApiResponse.success(res, "Modifier group deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_MODIFIER_GROUP_ERROR",
        message: err.message,
      });
    }
  }

  async createModifierOption(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { groupId } = req.params;
      const { store_id, ...payload } = req.body as Partial<ModifierOption> & {
        store_id: string;
      };
      const service = new StoreService(req.supabase);
      const option = await service.createModifierOption(store_id, groupId, payload);
      return ApiResponse.created(res, "Modifier option created successfully", option);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_MODIFIER_OPTION_ERROR",
        message: err.message,
      });
    }
  }

  async updateModifierOption(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { groupId, optionId } = req.params;
      const { store_id, ...payload } = req.body as Partial<ModifierOption> & {
        store_id: string;
      };
      const service = new StoreService(req.supabase);
      const option = await service.updateModifierOption(store_id, groupId, optionId, payload);
      return ApiResponse.success(res, "Modifier option updated successfully", option);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_MODIFIER_OPTION_ERROR",
        message: err.message,
      });
    }
  }

  async deleteModifierOption(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { groupId, optionId } = req.params;
      const { store_id } = req.body;
      const service = new StoreService(req.supabase);
      await service.deleteModifierOption(store_id, groupId, optionId);
      return ApiResponse.success(res, "Modifier option deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_MODIFIER_OPTION_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Product <-> Modifier Group attachment (Food Store)
  // ============================================================================

  async getProductModifierGroups(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id } = req.query as any;
      const service = new StoreService(req.supabase);
      const groups = await service.getProductModifierGroups(store_id, productId);
      return ApiResponse.success(
        res,
        "Product modifier groups retrieved successfully",
        groups,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PRODUCT_MODIFIER_GROUPS_ERROR",
        message: err.message,
      });
    }
  }

  async attachModifierGroup(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id, modifier_group_id, position } = req.body;
      const service = new StoreService(req.supabase);
      await service.attachModifierGroupToProduct(
        store_id,
        productId,
        modifier_group_id,
        position,
      );
      return ApiResponse.success(res, "Modifier group attached successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "ATTACH_MODIFIER_GROUP_ERROR",
        message: err.message,
      });
    }
  }

  async detachModifierGroup(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { productId, groupId } = req.params;
      const service = new StoreService(req.supabase);
      await service.detachModifierGroupFromProduct(productId, groupId);
      return ApiResponse.success(res, "Modifier group detached successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DETACH_MODIFIER_GROUP_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get public categories for a store
   * GET /api/store/public/:slug/categories
   */
  async getPublicCategories(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const service = new StoreService(req.supabase);
      const store = await service.getStoreBySlug(slug);
      const categories = await service.getPublicCategories(store.id);

      return ApiResponse.success(
        res,
        "Categories retrieved successfully",
        categories,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_CATEGORIES_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Delivery Methods Management
  // ============================================================================

  /**
   * Get all delivery methods for a store
   * GET /api/store/delivery-methods
   */
  async getDeliveryMethods(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const methods = await service.getDeliveryMethods(store_id);

      return ApiResponse.success(
        res,
        "Delivery methods retrieved successfully",
        methods,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_DELIVERY_METHODS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a new delivery method
   * POST /api/store/delivery-methods
   */
  async createDeliveryMethod(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const {
        store_id,
        name,
        description,
        price,
        currency,
        estimated_time,
        is_active,
        sort_order,
      } = req.body;

      const service = new StoreService(req.supabase);
      const method = await service.createDeliveryMethod(store_id, {
        name,
        description,
        price,
        currency,
        estimated_time,
        is_active,
        sort_order,
      });

      return ApiResponse.created(
        res,
        "Delivery method created successfully",
        method,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_DELIVERY_METHOD_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update a delivery method
   * PUT /api/store/delivery-methods/:id
   */
  async updateDeliveryMethod(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { id } = req.params;
      const {
        store_id,
        name,
        description,
        price,
        currency,
        estimated_time,
        is_active,
        sort_order,
      } = req.body;

      const service = new StoreService(req.supabase);
      const method = await service.updateDeliveryMethod(store_id, id, {
        name,
        description,
        price,
        currency,
        estimated_time,
        is_active,
        sort_order,
      });

      return ApiResponse.success(
        res,
        "Delivery method updated successfully",
        method,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_DELIVERY_METHOD_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete a delivery method (soft delete)
   * DELETE /api/store/delivery-methods/:id
   */
  async deleteDeliveryMethod(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      await service.deleteDeliveryMethod(store_id, id);

      return ApiResponse.success(
        res,
        "Delivery method deleted successfully",
        null,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_DELIVERY_METHOD_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Delivery Zones (Branch-Aware Storefront)
  // ============================================================================

  async getDeliveryZones(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, branch_id } = req.query as any;
      const service = new StoreService(req.supabase);
      const zones = await service.getStoreDeliveryZones(store_id, branch_id);
      return ApiResponse.success(res, "Delivery zones retrieved successfully", zones);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_DELIVERY_ZONES_ERROR",
        message: err.message,
      });
    }
  }

  async createDeliveryZone(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { store_id, branch_id, zip_code, fee, currency, min_order, estimated_minutes, is_active } =
        req.body;
      const service = new StoreService(req.supabase);
      const zone = await service.createStoreDeliveryZone(store_id, {
        branch_id,
        zip_code,
        fee,
        currency,
        min_order,
        estimated_minutes,
        is_active,
      });
      return ApiResponse.created(res, "Delivery zone created successfully", zone);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_DELIVERY_ZONE_ERROR",
        message: err.message,
      });
    }
  }

  async updateDeliveryZone(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id, zip_code, fee, currency, min_order, estimated_minutes, is_active } = req.body;
      const service = new StoreService(req.supabase);
      const zone = await service.updateStoreDeliveryZone(store_id, id, {
        zip_code,
        fee,
        currency,
        min_order,
        estimated_minutes,
        is_active,
      });
      return ApiResponse.success(res, "Delivery zone updated successfully", zone);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_DELIVERY_ZONE_ERROR",
        message: err.message,
      });
    }
  }

  async deleteDeliveryZone(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.query as any;
      const service = new StoreService(req.supabase);
      await service.deleteStoreDeliveryZone(store_id, id);
      return ApiResponse.success(res, "Delivery zone deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_DELIVERY_ZONE_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Branch Overrides (catalog + normalized branch inventory)
  // ============================================================================

  async getProductBranchOverrides(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id } = req.query as any;
      const service = new StoreService(req.supabase);
      const overrides = await service.getProductBranchOverrides(store_id, productId);
      return ApiResponse.success(res, "Branch overrides retrieved successfully", overrides);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PRODUCT_BRANCH_OVERRIDES_ERROR",
        message: err.message,
      });
    }
  }

  async upsertProductBranchOverrides(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id, overrides } = req.body;
      const service = new StoreService(req.supabase);
      const result = await service.upsertProductBranchOverrides(store_id, productId, overrides);
      return ApiResponse.success(res, "Branch overrides saved successfully", result);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPSERT_PRODUCT_BRANCH_OVERRIDES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Reorder delivery methods
   * PUT /api/store/delivery-methods/reorder
   */
  async reorderDeliveryMethods(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, order } = req.body;

      const service = new StoreService(req.supabase);
      await service.reorderDeliveryMethods(store_id, order);

      return ApiResponse.success(
        res,
        "Delivery methods reordered successfully",
        null,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "REORDER_DELIVERY_METHODS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get active delivery methods for public storefront
   * GET /api/store/public/:slug/delivery-methods
   */
  async getPublicDeliveryMethods(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;

      const service = new StoreService(req.supabase);
      const methods = await service.getPublicDeliveryMethods(slug);

      return ApiResponse.success(
        res,
        "Delivery methods retrieved successfully",
        methods,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_DELIVERY_METHODS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Preview the delivery zone fee for a given branch + zip, ahead of
   * payment, for the public storefront checkout.
   * GET /api/store/public/:slug/delivery-zones/match
   */
  async getPublicDeliveryZoneMatch(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const { branch_id, zip } = req.query;

      if (!branch_id || !zip) {
        return res.status(400).json({
          success: false,
          error: "MISSING_PARAMS",
          message: "branch_id and zip are required",
        });
      }

      const service = new StoreService(req.supabase);
      const match = await service.getPublicDeliveryZoneMatch(
        slug,
        String(branch_id),
        String(zip),
      );

      return ApiResponse.success(
        res,
        "Delivery zone match resolved successfully",
        match,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_DELIVERY_ZONE_MATCH_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Carrier Delivery (Shipbubble) — merchant settings
  // ============================================================================

  /**
   * Validate a sender/pickup address against Shipbubble. Lets merchants
   * confirm their business pickup address is deliverable before enabling
   * carrier delivery.
   * POST /api/store/sender-address/validate
   */
  async validateSenderAddress(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { name, address, phone, email, latitude, longitude } =
        req.body as {
          name?: string;
          address: string;
          phone?: string;
          email?: string;
          latitude?: number;
          longitude?: number;
        };

      const deliveryService = new DeliveryService();
      const result = await deliveryService.validateAddress({
        name: name || "Store Sender",
        phone: phone || "08000000000",
        email: email || "store@hilaq.com",
        address,
        latitude,
        longitude,
      });

      return ApiResponse.success(res, "Address is valid", {
        valid: true,
        formatted_address: result.formatted_address,
      });
    } catch (err: any) {
      const status = err?.statusCode || 400;
      return res.status(status).json({
        success: false,
        error: "VALIDATE_SENDER_ADDRESS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Enable/disable carrier (Shipbubble) delivery for a store. Enabling
   * requires a Shipbubble-validatable business pickup address.
   * PATCH /api/store/carrier-delivery
   */
  async setCarrierDelivery(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, enabled } = req.body as {
        store_id: string;
        enabled: boolean;
      };

      const service = new StoreService(req.supabase);

      if (enabled) {
        const sender = await service.getStoreSenderAddress(store_id);
        if (!sender?.address) {
          return ApiResponse.badRequest(
            res,
            "Add your business pickup address before enabling carrier delivery.",
          );
        }

        // Guard: re-validate server-side so an invalid address can never
        // silently enable carrier delivery and break checkout. Cache the
        // returned address_code so future rate calls skip re-validation.
        const deliveryService = new DeliveryService();
        try {
          const validated = await deliveryService.validateAddress({
            name: sender.name || "Store Sender",
            phone: sender.phone || "08000000000",
            email: sender.email || "store@hilaq.com",
            address: sender.address,
          });
          if (sender.businessId && validated.address_code) {
            await service.saveSenderAddressCode(
              sender.businessId,
              validated.address_code,
            );
          }
        } catch {
          return ApiResponse.badRequest(
            res,
            "Your business pickup address could not be validated. Please confirm a clear, accurate address.",
          );
        }
      }

      await service.setCarrierDelivery(store_id, enabled);

      return ApiResponse.success(
        res,
        `Carrier delivery ${enabled ? "enabled" : "disabled"}`,
        { carrier_delivery_enabled: enabled },
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "SET_CARRIER_DELIVERY_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Delivery Rates (Shipbubble)
  // ============================================================================

  /**
   * Get public delivery rates via Shipbubble
   * GET /api/store/public/:slug/delivery-rates
   */
  async getPublicDeliveryRates(
    req: any,
    res: Response,
  ): Promise<Response> {
    try {
      const { slug } = req.params;
      const {
        destination_city,
        destination_state,
        destination_country,
        destination_postal_code,
        destination_address,
        destination_lat,
        destination_lng,
        destination_name,
        destination_phone,
        destination_email,
        destination_address_code,
        total_weight,
        total_value,
      } = req.query as any;

      const lat = Number(destination_lat);
      const lng = Number(destination_lng);
      const receiverCode = Number(destination_address_code);

      const service = new StoreService(req.supabase);
      const storeId = await service.getStoreIdBySlug(slug);

      if (!storeId) {
        return ApiResponse.notFound(res, "Store not found");
      }

      const { data: store } = await req.supabase
        .from("stores")
        .select("business_id, carrier_delivery_enabled")
        .eq("id", storeId)
        .single();

      // Carrier delivery is opt-in per store. When off, return no carrier
      // rates so checkout falls back to the store's own delivery methods.
      if (!store?.carrier_delivery_enabled) {
        return ApiResponse.success(
          res,
          "Carrier delivery is not enabled for this store",
          [],
        );
      }

      const sender = await service.getStoreSenderAddress(storeId);
      const businessSender = {
        name: sender?.name,
        phone: sender?.phone,
        email: sender?.email,
        address: sender?.address,
        address_code: sender?.address_code,
      };

      const deliveryService = new DeliveryService();
      const { rates, receiverAddressCode } = await deliveryService.getRates({
        destination: {
          city: destination_city,
          state: destination_state,
          country: destination_country || "Nigeria",
          postal_code: destination_postal_code,
          address_line_1: destination_address,
          latitude: Number.isFinite(lat) ? lat : undefined,
          longitude: Number.isFinite(lng) ? lng : undefined,
          name: destination_name || undefined,
          phone: destination_phone || undefined,
          email: destination_email || undefined,
          // Reuse a saved address's validated code to skip re-validation.
          address_code: Number.isFinite(receiverCode) ? receiverCode : undefined,
        },
        parcels: [
          {
            name: "Items",
            // Frontend sends total_weight in grams; Shipbubble expects kilograms.
            weight: Number(total_weight) > 0 ? Number(total_weight) / 1000 : 0.5,
            quantity: 1,
            declared_value: Number(total_value) || 0,
          },
        ],
        sender: businessSender,
      });

      return ApiResponse.success(res, "Delivery rates retrieved successfully", {
        rates,
        // Returned so a logged-in customer's address can be saved with its
        // validated code for charge-free reuse on future checkouts.
        receiver_address_code: receiverAddressCode,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_DELIVERY_RATES_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Shipbubble Webhook
  // ============================================================================

  /**
   * Handle Shipbubble webhook events (status changes, tracking updates)
   * POST /api/store/shipbubble-webhook
   */
  async handleShipbubbleWebhook(
    req: any,
    res: Response,
  ): Promise<Response> {
    try {
      const signature = req.headers["x-ship-signature"] as string;
      if (signature && shipbubbleConfig.webhookSecret) {
        const payload = JSON.stringify(req.body);
        const expected = crypto
          .createHmac("sha512", shipbubbleConfig.webhookSecret)
          .update(payload)
          .digest("hex");
        if (signature !== expected) {
          console.error("Shipbubble webhook: invalid signature");
          return res.status(200).json({ received: true });
        }
      }

      const { event, order_id, status: shipStatus, tracking_url } = req.body;

      if (!order_id) {
        return res.status(200).json({ received: true });
      }

      const service = new StoreService(req.supabase);

      if (event === "shipment.status.changed") {
        const statusMap: Record<string, string> = {
          pending: "pending",
          confirmed: "processing",
          picked_up: "processing",
          in_transit: "shipped",
          out_for_delivery: "shipped",
          completed: "delivered",
          cancelled: "cancelled",
        };

        const mappedStatus = statusMap[shipStatus];
        if (mappedStatus) {
          await service.updateOrderShippingByShipbubbleId(order_id, {
            tracking_number: req.body.courier?.tracking_code || order_id,
            status: mappedStatus as any,
            shipped_at:
              mappedStatus === "shipped" ? new Date().toISOString() : undefined,
            delivered_at:
              mappedStatus === "delivered"
                ? new Date().toISOString()
                : undefined,
          });
        }
      }

      if (event === "shipment.label.created") {
        await service.updateOrderShippingByShipbubbleId(order_id, {
          tracking_number: req.body.courier?.tracking_code || order_id,
        });
      }

      return res.status(200).json({ received: true });
    } catch (err: any) {
      console.error("Shipbubble webhook error:", err.message);
      return res.status(200).json({ received: true });
    }
  }

  // ============================================================================
  // Store Reviews
  // ============================================================================

  /**
   * Get public store info
   * GET /api/store/public/:slug/info
   */
  async getPublicStoreInfo(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const branchId =
        typeof req.query.branch_id === "string" ? req.query.branch_id : undefined;

      const service = new StoreService(req.supabase);
      const info = await service.getPublicStoreInfo(slug, branchId);

      return ApiResponse.success(
        res,
        "Store info retrieved successfully",
        info,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_STORE_INFO_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get public reviews
   * GET /api/store/public/:slug/reviews


  /**
   * Get store reviews (merchant dashboard)
   * GET /api/store/reviews
   */
  async getStoreReviews(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { store_id, page = "1", limit = "10" } = req.query as any;

      const service = new StoreService(req.supabase);
      const reviews = await service.getStoreReviews(
        store_id,
        parseInt(page, 10),
        parseInt(limit, 10),
      );

      return ApiResponse.success(
        res,
        "Reviews retrieved successfully",
        reviews,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_STORE_REVIEWS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update review visibility
   * PUT /api/store/reviews/:id
   */
  async updateReviewVisibility(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id, is_visible } = req.body;

      const service = new StoreService(req.supabase);
      const review = await service.updateReviewVisibility(
        store_id,
        id,
        is_visible,
      );

      return ApiResponse.success(res, "Review updated successfully", review);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_REVIEW_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete review
   * DELETE /api/store/reviews/:id
   */
  async deleteReview(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      await service.deleteReview(store_id, id);

      return ApiResponse.success(res, "Review deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_REVIEW_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Product Variants
  // ============================================================================

  /**
   * Get product variants
   * GET /api/store/product/:productId/variants
   */
  async getProductVariants(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const variants = await service.getProductVariants(store_id, productId);

      return ApiResponse.success(
        res,
        "Variants retrieved successfully",
        variants,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_VARIANTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create product variant
   * POST /api/store/product/:productId/variants
   */
  async createProductVariant(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId } = req.params;
      const {
        store_id,
        name,
        group_name,
        group_ui_type,
        options,
        price_adjustment,
        stock,
        sku,
        color_value,
        is_active,
        position,
        compare_at_price,
      } = req.body;

      const service = new StoreService(req.supabase);
      const variant = await service.createProductVariant(store_id, productId, {
        name,
        group_name,
        group_ui_type,
        options,
        price_adjustment,
        stock,
        sku,
        color_value,
        is_active,
        position,
        compare_at_price,
      });

      return ApiResponse.created(res, "Variant created successfully", variant);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_VARIANT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update product variant
   * PUT /api/store/product/:productId/variants/:variantId
   */
  async updateProductVariant(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId, variantId } = req.params;
      const {
        store_id,
        name,
        group_name,
        group_ui_type,
        options,
        price_adjustment,
        stock,
        sku,
        color_value,
        is_active,
        position,
        compare_at_price,
      } = req.body;

      const service = new StoreService(req.supabase);
      const variant = await service.updateProductVariant(
        store_id,
        productId,
        variantId,
        {
          name,
          group_name,
          group_ui_type,
          options,
          price_adjustment,
          stock,
          sku,
          color_value,
          is_active,
          position,
          compare_at_price,
        },
      );

      return ApiResponse.success(res, "Variant updated successfully", variant);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_VARIANT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete product variant
   * DELETE /api/store/product/:productId/variants/:variantId
   */
  async deleteProductVariant(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId, variantId } = req.params;
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      await service.deleteProductVariant(store_id, productId, variantId);

      return ApiResponse.success(res, "Variant deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_VARIANT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Reorder product variants
   * PUT /api/store/product/:productId/variants/reorder
   */
  async reorderProductVariants(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id, order } = req.body;

      const service = new StoreService(req.supabase);
      await service.reorderProductVariants(store_id, productId, order);

      return ApiResponse.success(res, "Variants reordered successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "REORDER_VARIANTS_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Product Versions
  // ============================================================================

  /**
   * Get product versions
   * GET /api/store/product/:productId/versions
   */
  async getProductVersions(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      const versions = await service.getProductVersions(store_id, productId);

      return ApiResponse.success(
        res,
        "Versions retrieved successfully",
        versions,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_VERSIONS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create product version
   * POST /api/store/product/:productId/versions
   */
  async createProductVersion(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId } = req.params;
      const { store_id, version_name, release_notes, is_active } = req.body;

      const service = new StoreService(req.supabase);
      const version = await service.createProductVersion(store_id, productId, {
        version_name,
        release_notes,
        is_active,
      });

      return ApiResponse.created(res, "Version created successfully", version);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_VERSION_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update product version
   * PUT /api/store/product/:productId/versions/:versionId
   */
  async updateProductVersion(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId, versionId } = req.params;
      const { store_id, version_name, release_notes, is_active } = req.body;

      const service = new StoreService(req.supabase);
      const version = await service.updateProductVersion(
        store_id,
        productId,
        versionId,
        {
          version_name,
          release_notes,
          is_active,
        },
      );

      return ApiResponse.success(res, "Version updated successfully", version);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_VERSION_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Activate product version
   * PUT /api/store/product/:productId/versions/:versionId/activate
   */
  async activateProductVersion(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId, versionId } = req.params;
      const { store_id } = req.body;

      const service = new StoreService(req.supabase);
      const version = await service.activateProductVersion(
        store_id,
        productId,
        versionId,
      );

      return ApiResponse.success(
        res,
        "Version activated successfully",
        version,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "ACTIVATE_VERSION_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete product version
   * DELETE /api/store/product/:productId/versions/:versionId
   */
  async deleteProductVersion(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId, versionId } = req.params;
      const { store_id } = req.query as any;

      const service = new StoreService(req.supabase);
      await service.deleteProductVersion(store_id, productId, versionId);

      return ApiResponse.success(res, "Version deleted successfully", null);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_VERSION_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Get public product variants (no auth)
   * GET /api/store/public/:slug/products/:productId/variants
   */
  async getPublicProductVariants(req: any, res: Response): Promise<Response> {
    try {
      const { slug, productId } = req.params;

      const service = new StoreService(req.supabase);
      const variants = await service.getPublicProductVariants(slug, productId);

      return ApiResponse.success(
        res,
        "Variants retrieved successfully",
        variants,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_VARIANTS_ERROR",
        message: err.message,
      });
    }
  }

  async getPublicProductModifierGroups(req: any, res: Response): Promise<Response> {
    try {
      const { slug, productId } = req.params;
      const branchId = (req.query.branch_id as string) || undefined;

      const service = new StoreService(req.supabase);
      const groups = await service.getPublicProductModifierGroups(slug, productId, branchId);

      return ApiResponse.success(
        res,
        "Modifier groups retrieved successfully",
        groups,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_MODIFIER_GROUPS_ERROR",
        message: err.message,
      });
    }
  }

  async getPublicStoreBranches(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;

      const service = new StoreService(req.supabase);
      const branches = await service.getPublicStoreBranches(slug);

      return ApiResponse.success(
        res,
        "Branches retrieved successfully",
        branches,
      );
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_BRANCHES_ERROR",
        message: err.message,
      });
    }
  }

  async getPublicStoreMenus(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const branchId = (req.query.branch_id as string) || undefined;

      const service = new StoreService(req.supabase);
      const menus = await service.getPublicStoreMenus(slug, branchId);

      return ApiResponse.success(res, "Menus retrieved successfully", menus);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_PUBLIC_MENUS_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Inventory Management
  // ============================================================================

  /**
   * Get stock movement history for a product
   * GET /api/store/products/:productId/stock-history
   */
  async getStockHistory(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { productId } = req.params;
      const { limit } = req.query as { limit?: string };

      if (!productId) {
        return ApiResponse.badRequest(res, "productId is required");
      }

      const { InventoryService } =
        await import("../services/inventory.service");
      const inventoryService = new InventoryService(req.supabase);

      const history = await inventoryService.getStockHistory(
        productId,
        limit ? parseInt(limit, 10) : 50,
      );

      return ApiResponse.success(res, "Stock history retrieved", history);
    } catch (err: any) {
      console.error("[StoreController.getStockHistory]", err);
      return ApiResponse.serverError(res, err.message);
    }
  }

  /**
   * Upload product image
   * POST /api/store/product/upload/image
   */
  async uploadProductImage(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    if (!req.file) {
      return ApiResponse.badRequest(res, "No file uploaded");
    }

    const { store_id, product_id, asset_type = "cover" } = req.body;
    const businessId = req.businessId;

    if (!store_id || !product_id) {
      return ApiResponse.badRequest(res, "Store ID and Product ID required");
    }

    try {
      const service = new StoreService(req.supabase);
      // Validate ownership/context
      await service.validateStoreOwnership(store_id, req.user_id!, businessId!);

      const result = await service.uploadProductImage(
        store_id,
        product_id,
        asset_type as any,
        req.file,
      );

      return ApiResponse.success(res, "Product image uploaded", result);
    } catch (error: any) {
      console.error("UPLOAD_PRODUCT_IMAGE_ERROR:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Upload product file (for digital products)
   * POST /api/store/product/upload/file
   */
  async uploadProductFile(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    if (!req.file) {
      return ApiResponse.badRequest(res, "No file uploaded");
    }

    const { store_id, product_id } = req.body;
    const businessId = req.businessId;

    if (!store_id || !product_id) {
      return ApiResponse.badRequest(res, "Store ID and Product ID required");
    }

    try {
      const service = new StoreService(req.supabase);
      // Validate ownership/context
      await service.validateStoreOwnership(store_id, req.user_id!, businessId!);

      const result = await service.uploadProductFile(
        store_id,
        product_id,
        req.file,
      );

      return ApiResponse.success(res, "Product file uploaded", result);
    } catch (error: any) {
      console.error("UPLOAD_PRODUCT_FILE_ERROR:", error);
      return ApiResponse.error(
        res,
        error.message || "Failed to upload product file",
        error.statusCode || error.status || 500,
      );
    }
  }

  /**
   * Create signed product file upload URL
   * POST /api/store/product/upload/file/sign
   */
  async createProductFileUploadUrl(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    const { store_id, product_id, file_name, file_size, mime_type } = req.body;
    const businessId = req.businessId;

    if (!store_id || !product_id || !file_name || !file_size || !mime_type) {
      return ApiResponse.badRequest(
        res,
        "Store ID, Product ID, file name, file size, and MIME type are required",
      );
    }

    try {
      const service = new StoreService(req.supabase);
      await service.validateStoreOwnership(store_id, req.user_id!, businessId!);

      const result = await service.createProductFileUploadUrl(
        store_id,
        product_id,
        {
          name: file_name,
          size: Number(file_size),
          type: mime_type,
        },
      );

      return ApiResponse.success(res, "Product file upload URL created", result);
    } catch (error: any) {
      console.error("CREATE_PRODUCT_FILE_UPLOAD_URL_ERROR:", error);
      return ApiResponse.error(
        res,
        error.message || "Failed to create product file upload URL",
        error.statusCode || error.status || 500,
      );
    }
  }
}

export const storeController = new StoreController();
