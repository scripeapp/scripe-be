import { Response } from "express";
import { FinancialsService } from "../services/financials.service";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";

export class FinancialsController {
  getSummary = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const { startDate, endDate } = req.query;

      const service = new FinancialsService(req.supabase);
      const summary = await service.getSummary(businessId, {
        startDate: startDate as string,
        endDate: endDate as string,
      });

      return ApiResponse.success(res, "Financial summary retrieved", summary);
    } catch (error: any) {
      console.error("[FinancialsController.getSummary] Error:", error);
      return res.status(500).json({ error: error.message });
    }
  };

  getLedger = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const {
        startDate,
        endDate,
        source,
        status,
        customer,
        amountMin,
        amountMax,
        page,
        limit,
      } = req.query;

      const service = new FinancialsService(req.supabase);
      const ledger = await service.getLedger(
        businessId,
        {
          startDate: startDate as string,
          endDate: endDate as string,
          source: source as any,
          status: status as string,
          customer: customer as string,
          amountMin: amountMin ? Number(amountMin) : undefined,
          amountMax: amountMax ? Number(amountMax) : undefined,
        },
        Number(page || 1),
        Number(limit || 50),
      );

      return ApiResponse.success(res, "Financial ledger retrieved", ledger);
    } catch (error: any) {
      console.error("[FinancialsController.getLedger] Error:", error);
      return res.status(500).json({ error: error.message });
    }
  };

  createExpense = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const service = new FinancialsService(req.supabase);
      const expense = await service.createExpense(businessId, req.body);
      return ApiResponse.created(res, "Expense created successfully", expense);
    } catch (error: any) {
      console.error("[FinancialsController.createExpense] Error:", error);
      return res.status(500).json({ error: error.message });
    }
  };

  getExpenses = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const { startDate, endDate, category, amountMin, amountMax } = req.query;

      const service = new FinancialsService(req.supabase);
      const expenses = await service.getExpenses(businessId, {
        startDate: startDate as string,
        endDate: endDate as string,
        category: category as string,
        amountMin: amountMin ? Number(amountMin) : undefined,
        amountMax: amountMax ? Number(amountMax) : undefined,
      });
      return ApiResponse.success(res, "Expenses retrieved", expenses);
    } catch (error: any) {
      console.error("[FinancialsController.getExpenses] Error:", error);
      return res.status(500).json({ error: error.message });
    }
  };

  updateExpense = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const { id } = req.params;
      const service = new FinancialsService(req.supabase);
      const expense = await service.updateExpense(businessId, id, req.body);
      return ApiResponse.success(res, "Expense updated successfully", expense);
    } catch (error: any) {
      console.error("[FinancialsController.updateExpense] Error:", error);
      return res.status(500).json({ error: error.message });
    }
  };

  deleteExpense = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const { id } = req.params;
      const service = new FinancialsService(req.supabase);
      await service.deleteExpense(businessId, id);
      return ApiResponse.success(res, "Expense deleted successfully");
    } catch (error: any) {
      console.error("[FinancialsController.deleteExpense] Error:", error);
      return res.status(500).json({ error: error.message });
    }
  };

  getSettlements = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const service = new FinancialsService(req.supabase);
      const settlements = await service.getSettlements(businessId);
      return ApiResponse.success(res, "Settlements retrieved", settlements);
    } catch (error: any) {
      console.error("[FinancialsController.getSettlements] Error:", error);
      return res.status(500).json({ error: error.message });
    }
  };

  getPayoutRequests = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const service = new FinancialsService(req.supabase);
      const requests = await service.getPayoutRequests(businessId);
      return ApiResponse.success(res, "Payout requests retrieved", requests);
    } catch (error: any) {
      console.error("[FinancialsController.getPayoutRequests] Error:", error);
      return res.status(500).json({ error: error.message });
    }
  };

  requestPayout = async (req: SupabaseRequest, res: Response) => {
    try {
      const businessId = req.businessId!;
      const requestedBy = req.user_id!;
      const amount = Number(req.body?.amount);

      const service = new FinancialsService(req.supabase);
      const request = await service.requestPayout(
        businessId,
        requestedBy,
        amount,
      );
      return ApiResponse.created(res, "Payout requested", request);
    } catch (error: any) {
      console.error("[FinancialsController.requestPayout] Error:", error);
      const status = error.statusCode || 500;
      return res.status(status).json({ error: error.message });
    }
  };
}
