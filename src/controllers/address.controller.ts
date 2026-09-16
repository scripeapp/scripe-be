import { Response } from "express";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";
import { AddressService } from "../services/address.service";

/**
 * Address Controller
 * Handles user saved addresses CRUD operations
 */
class AddressController {
  /**
   * List all addresses for the authenticated user
   * GET /api/user/addresses
   */
  async listAddresses(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const service = new AddressService(req.supabase!);
      const addresses = await service.listAddresses(req.user_id!);

      return ApiResponse.success(res, "Addresses retrieved successfully", addresses);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "LIST_ADDRESSES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Create a new address
   * POST /api/user/addresses
   */
  async createAddress(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const service = new AddressService(req.supabase!);
      const address = await service.createAddress(req.user_id!, req.body);

      return ApiResponse.created(res, "Address created successfully", address);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_ADDRESS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Update an existing address
   * PATCH /api/user/addresses/:id
   */
  async updateAddress(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const service = new AddressService(req.supabase!);
      const address = await service.updateAddress(req.user_id!, id, req.body);

      return ApiResponse.success(res, "Address updated successfully", address);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_ADDRESS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Delete an address
   * DELETE /api/user/addresses/:id
   */
  async deleteAddress(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const service = new AddressService(req.supabase!);
      await service.deleteAddress(req.user_id!, id);

      return ApiResponse.success(res, "Address deleted successfully");
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_ADDRESS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Set an address as default
   * PATCH /api/user/addresses/:id/default
   */
  async setDefaultAddress(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const service = new AddressService(req.supabase!);
      const address = await service.setDefaultAddress(req.user_id!, id);

      return ApiResponse.success(res, "Default address set successfully", address);
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "SET_DEFAULT_ADDRESS_ERROR",
        message: err.message,
      });
    }
  }
}

export const addressController = new AddressController();
