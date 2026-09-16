import { Request, Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import ApiResponse from "../utils/apiResponse";
import { supabase as publicSupabase } from "../config/supabase";
import { BusinessService } from "../services/business.service";

interface AuthenticatedRequest extends Request {
  user_id?: string;
  supabase?: SupabaseClient;
  businessId?: string;
  user?: { id: string; email?: string | null };
}

export class BusinessController {
  /**
   * Get all businesses for the current user
   */
  static async getMyBusinesses(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const userId = req.user_id!;

      const businessService = new BusinessService(db);
      const businesses = await businessService.getUserBusinesses(userId);

      return res.json({ success: true, data: businesses });
    } catch (error: any) {
      console.error("[getMyBusinesses] Error:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "Failed to fetch businesses",
      });
    }
  }

  /**
   * Get a single business
   */
  static async getBusiness(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const { businessId } = req.params;

      const businessService = new BusinessService(db);
      const business = await businessService.getBusinessById(businessId);

      if (!business) {
        return res
          .status(404)
          .json({ success: false, error: "Business not found" });
      }

      return res.json({ success: true, data: business });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch business",
      });
    }
  }

  /**
   * Get a single business by slug
   */
  static async getBusinessBySlug(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase || publicSupabase;
      const { slug } = req.params;

      const businessService = new BusinessService(db);
      const business = await businessService.getBusinessBySlug(slug);

      if (!business) {
        return res
          .status(404)
          .json({ success: false, error: "Business not found" });
      }

      return res.json({ success: true, data: business });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch business",
      });
    }
  }

  /**
   * Get enriched public business profile — includes events, circles, products,
   * publication, owner info. Powers the elevated /b/[slug] creator page.
   */
  static async getBusinessPublicProfile(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase || publicSupabase;
      const { slug } = req.params;

      const businessService = new BusinessService(db);
      const profile = await businessService.getBusinessPublicProfile(slug);

      if (!profile) {
        return res.status(404).json({ success: false, error: "Business not found" });
      }

      return res.json({ success: true, data: profile });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch business profile",
      });
    }
  }

  /**
   * Check if user has any businesses (for onboarding flow)
   */
  static async checkHasBusinesses(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const userId = req.user_id!;

      const businessService = new BusinessService(db);
      const hasBusinesses = await businessService.userHasBusinesses(userId);

      return res.json({ success: true, data: { hasBusinesses } });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || "Failed to check businesses",
      });
    }
  }

  /**
   * Create a new business
   */
  static async createBusiness(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const userId = req.user_id!;
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          error: "Business name is required",
        });
      }

      const businessService = new BusinessService(db);
      const business = await businessService.createBusiness(userId, { name });

      return res.status(201).json({ success: true, data: business });
    } catch (error: any) {
      console.error("[createBusiness] Error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to create business",
      });
    }
  }

  /**
   * Update business details
   */
  static async updateBusiness(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const userId = req.user_id!;
      const { businessId } = req.params;
      const {
        name,
        marketplace_visibility,
        slug,
        cover_image,
        logo_url,
        primary_color,
        description,
        support_email,
        support_phone,
        currency,
        timezone,
        social_links,
        address,
        policies,
      } = req.body;

      // Validation
      if (support_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support_email)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid email format" });
      }
      if (primary_color && !/^#([0-9A-F]{3}){1,2}$/i.test(primary_color)) {
        return res.status(400).json({
          success: false,
          error: "Invalid hex color format (e.g. #FF0000)",
        });
      }

      const businessService = new BusinessService(db);
      const business = await businessService.updateBusiness(
        businessId,
        userId,
        {
          name,
          slug,
          marketplace_visibility,
          cover_image,
          logo_url,
          primary_color,
          description,
          support_email,
          support_phone,
          currency,
          timezone,
          social_links,
          address,
          policies,
        },
      );

      return res.json({ success: true, data: business });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to update business",
      });
    }
  }

  /**
   * Get all business categories
   */
  static async getBusinessCategories(req: AuthenticatedRequest, res: Response) {
    try {
      // Use public Supabase client or req.supabase (categories are public read)
      const db = req.supabase || publicSupabase;

      const businessService = new BusinessService(db);
      const categories = await businessService.getBusinessCategories();

      return res.json({ success: true, data: categories });
    } catch (error: any) {
      console.error("[getBusinessCategories] Error:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "Failed to fetch categories",
      });
    }
  }

  /**
   * Delete a business (Owner only)
   */
  static async deleteBusiness(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const { businessId } = req.params;

      const businessService = new BusinessService(db);
      await businessService.deleteBusiness(businessId);

      return res.json({ success: true, message: "Business deleted" });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to delete business",
      });
    }
  }

  // ===========================================================================
  // Subaccount Management
  // ===========================================================================

  /**
   * Get business subaccount settings
   */
  static async getSubaccount(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const { businessId } = req.params;

      const businessService = new BusinessService(db);
      const settings = await businessService.getSubaccountSettings(businessId);

      return res.json({ success: true, data: settings });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to get subaccount settings",
      });
    }
  }

  /**
   * Create or update business subaccount
   * Creates a Paystack subaccount if bank details provided, or updates fee bearer
   */
  static async updateSubaccount(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const { businessId } = req.params;
      const {
        business_name,
        settlement_bank,
        account_number,
        paystack_fee_bearer,
        settlement_schedule,
        flw_bank_code,
        flw_account_number,
        flw_country,
        business_email,
      } = req.body;

      const businessService = new BusinessService(db);
      const result = await businessService.updateSubaccount(businessId, {
        business_name,
        settlement_bank,
        account_number,
        paystack_fee_bearer,
        settlement_schedule,
        flw_bank_code,
        flw_account_number,
        flw_country,
        business_email,
        verification_code: req.body.verification_code,
      }, req.user_id);

      return res.json({
        success: true,
        message: "Subaccount settings updated",
        data: result,
      });
    } catch (error: any) {
      console.error("[updateSubaccount] Error:", error);
      const status = error.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: error.message || "Failed to update subaccount",
      });
    }
  }

  static async requestSubaccountChangeVerification(
    req: AuthenticatedRequest,
    res: Response,
  ) {
    try {
      const db = req.supabase!;
      const { businessId } = req.params;
      const email = req.user?.email || (await db.auth.getUser()).data.user?.email;
      const businessService = new BusinessService(db);
      const result = await businessService.requestSettlementAccountVerification(
        businessId,
        req.user_id!,
        email || "",
      );
      return res.json({ success: true, data: result });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to send verification code",
      });
    }
  }

  /**
   * Get subaccount by query param (GET /business/subaccount?business_id=xxx)
   */
  static async getSubaccountByQuery(req: AuthenticatedRequest, res: Response) {
    try {
      const db = req.supabase!;
      const business_id = req.query.business_id as string;

      if (!business_id) {
        return res.status(400).json({
          success: false,
          message: "business_id query parameter is required",
        });
      }

      const businessService = new BusinessService(db);
      const settings = await businessService.getSubaccountSettings(business_id);

      return res.json({ success: true, data: settings });
    } catch (error: any) {
      const status = error.statusCode || 500;
      return res.status(status).json({
        success: false,
        message: error.message || "Failed to get subaccount settings",
      });
    }
  }

  /**
   * Update subaccount by body (PATCH /business/subaccount)
   */
  static async updateSubaccountByQuery(
    req: AuthenticatedRequest,
    res: Response,
  ) {
    try {
      const db = req.supabase!;
      const {
        business_id,
        business_name,
        settlement_bank,
        account_number,
        paystack_fee_bearer,
        settlement_schedule,
        flw_bank_code,
        flw_account_number,
        flw_country,
        business_email,
      } = req.body;

      if (!business_id) {
        return res.status(400).json({
          success: false,
          message: "business_id is required",
        });
      }

      const businessService = new BusinessService(db);
      const result = await businessService.updateSubaccount(business_id, {
        business_name,
        settlement_bank,
        account_number,
        paystack_fee_bearer,
        settlement_schedule,
        flw_bank_code,
        flw_account_number,
        flw_country,
        business_email,
        verification_code: req.body.verification_code,
      }, req.user_id);

      return res.json({
        success: true,
        message: "Subaccount updated successfully",
        data: result,
      });
    } catch (error: any) {
      console.error("[updateSubaccountByQuery] Error:", error);
      const status = error.statusCode || 500;
      return res.status(status).json({
        success: false,
        message: error.message || "Failed to update subaccount",
      });
    }
  }

  /**
   * Get list of Nigerian banks (GET /banks)
   */
  static async getBanks(req: AuthenticatedRequest, res: Response) {
    try {
      const { listBanks } = await import("../utils/paystack.util");
      const banks = await listBanks();

      return res.json({ status: true, data: banks });
    } catch (error: any) {
      console.error("[getBanks] Error:", error);
      return res.status(500).json({
        status: false,
        message: error.message || "Failed to fetch banks",
      });
    }
  }


  /**
   * Upload business image (logo or banner)
   * POST /api/business/:businessId/upload
   */
  static async uploadBusinessImage(req: AuthenticatedRequest, res: Response) {
    if (!req.file) {
      return ApiResponse.badRequest(res, "No file uploaded");
    }

    const businessId = req.params.businessId || req.body.businessId;
    const { type = "logo" } = req.body;

    if (!businessId) {
      return ApiResponse.badRequest(res, "Business ID is required");
    }

    try {
      const db = req.supabase!;
      const businessService = new BusinessService(db);

      const result = await businessService.uploadBusinessImage(
        businessId,
        type as "logo" | "banner",
        req.file,
      );

      return ApiResponse.success(res, `${type} uploaded successfully`, result);
    } catch (error: any) {
      console.error("[uploadBusinessImage] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * GET /api/business/:businessId/branding
   * Returns branding assets (colors, fonts, logo) for the business
   */
  static async getBranding(req: AuthenticatedRequest, res: Response) {
    try {
      const { businessId } = req.params;
      
      const { data: business, error } = await req.supabase!
        .from("businesses")
        .select("branding, logo_url")
        .eq("id", businessId)
        .single();

      if (error) {
        return ApiResponse.serverError(res, error.message);
      }

      // Default branding structure if null
      const branding = (business?.branding as any) || {
        colors: { primary: "#000000", secondary: "#ffffff" },
        fonts: { body: "Inter", heading: "Inter" }
      };

      return ApiResponse.success(res, "Branding retrieved", { 
        ...branding,
        logo: business?.logo_url 
      });
    } catch (error: any) {
      console.error("[getBranding] Error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }
}
