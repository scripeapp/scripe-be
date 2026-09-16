import { Response } from "express";
import ApiResponse from "../utils/apiResponse";
import PaymentService from "../services/payment.service";
import { SupabaseRequest } from "../types/http";

class PaymentController {
  /**
   * GET /api/payments/verify/:reference
   * Optional auth — order-success pages are public. Returns the raw Paystack
   * transaction record for any status.
   */
  async verify(req: SupabaseRequest, res: Response) {
    try {
      const { reference } = req.params;
      const data = await PaymentService.verifyTransaction(
        req.supabase!,
        reference,
      );
      return ApiResponse.success(res, "Transaction fetched", data);
    } catch (error: any) {
      if (error.message?.includes("not found") || error.message?.includes("Invalid transaction reference")) {
        return ApiResponse.notFound(res, error.message);
      }
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * GET /api/payments/billing-history
   * Requires auth. Returns the caller's own Paystack billing history.
   */
  async billingHistory(req: SupabaseRequest, res: Response) {
    try {
      const data = await PaymentService.getBillingHistory(
        req.supabase!,
        req.user_id!,
      );
      return ApiResponse.success(res, "Billing history fetched", data);
    } catch (error: any) {
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * GET /api/payments/transactions
   * Requires auth + rm.analytics.view. A business's store checkout payment
   * records, paginated, most recent first.
   */
  async listTransactions(req: SupabaseRequest, res: Response) {
    try {
      const businessId = String(req.query.business_id);
      const page = Number(req.query.page ?? 1);
      const limit = Number(req.query.limit ?? 50);
      const transactions = await PaymentService.listPaymentTransactions(
        req.supabase!,
        businessId,
        page,
        limit,
      );
      return ApiResponse.success(res, "Payment transactions fetched", transactions);
    } catch (error: any) {
      return ApiResponse.serverError(res, error.message);
    }
  }
}

export default new PaymentController();
