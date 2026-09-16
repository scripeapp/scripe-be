/**
 * Form Service
 * Handles all Hilaq Forms operations.
 *
 * Payment flow:
 * - Paid forms: Paystack transaction initialized on submission; no DB record until webhook confirms.
 * - Free forms: submission written directly to DB via submitFreeForm(); no payment step.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type { FeeBearer } from "../types/payment";
import supabaseAdmin from "../config/supabaseAdmin";
import axios from "axios";
import { PaymentProviderFactory } from "../utils/payment";
import type { SupportedCurrency } from "../utils/payment";
import { resolvePaymentProvider } from "../utils/payment/fees";

// Slug generation utility (simple, URL-friendly)
function generateSlug(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

export interface FormField {
  id: string;
  type:
    | "short_text"
    | "long_text"
    | "email"
    | "phone"
    | "number"
    | "dropdown"
    | "checkbox"
    | "date";
  label: string;
  placeholder?: string;
  required: boolean;
  options?: string[]; // for dropdown / checkbox
}

export interface HilaqForm {
  id: string;
  business_id: string;
  user_id: string;
  title: string;
  description?: string;
  slug: string;
  is_published: boolean;
  access_type: 'free' | 'paid';
  payment_amount: number;
  payment_currency: string;
  payment_label: string;
  paystack_subaccount_code?: string;
  fields: FormField[];
  settings: {
    confirmation_message?: string;
    redirect_url?: string | null;
  };
  submissions_count: number;
  paid_submissions_count: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export class FormService {
  constructor(private supabase: SupabaseClient) {}

  private async getBusinessPaystackSubaccountCode(
    businessId: string,
  ): Promise<string | null> {
    const { data: business, error } = await this.supabase
      .from("businesses")
      .select("paystack_subaccount_code")
      .eq("id", businessId)
      .single();

    if (error) throw error;
    return business?.paystack_subaccount_code || null;
  }

  private async assertPaymentConfiguredForPaidForm(
    businessId: string,
    formLevelSubaccountCode?: string | null,
  ): Promise<void> {
    const businessSubaccountCode =
      await this.getBusinessPaystackSubaccountCode(businessId);
    const effectiveSubaccountCode =
      formLevelSubaccountCode || businessSubaccountCode;

    if (!effectiveSubaccountCode) {
      throw Object.assign(
        new Error(
          "Payment is not configured for this business. Set up payout settings before creating or publishing paid forms.",
        ),
        { statusCode: 422 },
      );
    }
  }

  // ============================================================================
  // Organizer: Form CRUD
  // ============================================================================

  async createForm(
    userId: string,
    businessId: string,
    payload: {
      title: string;
      description?: string;
      access_type?: 'free' | 'paid';
      payment_amount?: number;
      payment_currency?: string;
      payment_label?: string;
      paystack_subaccount_code?: string;
      fields?: FormField[];
      settings?: Record<string, any>;
      is_published?: boolean;
    },
  ): Promise<HilaqForm> {
    const slug = generateSlug(payload.title);
    const accessType = payload.access_type || 'paid';
    const isPublished = payload.is_published !== false; // default true; drafts pass false

    // Skip payment config check for drafts — they may not have amounts set yet
    if (isPublished && accessType === 'paid') {
      await this.assertPaymentConfiguredForPaidForm(
        businessId,
        payload.paystack_subaccount_code,
      );
    }

    const defaultMessage = accessType === 'free'
      ? "Thank you! Your submission has been received."
      : "Thank you! Your payment has been confirmed and your submission received.";

    const { data, error } = await this.supabase
      .from("hilaq_forms")
      .insert({
        user_id: userId,
        business_id: businessId,
        title: payload.title,
        description: payload.description || null,
        slug,
        is_published: isPublished,
        access_type: accessType,
        payment_amount: accessType === 'free' ? 0 : (payload.payment_amount || 0),
        payment_currency: payload.payment_currency || "NGN",
        payment_label: payload.payment_label || "Registration Fee",
        paystack_subaccount_code: payload.paystack_subaccount_code || null,
        fields: payload.fields || [],
        settings: payload.settings || {
          confirmation_message: defaultMessage,
          redirect_url: null,
        },
      })
      .select("*")
      .single();

    if (error) throw error;
    return data as HilaqForm;
  }

  async updateForm(
    formId: string,
    businessId: string,
    updates: Partial<{
      title: string;
      description: string;
      payment_amount: number;
      payment_currency: string;
      payment_label: string;
      paystack_subaccount_code: string;
      fields: FormField[];
      settings: Record<string, any>;
    }>,
  ): Promise<HilaqForm> {
    const { data, error } = await this.supabase
      .from("hilaq_forms")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", formId)
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .select("*")
      .single();

    if (error) {
      if (error.code === "PGRST116")
        throw Object.assign(new Error("Form not found"), { statusCode: 404 });
      throw error;
    }
    return data as HilaqForm;
  }

  async deleteForm(formId: string, businessId: string): Promise<void> {
    const { error } = await this.supabase
      .from("hilaq_forms")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", formId)
      .eq("business_id", businessId);

    if (error) throw error;
  }

  async publishForm(
    formId: string,
    businessId: string,
    isPublished: boolean,
  ): Promise<void> {
    // Before publishing, validate the form has at least one field
    if (isPublished) {
      const { data: form } = await this.supabase
        .from("hilaq_forms")
        .select("fields, access_type, payment_amount")
        .eq("id", formId)
        .eq("business_id", businessId)
        .single();

      if (!form) {
        throw Object.assign(new Error("Form not found"), { statusCode: 404 });
      }
      if (!form.fields || form.fields.length === 0) {
        throw Object.assign(
          new Error(
            "Cannot publish a form with no fields. Add at least one field.",
          ),
          { statusCode: 400 },
        );
      }

      if (form.access_type === 'paid') {
        if (!form.payment_amount || Number(form.payment_amount) <= 0) {
          throw Object.assign(
            new Error(
              "Cannot publish a paid form without a payment amount greater than 0.",
            ),
            { statusCode: 400 },
          );
        }
        // Subaccounts live on businesses only — fetch from there
        const { data: biz } = await this.supabase
          .from("businesses")
          .select("paystack_subaccount_code")
          .eq("id", businessId)
          .single();
        await this.assertPaymentConfiguredForPaidForm(
          businessId,
          biz?.paystack_subaccount_code ?? null,
        );
      }
    }
  }

  async setPublished(
    formId: string,
    businessId: string,
    isPublished: boolean,
  ): Promise<HilaqForm> {
    const { data, error } = await this.supabase
      .from("hilaq_forms")
      .update({
        is_published: isPublished,
        updated_at: new Date().toISOString(),
      })
      .eq("id", formId)
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .select("*")
      .single();

    if (error) {
      if (error.code === "PGRST116")
        throw Object.assign(new Error("Form not found"), { statusCode: 404 });
      throw error;
    }
    return data as HilaqForm;
  }

  async getFormsByBusiness(
    businessId: string,
    opts: { page?: number; limit?: number } = {},
  ): Promise<{ forms: HilaqForm[]; total: number }> {
    const page = opts.page || 1;
    const limit = opts.limit || 20;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase
      .from("hilaq_forms")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return { forms: (data || []) as HilaqForm[], total: count || 0 };
  }

  async getFormById(formId: string, businessId: string): Promise<HilaqForm> {
    const { data, error } = await this.supabase
      .from("hilaq_forms")
      .select("*")
      .eq("id", formId)
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .single();

    if (error) {
      if (error.code === "PGRST116")
        throw Object.assign(new Error("Form not found"), { statusCode: 404 });
      throw error;
    }
    return data as HilaqForm;
  }

  // ============================================================================
  // Public: Form Access
  // ============================================================================

  async getPublicForm(slug: string): Promise<HilaqForm> {
    const { data, error } = await this.supabase
      .from("hilaq_forms")
      .select("*")
      .eq("slug", slug)
      .eq("is_published", true)
      .is("deleted_at", null)
      .single();

    if (error) {
      if (error.code === "PGRST116")
        throw Object.assign(new Error("Form not found or not published"), {
          statusCode: 404,
        });
      throw error;
    }
    return data as HilaqForm;
  }

  // ============================================================================
  // Public: Payment Initiation
  // All forms are paid — no submission record until webhook confirms.
  // ============================================================================

  async initiateFormPayment(
    slug: string,
    formData: Record<string, any>,
    submitterEmail: string,
    submitterName: string,
    callbackUrl?: string,
  ): Promise<{
    authorization_url: string;
    reference: string;
    total_to_pay: number;
    platform_fee: number;
  }> {
    const form = await this.getPublicForm(slug);

    if (!submitterEmail) {
      throw Object.assign(
        new Error("Email is required to proceed with payment"),
        { statusCode: 400 },
      );
    }

    // Subaccounts live on businesses only — always fetch from there
    const { data: business } = await this.supabase
      .from("businesses")
      .select("paystack_subaccount_code, paystack_fee_bearer, flw_subaccount_id")
      .eq("id", form.business_id)
      .single();

    const subaccountCode: string | null = business?.paystack_subaccount_code || null;
    const feeBearer: FeeBearer =
      (business?.paystack_fee_bearer as FeeBearer) || "subaccount";
    const flwSubaccountId: string | undefined = business?.flw_subaccount_id ?? undefined;

    const currency = ((form.payment_currency || "NGN") as SupportedCurrency);

    if (currency !== "NGN" && !flwSubaccountId) {
      throw Object.assign(
        new Error("This form has not set up multi-currency payments yet."),
        { statusCode: 422 },
      );
    }

    // Block payment if no subaccount is configured — we cannot take a split fee
    if (currency === "NGN" && !subaccountCode) {
      throw Object.assign(
        new Error(
          "Payment is not configured for this form. Please contact the organiser.",
        ),
        { statusCode: 422 },
      );
    }

    const baseAmount = Number(form.payment_amount);
    const provider = PaymentProviderFactory.getProvider(currency);
    const { totalToCharge, platformFee } = provider.calculateFees(baseAmount, currency);

    const result = await provider.initializePayment({
      amount: totalToCharge,
      email: submitterEmail ?? "",
      currency,
      callbackUrl:
        callbackUrl ||
        `${process.env.FRONTEND_URL || "https://hilaq.com"}/f/${slug}/success`,
      subaccountCode: subaccountCode ?? undefined,
      bearer: feeBearer,
      transactionCharge: Math.round(platformFee * 100),
      flwSubaccountId,
      flwMerchantAmount: baseAmount, // merchant receives base; Hilaq gets the gross-up
      metadata: {
        transaction_type: "form_submission",
        form_id: form.id,
        form_slug: slug,
        form_title: form.title,
        form_data: formData,
        full_name: submitterName,
        email: submitterEmail,
        platform_fee: platformFee,
        fee_bearer: feeBearer,
        currency,
        payment_provider: resolvePaymentProvider(currency),
      },
    });

    return {
      authorization_url: result.authorization_url,
      reference: result.reference,
      total_to_pay: totalToCharge,
      platform_fee: platformFee,
    };
  }

  // ============================================================================
  // Public: Free Form Direct Submission
  // ============================================================================

  async submitFreeForm(
    slug: string,
    formData: Record<string, any>,
    submitterEmail?: string,
    submitterName?: string,
  ): Promise<{ id: string; confirmation_message: string }> {
    const form = await this.getPublicForm(slug);

    if (form.access_type !== 'free') {
      throw Object.assign(
        new Error("This form requires payment. Use the payment endpoint."),
        { statusCode: 400 },
      );
    }

    const client = supabaseAdmin || this.supabase;

    const { data: submission, error } = await client
      .from("form_submissions")
      .insert({
        form_id: form.id,
        data: formData,
        status: "submitted",
        payment_reference: null,
        payment_amount: 0,
        payment_currency: form.payment_currency || "NGN",
        submitter_email: submitterEmail || null,
        submitter_name: submitterName || null,
        paid_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) throw error;

    const confirmationMessage =
      form.settings?.confirmation_message ||
      "Thank you! Your submission has been received.";

    return { id: submission.id, confirmation_message: confirmationMessage };
  }

  // ============================================================================
  // Webhook: Create Submission After Payment Confirmed
  // ============================================================================

  /**
   * Called ONLY from the webhook handler after charge.success is verified.
   * Creates the form submission record with status='paid'.
   */
  async createSubmission(
    formId: string,
    data: Record<string, any>,
    paymentReference: string,
    paymentAmount: number,
    submitterEmail?: string,
    submitterName?: string,
    currency?: string,
  ): Promise<{ id: string }> {
    // Use admin client to bypass RLS (webhook runs as service role)
    // Fall back to this.supabase if supabaseAdmin is unavailable
    const client = supabaseAdmin || this.supabase;

    const { data: submission, error } = await client
      .from("form_submissions")
      .insert({
        form_id: formId,
        data,
        status: "paid",
        payment_reference: paymentReference,
        payment_amount: paymentAmount / 100, // convert kobo → naira
        payment_currency: currency || "NGN",
        submitter_email: submitterEmail || null,
        submitter_name: submitterName || null,
        paid_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) throw error;
    return { id: submission.id };
  }

  // ============================================================================
  // Organizer: Submissions
  // ============================================================================

  async getSubmissions(
    formId: string,
    businessId: string,
    opts: { page?: number; limit?: number } = {},
  ): Promise<{ submissions: any[]; total: number }> {
    // Verify form belongs to business
    await this.getFormById(formId, businessId);

    const page = opts.page || 1;
    const limit = opts.limit || 50;
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase
      .from("form_submissions")
      .select("*", { count: "exact" })
      .eq("form_id", formId)
      .order("paid_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return { submissions: data || [], total: count || 0 };
  }

  // ============================================================================
  // Public: Submission Lookup (post-payment confirmation page)
  // ============================================================================

  async getSubmissionByReference(reference: string): Promise<{
    id: string;
    form_id: string;
    status: string;
    submitter_name?: string;
    paid_at?: string;
    form?: { title: string; settings: Record<string, any> };
  } | null> {
    const { data, error } = await this.supabase
      .from("form_submissions")
      .select(
        "id, form_id, status, submitter_name, paid_at, hilaq_forms(title, settings)",
      )
      .eq("payment_reference", reference)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      id: data.id,
      form_id: data.form_id,
      status: data.status,
      submitter_name: data.submitter_name,
      paid_at: data.paid_at,
      form: (data as any).hilaq_forms,
    };
  }
}

// Singleton export for webhook use
export const formService = new FormService(
  require("../config/supabase").supabase,
);
