import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { CommunicationsService as communicationsService } from "../services/communications.service";

/**
 * Communications Controller - Handles domain and sender management
 */
class CommunicationsController {
  // ============================================================================
  // Domains
  // ============================================================================

  /**
   * GET /api/communications/domains
   */
  async getDomains(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const domains = await service.getDomains(businessId);

      return res.status(200).json({
        success: true,
        data: { domains },
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_DOMAINS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/communications/domains
   */
  async addDomain(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { domain } = req.body;
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const result = await service.addDomain(businessId, req.user_id!, domain);

      return res.status(201).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "ADD_DOMAIN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/communications/domains/:id/verify
   */
  async verifyDomain(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const result = await service.verifyDomain(businessId, id);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "VERIFY_DOMAIN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * DELETE /api/communications/domains/:id
   */
  async deleteDomain(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      await service.deleteDomain(businessId, id);

      return res.status(200).json({
        success: true,
        message: "Domain deleted",
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_DOMAIN_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Senders
  // ============================================================================

  /**
   * GET /api/communications/senders
   */
  async getSenders(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const senders = await service.getSenders(businessId);

      return res.status(200).json({
        success: true,
        data: { senders },
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_SENDERS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/communications/senders/default
   */
  async getDefaultSender(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const sender = await service.getDefaultSender(businessId);

      return res.status(200).json({
        success: true,
        data: sender,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_DEFAULT_SENDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/communications/senders/:id
   */
  async getSender(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const sender = await service.getSender(businessId, id);

      return res.status(200).json({
        success: true,
        data: sender,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_SENDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/communications/senders
   */
  async createSender(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const sender = await service.createSender(businessId, req.user_id!, req.body);

      return res.status(201).json({
        success: true,
        data: sender,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_SENDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * PATCH /api/communications/senders/:id
   */
  async updateSender(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const sender = await service.updateSender(businessId, id, req.body);

      return res.status(200).json({
        success: true,
        data: sender,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_SENDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/communications/senders/:id/default
   */
  async setDefaultSender(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      const sender = await service.setDefaultSender(businessId, id);

      return res.status(200).json({
        success: true,
        data: sender,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "SET_DEFAULT_SENDER_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * DELETE /api/communications/senders/:id
   */
  async deleteSender(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = req.businessId!;
      const service = new communicationsService(req.supabase);
      await service.deleteSender(businessId, id);

      return res.status(200).json({
        success: true,
        message: "Sender deleted",
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_SENDER_ERROR",
        message: err.message,
      });
    }
  }
}

export const communicationsController = new CommunicationsController();
export default CommunicationsController;
