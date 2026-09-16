import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { BookkeepingService } from "../services/bookkeeping.service";
import { ApiResponse } from "../utils/apiResponse";

export class BookkeepingController {
  constructor() {}

  /**
   * GET /api/bookkeeping/ledger?businessId=...
   */
  async getLedger(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { businessId } = req.query;
      const { type, category, startDate, endDate, page, limit } = req.query;

      if (!businessId) {
        return ApiResponse.badRequest(res, "businessId is required");
      }

      const service = new BookkeepingService(req.supabase);
      const data = await service.getLedger({
        business_id: businessId as string,
        type: type as any,
        category: category as string,
        startDate: startDate as string,
        endDate: endDate as string,
        page: Number(page) || 1,
        limit: Number(limit) || 20,
      });

      return ApiResponse.success(res, "Ledger retrieved", data);
    } catch (err: any) {
      console.error("[BookkeepingController.getLedger] Error:", err);
      return ApiResponse.serverError(res, err.message);
    }
  }

  /**
   * GET /api/bookkeeping/summary?businessId=...
   */
  async getSummary(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { businessId, startDate, endDate } = req.query;

      if (!businessId) {
        return ApiResponse.badRequest(res, "businessId is required");
      }

      const service = new BookkeepingService(req.supabase);
      const data = await service.getSummary(
        businessId as string,
        startDate as string,
        endDate as string,
      );

      return ApiResponse.success(res, "Summary retrieved", data);
    } catch (err: any) {
      console.error("[BookkeepingController.getSummary] Error:", err);
      return ApiResponse.serverError(res, err.message);
    }
  }

  /**
   * POST /api/bookkeeping/transactions
   */
  async createTransaction(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const {
        business_id,
        type,
        amount,
        category,
        description,
        transaction_date,
        reference_id,
        reference_type,
        receipt_url,
      } = req.body;

      if (!business_id || !type || !amount || !category) {
        return ApiResponse.badRequest(res, "Missing required fields");
      }

      const service = new BookkeepingService(req.supabase);
      const data = await service.createTransaction({
        business_id,
        type,
        amount: Number(amount),
        category,
        description,
        transaction_date: transaction_date || new Date().toISOString(),
        reference_id,
        reference_type: reference_type || "manual",
        receipt_url,
      });

      return ApiResponse.success(res, "Transaction created", data);
    } catch (err: any) {
      console.error("[BookkeepingController.createTransaction] Error:", err);
      return ApiResponse.serverError(res, err.message);
    }
  }

  /**
   * PATCH /api/bookkeeping/transactions/:id
   */
  async updateTransaction(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { id } = req.params;
      const { business_id, ...updateData } = req.body;

      if (!business_id) {
        return ApiResponse.badRequest(res, "business_id is required");
      }

      const service = new BookkeepingService(req.supabase);
      const data = await service.updateTransaction(id, business_id, updateData);

      return ApiResponse.success(res, "Transaction updated", data);
    } catch (err: any) {
      console.error("[BookkeepingController.updateTransaction] Error:", err);
      return ApiResponse.serverError(res, err.message);
    }
  }

  /**
   * DELETE /api/bookkeeping/transactions/:id
   */
  async deleteTransaction(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { id } = req.params;
      const { businessId } = req.query;

      if (!businessId) {
        return ApiResponse.badRequest(
          res,
          "businessId query param is required",
        );
      }

      const service = new BookkeepingService(req.supabase);
      await service.deleteTransaction(id, businessId as string);

      return ApiResponse.success(res, "Transaction deleted");
    } catch (err: any) {
      console.error("[BookkeepingController.deleteTransaction] Error:", err);
      return ApiResponse.serverError(res, err.message);
    }
  }
}
