import { Request, Response } from "express";
import { AvailabilityService } from "../services/availability.service";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";

class AvailabilityController {
  /**
   * List all profiles for the authenticated user
   */
  async listProfiles(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const businessId = authReq.businessId!;
      console.log(`[AvailabilityController] Listing profiles for business: ${businessId}`);
      
      const service = new AvailabilityService(authReq.supabase);
      const profiles = await service.listProfiles(businessId);
      console.log(`[AvailabilityController] Found ${profiles.length} profiles`);
      
      return ApiResponse.success(res, "Profiles retrieved successfully", profiles);
    } catch (error: any) {
      console.error("[AvailabilityController.listProfiles]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get a single profile by ID
   */
  async getProfile(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const authReq = req as SupabaseRequest;
      const businessId = authReq.businessId!;
      const service = new AvailabilityService(authReq.supabase);
      const profile = await service.getProfile(id, businessId);
      return ApiResponse.success(res, "Profile retrieved successfully", profile);
    } catch (error: any) {
      if (error.statusCode === 404) {
        return ApiResponse.notFound(res, error.message);
      }
      console.error("[AvailabilityController.getProfile]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Create a new availability profile
   */
  async createProfile(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const businessId = authReq.businessId!;
      const payload = req.body;
      const service = new AvailabilityService(authReq.supabase);
      const profile = await service.createProfile(businessId, payload);
      return ApiResponse.created(res, "Profile created successfully", profile);
    } catch (error: any) {
      if (error.statusCode === 400) {
        return ApiResponse.badRequest(res, error.message);
      }
      console.error("[AvailabilityController.createProfile]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Update an existing profile
   */
  async updateProfile(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const authReq = req as SupabaseRequest;
      const businessId = authReq.businessId!;
      const payload = req.body;
      const service = new AvailabilityService(authReq.supabase);
      const profile = await service.updateProfile(id, businessId, payload);
      return ApiResponse.success(res, "Profile updated successfully", profile);
    } catch (error: any) {
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      if (error.statusCode === 400) return ApiResponse.badRequest(res, error.message);
      console.error("[AvailabilityController.updateProfile]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Duplicate an existing profile
   */
  async duplicateProfile(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const authReq = req as SupabaseRequest;
      const businessId = authReq.businessId!;
      const service = new AvailabilityService(authReq.supabase);
      const profile = await service.duplicateProfile(id, businessId);
      return ApiResponse.created(res, "Profile duplicated successfully", profile);
    } catch (error: any) {
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[AvailabilityController.duplicateProfile]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Delete a profile
   */
  async deleteProfile(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const authReq = req as SupabaseRequest;
      const businessId = authReq.businessId!;
      const service = new AvailabilityService(authReq.supabase);
      await service.deleteProfile(id, businessId);
      return ApiResponse.success(res, "Profile deleted successfully");
    } catch (error: any) {
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      if (error.statusCode === 400) return ApiResponse.badRequest(res, error.message);
      console.error("[AvailabilityController.deleteProfile]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Check current availability of a product
   */
  async checkAvailability(req: Request, res: Response) {
    try {
      const { productId } = req.params;
      const authReq = req as SupabaseRequest;
      const service = new AvailabilityService(authReq.supabase);
      const status = await service.checkProductAvailability(productId);
      return ApiResponse.success(res, "Availability status retrieved successfully", status);
    } catch (error: any) {
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[AvailabilityController.checkAvailability]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Check current availability of a store by slug
   */
  async checkStoreAvailability(req: Request, res: Response) {
    try {
      const { slug } = req.params;
      const authReq = req as SupabaseRequest;
      const service = new AvailabilityService(authReq.supabase);
      const status = await service.checkStoreAvailability(slug);
      return ApiResponse.success(res, "Store availability status retrieved successfully", status);
    } catch (error: any) {
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[AvailabilityController.checkStoreAvailability]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }
  /**
   * Get available time slots for a product on a specific date
   * GET /api/availability/slots?product_id=...&date=...
   */
  async getAvailableSlots(req: Request, res: Response) {
    try {
      const { product_id, date } = req.query as { product_id: string; date: string };
      
      if (!product_id || !date) {
        return ApiResponse.badRequest(res, "product_id and date are required");
      }

      const authReq = req as SupabaseRequest;
      const service = new AvailabilityService(authReq.supabase);
      
      const slots = await service.getAvailableSlots(product_id, date);
      
      return ApiResponse.success(res, "Available slots retrieved successfully", slots);
    } catch (error: any) {
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      if (error.statusCode === 400) return ApiResponse.badRequest(res, error.message);
      console.error("[AvailabilityController.getAvailableSlots]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get public availability profile by ID
   * GET /api/availability/public/:profileId
   */
  async getPublicProfile(req: Request, res: Response) {
    try {
      const { profileId } = req.params;
      
      if (!profileId) {
        return ApiResponse.badRequest(res, "profileId is required");
      }

      const authReq = req as SupabaseRequest;
      const service = new AvailabilityService(authReq.supabase);
      
      const profile = await service.getPublicProfile(profileId);
      
      return ApiResponse.success(res, "Profile retrieved successfully", profile);
    } catch (error: any) {
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[AvailabilityController.getPublicProfile]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }
}

export const availabilityController = new AvailabilityController();
