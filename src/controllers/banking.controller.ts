import { Response } from "express";
import { BankingService } from "../services/banking.service";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";

export class BankingController {
  getStatus = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = String(req.query.business_id);
      const service = new BankingService(req.supabase);
      const status = await service.getStatus(businessId);
      return ApiResponse.success(res, "Banking status retrieved", status);
    } catch (error: any) {
      return this.handleError(res, "getStatus", error);
    }
  };

  submitKyc = async (req: SupabaseRequest, res: Response) => {
    try {
      const service = new BankingService(req.supabase);
      const result = await service.submitKyc(req.body);
      return ApiResponse.success(res, "Banking KYC submitted", result);
    } catch (error: any) {
      return this.handleError(res, "submitKyc", error);
    }
  };

  requestVirtualAccount = async (req: SupabaseRequest, res: Response) => {
    try {
      const service = new BankingService(req.supabase);
      const account = await service.requestVirtualAccount(req.body);
      return ApiResponse.created(res, "Virtual account requested", account);
    } catch (error: any) {
      return this.handleError(res, "requestVirtualAccount", error);
    }
  };

  requeryVirtualAccount = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = String(req.body.business_id);
      const service = new BankingService(req.supabase);
      const account = await service.requeryVirtualAccount(businessId);
      return ApiResponse.success(res, "Virtual account refreshed", account);
    } catch (error: any) {
      return this.handleError(res, "requeryVirtualAccount", error);
    }
  };

  listTransactions = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = String(req.query.business_id);
      const page = Number(req.query.page ?? 1);
      const limit = Number(req.query.limit ?? 50);
      const service = new BankingService(req.supabase);
      const transactions = await service.listTransactions(businessId, page, limit);
      return ApiResponse.success(res, "Banking transactions retrieved", transactions);
    } catch (error: any) {
      return this.handleError(res, "listTransactions", error);
    }
  };

  resolveBankAccount = async (req: SupabaseRequest, res: Response) => {
    try {
      const service = new BankingService(req.supabase);
      const account = await service.resolveBankAccount({
        business_id: String(req.query.business_id),
        account_number: String(req.query.account_number),
        bank_code: String(req.query.bank_code),
      });
      return ApiResponse.success(res, "Bank account resolved", account);
    } catch (error: any) {
      return this.handleError(res, "resolveBankAccount", error);
    }
  };

  requestWithdrawal = async (req: SupabaseRequest, res: Response) => {
    try {
      const service = new BankingService(req.supabase);
      const withdrawal = await service.requestWithdrawal(
        req.body.business_id,
        req.user_id,
        req.body,
      );
      return ApiResponse.created(res, "Withdrawal requested", withdrawal);
    } catch (error: any) {
      return this.handleError(res, "requestWithdrawal", error);
    }
  };

  finalizeWithdrawal = async (req: SupabaseRequest, res: Response) => {
    try {
      const service = new BankingService(req.supabase);
      const withdrawal = await service.finalizeWithdrawal(req.body);
      return ApiResponse.success(res, "Withdrawal finalized", withdrawal);
    } catch (error: any) {
      return this.handleError(res, "finalizeWithdrawal", error);
    }
  };

  resetBvnPin = async (req: SupabaseRequest, res: Response) => {
    try {
      const service = new BankingService(req.supabase);
      await service.resetBvnPin(req.body.business_id, req.body.bvn_last4);
      return ApiResponse.success(res, "Transaction PIN unlocked", {
        has_pin: true,
        pin_locked_until: null,
      });
    } catch (error: any) {
      return this.handleError(res, "resetBvnPin", error);
    }
  };

  private handleError(res: Response, action: string, error: any) {
    console.error(`[BankingController.${action}] Error:`, error);
    return ApiResponse.error(
      res,
      error?.message || "Banking request failed",
      error?.statusCode || 500,
      error?.details,
    );
  }
}
