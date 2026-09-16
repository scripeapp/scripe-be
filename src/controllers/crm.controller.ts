import { Response } from "express";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";
import CRMService from "../services/crm.service";
import { CampaignCreditsService } from "../services/campaign-credits.service";
import { uploadMulterFileToR2 } from "../utils/storage.util";

/**
 * CRM Controller
 * HTTP handlers for Contacts, Segments, and Campaigns
 */
class CRMController {
  // ============================================================================
  // Contacts
  // ============================================================================

  /**
   * GET /api/crm/contacts
   */
  async getContacts(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { page = "1", limit = "50", search, status, source, business_id } = req.query as any;

      const businessId = (req as any).businessId || business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.getContacts(businessId, req.user_id!, {
        page: parseInt(page),
        limit: parseInt(limit),
        search,
        status,
        source,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CONTACTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/contacts
   */
  async createContact(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const contact = await service.createContact(businessId, req.user_id!, req.body);

      return res.status(201).json({
        success: true,
        data: contact,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_CONTACT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * PATCH /api/crm/contacts/:id
   */
  async updateContact(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const contact = await service.updateContact(businessId, id, req.body);

      return res.status(200).json({
        success: true,
        data: contact,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_CONTACT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/crm/contacts/:id/segments
   */
  async getContactSegments(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.getContactSegments(businessId, id);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CONTACT_SEGMENTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/crm/contacts/:id/activities
   */
  async getContactActivities(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.getContactActivities(businessId, id);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CONTACT_ACTIVITIES_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * DELETE /api/crm/contacts/:id
   */
  async deleteContact(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      await service.deleteContact(businessId, id);

      return res.status(200).json({
        success: true,
        message: "Contact deleted",
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_CONTACT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/contacts/bulk
   */
  async bulkContacts(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { action, contact_ids, status } = req.body;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.bulkContactAction(
        businessId,
        action,
        contact_ids,
        status
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "BULK_CONTACT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/contacts/import
   */
  async importContacts(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { business_id, contacts, options } = req.body;
      const businessId = (req as any).businessId || business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.importContacts(businessId, req.user_id!, {
        contacts,
        options,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "IMPORT_CONTACTS_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Segments
  // ============================================================================

  /**
   * GET /api/crm/segments
   */
  async getSegments(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const segments = await service.getSegments(businessId);

      return res.status(200).json({
        success: true,
        data: { segments },
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_SEGMENTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/segments
   */
  async createSegment(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const segment = await service.createSegment(businessId, req.user_id!, req.body);

      return res.status(201).json({
        success: true,
        data: { segment },
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_SEGMENT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/segments/preview
   */
  async previewSegment(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.previewSegment(businessId, req.body);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "PREVIEW_SEGMENT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * PATCH /api/crm/segments/:id
   */
  async updateSegment(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const segment = await service.updateSegment(businessId, id, req.body);

      return res.status(200).json({
        success: true,
        data: segment,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_SEGMENT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * DELETE /api/crm/segments/:id
   */
  async deleteSegment(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      await service.deleteSegment(businessId, id);

      return res.status(200).json({
        success: true,
        message: "Segment deleted",
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_SEGMENT_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/crm/segments/:id/contacts
   */
  async getSegmentContacts(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const { page = "1", limit = "50", search } = req.query as any;
      const service = new CRMService(req.supabase);
      const result = await service.getSegmentContacts(businessId, id, {
        page: parseInt(page),
        limit: parseInt(limit),
        search,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_SEGMENT_CONTACTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/crm/segments/:id/activity
   */
  async getSegmentActivity(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.getSegmentActivity(businessId, id);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_SEGMENT_ACTIVITY_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/segments/:id/contacts
   */
  async addContactsToSegment(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { contact_ids } = req.body;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.addContactsToSegment(businessId, id, contact_ids);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "ADD_CONTACTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * DELETE /api/crm/segments/:id/contacts
   */
  async removeContactsFromSegment(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { contact_ids } = req.body;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.removeContactsFromSegment(businessId, id, contact_ids);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "REMOVE_CONTACTS_ERROR",
        message: err.message,
      });
    }
  }

  // ============================================================================
  // Campaigns
  // ============================================================================

  /**
   * GET /api/crm/campaigns
   */
  async getCampaigns(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { page = "1", limit = "20", status, business_id } = req.query as any;
      const businessId = (req as any).businessId || business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.getCampaigns(businessId, {
        page: parseInt(page),
        limit: parseInt(limit),
        status,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CAMPAIGNS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/crm/campaigns/:id
   */
  async getCampaign(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const campaign = await service.getCampaign(businessId, id);

      return res.status(200).json({
        success: true,
        data: campaign,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CAMPAIGN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/crm/campaigns/:id/stats
   */
  async getCampaignStats(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }
      const service = new CRMService(req.supabase);
      const stats = await service.getCampaignStats(businessId, id);
      return res.status(200).json({ success: true, data: stats });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({ success: false, error: "GET_CAMPAIGN_STATS_ERROR", message: err.message });
    }
  }

  /**
   * GET /api/crm/campaigns/:id/recipients
   */
  async getCampaignRecipients(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { page = "1", limit = "20", status } = req.query as Record<string, string>;
      const businessId = (req as any).businessId || req.query.business_id;

      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.getCampaignRecipients(businessId, id, {
        page: parseInt(page),
        limit: parseInt(limit),
        status: status || undefined,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CAMPAIGN_RECIPIENTS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/campaigns/validate-audience
   */
  async validateAudience(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { business_id } = req.body;
      const businessId = (req as any).businessId || business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.validateAudience(businessId, req.body);

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "VALIDATE_AUDIENCE_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * GET /api/crm/campaign-credits
   */
  async getCampaignCredits(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CampaignCreditsService(req.supabase);
      const credits = await service.getAccount(String(businessId));

      return res.status(200).json({
        success: true,
        data: credits,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "GET_CAMPAIGN_CREDITS_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/campaign-credits/top-up
   */
  async initializeCampaignCreditTopUp(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const businessId = (req as any).businessId || req.body.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CampaignCreditsService(req.supabase);
      const topUp = await service.initializeTopUp({
        businessId,
        userId: req.user_id!,
        email: req.user?.email,
        packageId: req.body.package_id,
        callbackUrl: req.body.callback_url,
      });

      return res.status(200).json({
        success: true,
        data: topUp,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "INITIALIZE_CAMPAIGN_CREDIT_TOPUP_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/campaigns
   */
  async createCampaign(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const campaign = await service.createCampaign(businessId, req.user_id!, req.body);

      return res.status(201).json({
        success: true,
        data: campaign,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "CREATE_CAMPAIGN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * PATCH /api/crm/campaigns/:id
   */
  async updateCampaign(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const campaign = await service.updateCampaign(businessId, id, req.body);

      return res.status(200).json({
        success: true,
        data: campaign,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "UPDATE_CAMPAIGN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * DELETE /api/crm/campaigns/:id
   */
  async deleteCampaign(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      await service.deleteCampaign(businessId, id);

      return res.status(200).json({
        success: true,
        message: "Campaign deleted",
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "DELETE_CAMPAIGN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/campaigns/:id/send
   */
  async sendCampaign(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const campaign = await service.sendCampaign(businessId, id);

      return res.status(200).json({
        success: true,
        data: campaign,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "SEND_CAMPAIGN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/campaigns/:id/retry
   * Retry a failed campaign
   */
  async retryCampaign(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const result = await service.retryCampaign(businessId, id);

      return res.status(200).json({
        success: true,
        message: "Campaign retry initiated",
        data: result.campaign,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "RETRY_CAMPAIGN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * POST /api/crm/campaigns/:id/schedule
   */
  async scheduleCampaign(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      const { scheduled_at } = req.body;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;
      if (!businessId) {
        return res.status(400).json({ success: false, error: "Business context required" });
      }

      const service = new CRMService(req.supabase);
      const campaign = await service.scheduleCampaign(businessId, id, scheduled_at);

      return res.status(200).json({
        success: true,
        data: campaign,
      });
    } catch (err: any) {
      const status = err?.statusCode || 500;
      return res.status(status).json({
        success: false,
        error: "SCHEDULE_CAMPAIGN_ERROR",
        message: err.message,
      });
    }
  }

  /**
   * Upload an image for CRM usage (e.g. emails)
   */
  async uploadImage(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const file = req.file;
      const businessId = (req as any).businessId || req.body.business_id || req.query.business_id;

      if (!file) {
        return ApiResponse.badRequest(res, "No file uploaded");
      }

      if (!businessId) {
        return ApiResponse.badRequest(res, "Business ID is required");
      }

      // Generate a safe filename
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
      const key = `crm/${businessId}/${timestamp}_${safeName}`;

      const url = await uploadMulterFileToR2(file, key);

      return ApiResponse.success(res, "Image uploaded successfully", { url });
    } catch (error: any) {
      console.error("Upload error:", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get reusable email templates
   */
  async getTemplates(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      // For now, return hardcoded standard templates
      // In future, this could fetch from a templates table
      const templates = [
        {
          id: "template_welcome",
          name: "Welcome Email",
          subject: "Welcome to our community!",
          html: '<div style="font-family: sans-serif; padding: 20px;"><h1>Welcome!</h1><p>Thanks for joining us. We are excited to have you on board.</p></div>',
          text: "Welcome! Thanks for joining us. We are excited to have you on board.",
          thumbnail: "",
        },
        {
          id: "template_newsletter",
          name: "Monthly Newsletter",
          subject: "This Month's Updates",
          html: '<div style="font-family: sans-serif; padding: 20px;"><h1>Monthly Newsletter</h1><p>Here are the latest updates from our team.</p></div>',
          text: "Monthly Newsletter. Here are the latest updates from our team.",
          thumbnail: "",
        },
        {
          id: "template_promo",
          name: "Promotional Offer",
          subject: "Special Offer For You",
          html: '<div style="font-family: sans-serif; padding: 20px;"><h1>Special Offer</h1><p>Don not miss out on our latest deal!</p><a href="#" style="background: #000; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Shop Now</a></div>',
          text: "Special Offer. Don not miss out on our latest deal! Shop Now.",
          thumbnail: "",
        }
      ];
      
      return ApiResponse.success(res, "Templates retrieved", { templates });
    } catch (error: any) {
      return ApiResponse.serverError(res, error.message);
    }
  }
}

export const crmController = new CRMController();
export default CRMController;
