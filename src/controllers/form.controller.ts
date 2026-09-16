/**
 * Form Controller
 * Class-based controller following the StoreController pattern.
 */

import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";
import { FormService } from "../services/form.service";

class FormController {
  // ============================================================================
  // Organizer Endpoints (Authenticated)
  // ============================================================================

  /**
   * Create a new form
   * POST /api/forms
   */
  async createForm(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const {
        title,
        description,
        access_type,
        payment_amount,
        payment_currency,
        payment_label,
        paystack_subaccount_code,
        fields,
        settings,
        is_published,
      } = req.body;
      const businessId = req.businessId!;
      const userId = req.user_id!;

      if (!title || typeof title !== "string") {
        return ApiResponse.badRequest(res, "title is required");
      }

      const isDraft = is_published === false;
      const resolvedAccessType: 'free' | 'paid' = access_type === 'free' ? 'free' : 'paid';

      // Only enforce payment amount when publishing a paid form
      if (!isDraft && resolvedAccessType === 'paid' && (!payment_amount || Number(payment_amount) <= 0)) {
        return ApiResponse.badRequest(
          res,
          "payment_amount must be greater than 0 for paid forms.",
        );
      }

      const service = new FormService(req.supabase);
      const form = await service.createForm(userId, businessId, {
        title,
        description,
        access_type: resolvedAccessType,
        payment_amount: payment_amount ? Number(payment_amount) : 0,
        payment_currency,
        payment_label,
        paystack_subaccount_code,
        fields,
        settings,
        is_published: isDraft ? false : true,
      });

      return ApiResponse.created(res, "Form created successfully", form);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * Update a form
   * PATCH /api/forms/:formId
   */
  async updateForm(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { formId } = req.params;
      const businessId = req.businessId!;
      const {
        title,
        description,
        payment_amount,
        payment_currency,
        payment_label,
        paystack_subaccount_code,
        fields,
        settings,
      } = req.body;

      const service = new FormService(req.supabase);
      const updates: any = {};
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (payment_amount !== undefined)
        updates.payment_amount = Number(payment_amount);
      if (payment_currency !== undefined)
        updates.payment_currency = payment_currency;
      if (payment_label !== undefined) updates.payment_label = payment_label;
      if (paystack_subaccount_code !== undefined)
        updates.paystack_subaccount_code = paystack_subaccount_code;
      if (fields !== undefined) updates.fields = fields;
      if (settings !== undefined) updates.settings = settings;

      const form = await service.updateForm(formId, businessId, updates);
      return ApiResponse.success(res, "Form updated successfully", form);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * Delete (soft) a form
   * DELETE /api/forms/:formId
   */
  async deleteForm(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { formId } = req.params;
      const businessId = req.businessId!;

      const service = new FormService(req.supabase);
      await service.deleteForm(formId, businessId);
      return ApiResponse.success(res, "Form deleted successfully", null);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * List all forms for the business
   * GET /api/forms
   */
  async listForms(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const businessId = req.businessId!;
      const { page, limit } = req.query as any;

      const service = new FormService(req.supabase);
      const result = await service.getFormsByBusiness(businessId, {
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
      });

      return ApiResponse.success(res, "Forms retrieved successfully", result);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * Get a single form by ID
   * GET /api/forms/:formId
   */
  async getForm(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { formId } = req.params;
      const businessId = req.businessId!;

      const service = new FormService(req.supabase);
      const form = await service.getFormById(formId, businessId);
      return ApiResponse.success(res, "Form loaded successfully", form);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * Publish or unpublish a form
   * PATCH /api/forms/:formId/publish
   */
  async publishForm(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { formId } = req.params;
      const { is_published } = req.body;
      const businessId = req.businessId!;

      if (typeof is_published !== "boolean") {
        return ApiResponse.badRequest(
          res,
          "is_published (boolean) is required",
        );
      }

      const service = new FormService(req.supabase);

      // Validate before publishing
      if (is_published) {
        await service.publishForm(formId, businessId, true);
      }

      const form = await service.setPublished(formId, businessId, is_published);
      return ApiResponse.success(
        res,
        `Form ${is_published ? "published" : "unpublished"} successfully`,
        form,
      );
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * Get submissions for a form
   * GET /api/forms/:formId/submissions
   */
  async getSubmissions(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { formId } = req.params;
      const businessId = req.businessId!;
      const { page, limit } = req.query as any;

      const service = new FormService(req.supabase);
      const result = await service.getSubmissions(formId, businessId, {
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 50,
      });

      return ApiResponse.success(
        res,
        "Submissions retrieved successfully",
        result,
      );
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  // ============================================================================
  // Public Endpoints (No Auth)
  // ============================================================================

  /**
   * Get public form by slug
   * GET /api/forms/public/:slug
   */
  async getPublicForm(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const service = new FormService(req.supabase);
      const form = await service.getPublicForm(slug);

      // Return only public-safe fields
      const { user_id, business_id, paystack_subaccount_code, ...publicForm } =
        form as any;
      return ApiResponse.success(res, "Form loaded successfully", publicForm);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * Initiate payment for a form submission
   * POST /api/forms/public/:slug/pay
   * Body: { form_data: Record<string, any>, submitter_email, submitter_name, callback_url? }
   * Returns: { authorization_url, reference }
   */
  async initiateFormPayment(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const { form_data, submitter_email, submitter_name, callback_url } =
        req.body;

      if (!submitter_email) {
        return ApiResponse.badRequest(res, "submitter_email is required");
      }
      if (!form_data || typeof form_data !== "object") {
        return ApiResponse.badRequest(res, "form_data is required");
      }

      const service = new FormService(req.supabase);
      const result = await service.initiateFormPayment(
        slug,
        form_data,
        submitter_email,
        submitter_name || "",
        callback_url,
      );

      return ApiResponse.success(res, "Payment initiated", result);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * Submit a free form directly (no payment)
   * POST /api/forms/public/:slug/submit
   * Body: { form_data, submitter_email?, submitter_name? }
   */
  async submitFreeForm(req: any, res: Response): Promise<Response> {
    try {
      const { slug } = req.params;
      const { form_data, submitter_email, submitter_name } = req.body;

      if (!form_data || typeof form_data !== "object") {
        return ApiResponse.badRequest(res, "form_data is required");
      }

      const service = new FormService(req.supabase);
      const result = await service.submitFreeForm(
        slug,
        form_data,
        submitter_email,
        submitter_name,
      );

      return ApiResponse.created(res, "Submission received", result);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }

  /**
   * Get submission by payment reference (for post-payment success page)
   * GET /api/forms/public/submission/ref/:reference
   */
  async getSubmissionByReference(req: any, res: Response): Promise<Response> {
    try {
      const { reference } = req.params;
      const service = new FormService(req.supabase);
      const submission = await service.getSubmissionByReference(reference);

      if (!submission) {
        // May not be created yet if webhook hasn't fired — return pending state
        return ApiResponse.success(res, "Submission not confirmed yet", {
          status: "pending",
        });
      }

      return ApiResponse.success(res, "Submission retrieved", submission);
    } catch (err: any) {
      return res
        .status(err?.statusCode || 500)
        .json({ success: false, message: err.message });
    }
  }
}

export const formController = new FormController();
