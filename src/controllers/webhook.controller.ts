/**
 * Webhook Controller (Class-Based)
 *
 * Handles Paystack webhook events for:
 * - Event ticket purchases
 * - Store purchases
 * - Publication subscriptions
 * - Membership subscriptions
 * - Tipping
 *
 * Uses:
 * - EmailService for all email operations
 * - PurchaseService for ticket purchase logic
 * - StoreService for store order processing
 */

import crypto from "node:crypto";
import { Request, Response } from "express";
import { Receiver } from "@upstash/qstash";
import { SupabaseClient } from "@supabase/supabase-js";
import { supabase as publicSupabase } from "../config/supabase";
import supabaseAdmin from "../config/supabaseAdmin";
import {
  isQStashAvailable,
  queuePaystackWebhookJob,
  PaystackWebhookJobPayload,
} from "../config/qstash";
import {
  PaystackPaymentData,
  PaystackMetadata,
  type EventPaymentSummary,
} from "../types/webhook";
import { FlutterwaveProvider } from "../utils/payment/FlutterwaveProvider";
import {
  PaymentProviderFactory,
  type NormalisedPaymentData,
  type SupportedCurrency,
} from "../utils/payment";
import { classifyPaystackEvent } from "../utils/payment/webhook-routing";
import {
  deriveEventPaymentSummary,
  extractCouponRules,
  extractSubmittedCoupon,
} from "../utils/event-pricing-accounting";
import { resolvePaymentAmount } from "../utils/currency-rates.util";
import { EventTicket, Order, Recipient } from "../types/models";
import { emailService } from "../services/email.service";
import { createPurchaseService } from "../services/purchase.service";
import { generateQRCode } from "../utils/tickets";
import { FormService } from "../services/form.service";
import { BookingService } from "../services/booking.service";
import { buildGoogleCalendarUrl } from "../utils/sessionEmails";
import {
  formatEventDate,
  isEventDateTbd,
  EVENT_DATE_TBD_LABEL,
} from "../utils";
import { dunningService } from "../services/dunning.service";
import { webhookLogsService } from "../services/webhook-logs.service";
import { adminAlertsService } from "../services/admin-alerts.service";
import { CampaignCreditsService } from "../services/campaign-credits.service";
import { BankingService } from "../services/banking.service";
import {
  pendingCheckoutService,
  PendingCheckout,
} from "../services/pending-checkout.service";

const AUDIT_EMAIL = "abdulsalam@hilaq.com";

// =============================================================================
// Webhook Controller Class
// =============================================================================

class WebhookController {
  private supabase: SupabaseClient;
  private readonly qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
  });

  constructor() {
    // Prefer service-role client for webhook operations (bypass RLS)
    this.supabase = supabaseAdmin || publicSupabase;
  }

  // ---------------------------------------------------------------------------
  // Main Webhook Handler
  // ---------------------------------------------------------------------------

  async handlePaystackWebhook(req: Request, res: Response): Promise<Response> {
    try {
      // Verify signature
      const signature = req.headers["x-paystack-signature"] as
        | string
        | undefined;
      if (!signature) {
        return res.status(401).json({ error: "Missing signature" });
      }

      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      const signedPayload = rawBody ?? Buffer.from(JSON.stringify(req.body));
      const hash = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY as string)
        .update(signedPayload)
        .digest("hex");

      if (hash !== signature) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const event = req.body;
      const webhookStart = Date.now();

      // Log all incoming webhooks (fire-and-forget)
      webhookLogsService
        .log({
          source: "paystack",
          eventType: event.event,
          reference: event.data?.reference,
          businessId: event.data?.metadata?.business_id,
          status: "received",
          payload: { event: event.event, reference: event.data?.reference },
        })
        .catch((err: unknown) =>
          console.error("Failed to log webhook (1)", err),
        );

      const isBusinessSubscription =
        classifyPaystackEvent(event) === "business_subscription";

      if (isBusinessSubscription) {
        // Route to business subscription handler
        const result = await this.handleBusinessSubscriptionEvent(
          event.event,
          event.data,
        );

        // Log result
        webhookLogsService
          .log({
            source: "paystack",
            eventType: event.event,
            reference: event.data?.reference,
            businessId: event.data?.metadata?.business_id,
            status: result.success ? "processed" : "failed",
            payload: { event: event.event },
            errorMessage: result.success ? undefined : result.message,
            processingTimeMs: Date.now() - webhookStart,
          })
          .catch((err: unknown) =>
            console.error("Failed to log webhook (2)", err),
          );

        // Alert on Pro plan signups
        if (
          event.event === "charge.success" &&
          event.data?.metadata?.plan === "pro"
        ) {
          adminAlertsService
            .alertNewProSignup(
              undefined,
              event.data?.metadata?.business_name ||
                event.data?.metadata?.business_id,
              "pro",
              event.data?.metadata?.business_id,
            )
            .catch((err: unknown) =>
              console.error("Failed to log webhook (3)", err),
            );
        }

        // Alert on large transactions
        const amount = (event.data?.amount || 0) / 100; // kobo to naira
        if (event.event === "charge.success" && amount > 0) {
          adminAlertsService
            .checkLargeTransaction(
              undefined,
              amount,
              event.data?.metadata?.business_name || "Unknown business",
              "subscription",
              event.data?.reference,
            )
            .catch((err: unknown) =>
              console.error("Failed to log webhook (4)", err),
            );
        }

        console.log(`[BusinessSubscription] ${event.event}: ${result.message}`);
        return res.status(200).json({ received: true, ...result });
      }

      const qstashMessageId = isQStashAvailable()
        ? await queuePaystackWebhookJob({
            event: event.event,
            data: event.data,
            receivedAt: new Date().toISOString(),
          })
        : null;

      if (qstashMessageId) {
        webhookLogsService
          .log({
            source: "paystack",
            eventType: event.event,
            reference: event.data?.reference,
            businessId: event.data?.metadata?.business_id,
            status: "received",
            payload: { messageId: qstashMessageId },
            processingTimeMs: Date.now() - webhookStart,
          })
          .catch((err: unknown) =>
            console.error("Failed to log webhook queue state", err),
          );

        return res.status(200).json({ received: true });
      }

      // Local/dev fallback and outage safety: if QStash is unavailable or the
      // publish call fails, keep the old quick-ACK behavior and process inline.
      res.status(200).json({ received: true });

      this.processPaystackEvent(event).catch((err) =>
        console.error(
          `[Webhook] Async processing failed for ${event.event}:`,
          err,
        ),
      );

      return res;
    } catch (error: any) {
      console.error("Webhook error:", error);
      return res.status(500).json({
        error: "Webhook handler failed",
      });
    }
  }

  /**
   * QStash worker for Paystack events. The public /paystack endpoint verifies
   * Paystack's signature before enqueueing; this endpoint verifies QStash's
   * signature before running retryable side effects.
   */
  async processPaystackWebhookJob(
    req: Request,
    res: Response,
  ): Promise<Response> {
    if (process.env.NODE_ENV === "production") {
      const signature = req.headers["upstash-signature"] as string | undefined;

      if (!signature) {
        console.error("[PaystackWebhookJob] Missing QStash signature");
        return res.status(401).json({ error: "Unauthorized" });
      }

      try {
        const isValid = await this.qstashReceiver.verify({
          signature,
          body: JSON.stringify(req.body),
        });

        if (!isValid) {
          console.error("[PaystackWebhookJob] Invalid QStash signature");
          return res.status(401).json({ error: "Unauthorized" });
        }
      } catch (err) {
        console.error(
          "[PaystackWebhookJob] Signature verification error:",
          err,
        );
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const payload = req.body as PaystackWebhookJobPayload;
    if (!payload?.event) {
      return res.status(400).json({ error: "event is required" });
    }

    const start = Date.now();
    try {
      await this.processPaystackEvent({
        event: payload.event,
        data: payload.data,
      });

      webhookLogsService
        .log({
          source: "paystack",
          eventType: payload.event,
          reference: (payload.data as any)?.reference,
          businessId: (payload.data as any)?.metadata?.business_id,
          status: "processed",
          payload: {},
          processingTimeMs: Date.now() - start,
        })
        .catch((err: unknown) =>
          console.error("Failed to log webhook worker success", err),
        );

      return res.status(200).json({ processed: true });
    } catch (error: any) {
      webhookLogsService
        .log({
          source: "paystack",
          eventType: payload.event,
          reference: (payload.data as any)?.reference,
          businessId: (payload.data as any)?.metadata?.business_id,
          status: "failed",
          payload: {},
          errorMessage: error?.message ?? String(error),
          processingTimeMs: Date.now() - start,
        })
        .catch((err: unknown) =>
          console.error("Failed to log webhook worker failure", err),
        );

      console.error(`[PaystackWebhookJob] Failed for ${payload.event}:`, error);
      return res.status(500).json({ error: "Webhook job failed" });
    }
  }

  private async processPaystackEvent(event: {
    event: string;
    data: any;
  }): Promise<void> {
    switch (event.event) {
      case "charge.success":
        // Wallet deposits into a business's dedicated account carry no order
        // metadata; bank-transfer checkouts (transaction-scoped VAs) carry the
        // same dedicated_nuban channel but the full checkout metadata, so they
        // must continue through normal order fulfillment.
        if (this.isDedicatedNubanDeposit(event.data)) {
          await this.bankingService().recordDedicatedNubanDeposit(event.data);
          break;
        }
        await this.handleChargeSuccess(event.data);
        break;

      case "customeridentification.success":
        await this.bankingService().handleCustomerIdentificationEvent(
          event.data,
          true,
        );
        break;

      case "customeridentification.failed":
        await this.bankingService().handleCustomerIdentificationEvent(
          event.data,
          false,
        );
        break;

      case "dedicatedaccount.assign.success":
        await this.bankingService().handleDedicatedAccountAssignmentEvent(
          event.data,
          true,
        );
        break;

      case "dedicatedaccount.assign.failed":
        await this.bankingService().handleDedicatedAccountAssignmentEvent(
          event.data,
          false,
        );
        break;

      case "transfer.success":
        await this.bankingService().handleTransferEvent(event.data, "success");
        break;

      case "transfer.failed":
        await this.bankingService().handleTransferEvent(event.data, "failed");
        break;

      case "transfer.reversed":
        await this.bankingService().handleTransferEvent(event.data, "reversed");
        break;

      case "subscription.disable":
        await this.handleSubscriptionDisable(event.data);
        break;

      case "invoice.payment_failed":
        await this.handleInvoicePaymentFailed(event.data);
        break;

      case "subscription.expiring_cards":
        await this.handleExpiringCards(event.data);
        break;

      case "subscription.create":
        await this.handlePublicationSubscriptionCreated(event.data);
        break;

      case "direct_debit.authorization.created":
        if (event.data?.metadata?.business_id) {
          await this.handleBusinessSubscriptionEvent(event.event, event.data);
        }
        break;

      case "settlement.success":
        await this.handleSettlementResolved(event.data, "fulfilled");
        break;

      case "settlement.failed":
        await this.handleSettlementResolved(event.data, "failed");
        break;

      default:
        console.log(`Unhandled event type: ${event.event}`);
    }
  }

  /**
   * Resolve a business's outstanding payout requests when Paystack reports a
   * settlement on its subaccount. Settlements are aggregate (not per-request),
   * so a successful subaccount settlement fulfils that business's pending
   * request(s); a failed one marks them failed.
   */
  private async handleSettlementResolved(
    data: any,
    status: "fulfilled" | "failed",
  ): Promise<void> {
    const subaccountCode: string | undefined =
      data?.subaccount?.subaccount_code;
    if (!subaccountCode) return; // main-account settlement, not a merchant payout

    const { data: business } = await this.supabase
      .from("businesses")
      .select("id")
      .eq("paystack_subaccount_code", subaccountCode)
      .single();
    if (!business) return;

    const update: Record<string, unknown> = {
      status,
      resolved_at: new Date().toISOString(),
      paystack_settlement_id: data?.id ? String(data.id) : null,
    };
    if (status === "failed")
      update.failure_reason = "Paystack settlement failed";

    const { error } = await this.supabase
      .from("payout_requests")
      .update(update)
      .eq("business_id", business.id)
      .eq("status", "pending");
    if (error) {
      console.error("[Settlement] Failed to resolve payout requests:", error);
    }
  }

  private bankingService(): BankingService {
    return new BankingService(this.supabase);
  }

  // ---------------------------------------------------------------------------
  // Flutterwave Webhook Handler
  // ---------------------------------------------------------------------------

  async handleFlutterwaveWebhook(
    req: Request,
    res: Response,
  ): Promise<Response> {
    try {
      // Standard FLW webhook verification: compare "verif-hash" header to FLW_WEBHOOK_HASH
      const signature = req.headers["verif-hash"] as string | undefined;
      if (!signature) {
        return res.status(401).json({ error: "Missing Flutterwave signature" });
      }

      const provider = new FlutterwaveProvider();

      if (!provider.verifyWebhookSignature("", signature)) {
        return res.status(401).json({ error: "Invalid Flutterwave signature" });
      }

      // Acknowledge immediately — FLW expects a 200 quickly
      res.status(200).json({ status: "received" });

      const normalised = provider.normaliseWebhookEvent(req.body);
      if (!normalised) return res; // not a charge.completed or not successful

      webhookLogsService
        .log({
          source: "flutterwave",
          eventType: (req.body as any)?.event ?? "charge.completed",
          reference: normalised.reference,
          businessId: normalised.metadata?.store_id,
          status: "received",
          payload: { reference: normalised.reference },
        })
        .catch((err: unknown) =>
          console.error("Failed to log webhook (5)", err),
        );

      await this.handleChargeSuccess(normalised);

      // Fee true-up: pair our initiation estimate with FLW's real deduction
      // so drift per currency can be measured and rates recalibrated.
      const feeEstimate = Number(
        normalised.metadata?.gateway_fee_estimate ??
          normalised.metadata?.paystack_fee_estimate,
      );
      const feeActual =
        typeof normalised.gatewayFee === "number"
          ? normalised.gatewayFee / 100
          : undefined;

      webhookLogsService
        .log({
          source: "flutterwave",
          eventType: (req.body as any)?.event ?? "charge.completed",
          reference: normalised.reference,
          businessId: normalised.metadata?.store_id,
          status: "processed",
          payload: {
            reference: normalised.reference,
            currency: normalised.currency,
            fee_estimate:
              Number.isFinite(feeEstimate) && feeEstimate > 0
                ? feeEstimate
                : undefined,
            fee_actual: feeActual,
            fee_delta:
              feeActual !== undefined && Number.isFinite(feeEstimate)
                ? Number((feeActual - feeEstimate).toFixed(4))
                : undefined,
          },
        })
        .catch((err: unknown) =>
          console.error("Failed to log webhook (6)", err),
        );

      return res;
    } catch (error: any) {
      console.error("[FLW Webhook] Error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // ---------------------------------------------------------------------------
  // Free Tickets Handler
  // ---------------------------------------------------------------------------

  async handleFreeTickets(req: Request, res: Response): Promise<Response> {
    try {
      const { metadata, reference, amount } = req.body as PaystackPaymentData;

      // Verify every selected ticket is genuinely free — prevents forged metadata
      // from minting tickets for paid events at zero cost.
      if (
        metadata?.event_id &&
        metadata?.selectedTickets &&
        metadata?.tickets
      ) {
        const tickets =
          typeof metadata.tickets === "string"
            ? JSON.parse(metadata.tickets)
            : metadata.tickets;
        const ticketIds = Object.keys(
          typeof metadata.selectedTickets === "string"
            ? JSON.parse(metadata.selectedTickets as string)
            : (metadata.selectedTickets as Record<string, number>),
        );
        const { data: dbTickets } = await this.supabase
          .from("event_tickets")
          .select("id, ticket_price")
          .in("id", ticketIds);
        const nonFree = (dbTickets || []).filter(
          (t: any) => Number(t.ticket_price) > 0,
        );
        if (nonFree.length > 0) {
          return res.status(400).json({
            error: "Cannot process free checkout for paid tickets",
            ticketIds: nonFree.map((t: any) => t.id),
          });
        }
      }

      const mockPaymentData: NormalisedPaymentData = {
        metadata,
        reference,
        amount,
        status: "success",
        currency: "NGN",
        provider: "paystack",
      };

      this.validatePaymentData(mockPaymentData, "FREE");
      await this.handleChargeSuccess(mockPaymentData, "FREE");

      return res.status(200).json({
        success: true,
        message: "Free tickets processed successfully",
      });
    } catch (error: any) {
      console.error("Error processing free tickets:", error);
      return res.status(500).json({
        error: "Failed to process free tickets",
        details: error.message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // charge.success Handler
  // ---------------------------------------------------------------------------

  private async handleChargeSuccess(
    paymentData: NormalisedPaymentData,
    mode: "PAID" | "FREE" = "PAID",
  ): Promise<void> {
    // Resolve any active dunning for business subscriptions
    if ((paymentData as any)?.metadata?.business_id) {
      dunningService
        .recordPaymentSuccess(
          this.supabase,
          (paymentData as any).metadata.business_id,
        )
        .catch((err) =>
          console.error("[Dunning] charge.success resolve error:", err),
        );
    }

    // Renewal webhook path may not include original payment metadata.
    const renewalSubCode =
      (paymentData as any)?.subscription_code ||
      (paymentData as any)?.subscription?.subscription_code;
    if (renewalSubCode && paymentData?.reference) {
      // Check if this is a publication subscription renewal
      const {
        publicationSubscriptionService,
      } = require("../services/publication-subscription.service");
      const pubHandled =
        await publicationSubscriptionService.activateRenewalFromSubscriptionCode(
          renewalSubCode,
          paymentData.reference,
          paymentData.amount,
        );
      if (pubHandled) return;
    }

    const restored = await this.restorePendingCheckoutMetadata(
      paymentData,
      mode,
    );
    if (restored && "blocked" in restored) return;

    const verified = this.validatePaymentData(
      restored?.paymentData ?? paymentData,
      mode,
    );

    await this.routeChargeSuccess(verified);

    if (restored) {
      await this.markPendingFulfilledIfOrderExists(verified.reference);
    }
  }

  /**
   * Merge a paid provider event with the checkout persisted at initiate time.
   * The pending row is provider-independent and is the authoritative source of
   * the original checkout context, even when a provider returns partial or
   * string-flattened metadata.
   *
   * Returns the enriched payment data, or null when no pending checkout exists.
   * When the charged amount differs from the persisted amount the payment is
   * NOT fulfilled — it is enqueued for admin recovery instead (blocked).
   */
  private async restorePendingCheckoutMetadata(
    paymentData: NormalisedPaymentData,
    mode: "PAID" | "FREE",
  ): Promise<
    { paymentData: NormalisedPaymentData } | { blocked: true } | null
  > {
    if (mode !== "PAID") return null;

    const pending = await pendingCheckoutService.findByReference(
      this.supabase,
      paymentData.reference,
    );
    if (!pending) return null;

    if (pending.amount_kobo !== paymentData.amount) {
      console.error(
        `[Webhook] Amount mismatch for ${paymentData.reference}: ` +
          `charged ${paymentData.amount} vs persisted ${pending.amount_kobo} — ` +
          "enqueued for admin recovery, not fulfilled.",
      );
      await this.enqueueAmountMismatch(paymentData, pending);
      return { blocked: true };
    }

    return {
      paymentData: {
        ...paymentData,
        metadata: { ...paymentData.metadata, ...pending.metadata },
      },
    };
  }

  private async enqueueAmountMismatch(
    paymentData: NormalisedPaymentData,
    pending: PendingCheckout,
  ): Promise<void> {
    const { error } = await this.supabase.from("payment_recovery_queue").upsert(
      {
        payment_reference: paymentData.reference,
        paystack_amount: paymentData.amount,
        paystack_email: paymentData.customer?.email ?? pending.customer_email,
        paystack_metadata: {
          ...pending.metadata,
          _recovery_note: "amount_mismatch",
        },
      },
      { onConflict: "payment_reference", ignoreDuplicates: true },
    );
    if (error) {
      console.error(
        `[Webhook] Failed to enqueue amount mismatch for ${paymentData.reference}:`,
        error.message,
      );
    }
  }

  private async markPendingFulfilledIfOrderExists(
    reference: string,
  ): Promise<void> {
    const [{ data: order }, { data: storeOrder }] = await Promise.all([
      this.supabase
        .from("orders")
        .select("id")
        .eq("payment_reference", reference)
        .maybeSingle(),
      this.supabase
        .from("store_orders")
        .select("id")
        .eq("payment_reference", reference)
        .maybeSingle(),
    ]);

    if (order || storeOrder) {
      await pendingCheckoutService.markFulfilled(this.supabase, reference);
    }
  }

  private async routeChargeSuccess(
    verified: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, amount, reference } = verified;
    const buyerEmail = metadata.email;

    // 1. Event Purchase
    if (this.isEventPurchase(metadata)) {
      await this.processEventPurchase(verified);
      if (buyerEmail)
        this.tryRecordPartnerCommission(
          buyerEmail,
          "event_ticket",
          reference,
          amount,
        );
      return;
    }

    // 2. Form Submission Payment
    if (this.isFormSubmission(metadata)) {
      await this.processFormSubmission(verified);
      console.log(
        `Successfully processed form submission payment: ${reference}`,
      );
      return;
    }

    // 2b. Standalone Booking Payment (store service)
    if (this.isBookingPayment(metadata)) {
      await this.processBookingPayment(verified);
      console.log(`Successfully processed booking payment: ${reference}`);
      return;
    }

    // 2c. Scheduling Payment (calendar event type)
    if (this.isSchedulingPayment(metadata)) {
      await this.processSchedulingPayment(verified);
      console.log(`Successfully processed scheduling payment: ${reference}`);
      return;
    }

    // 3. Store Purchase (by metadata)
    if (this.isStorePurchase(metadata)) {
      await this.processStorePurchase(verified);
      console.log(`Successfully processed store payment: ${reference}`);
      if (buyerEmail)
        this.tryRecordPartnerCommission(
          buyerEmail,
          "store_order",
          reference,
          amount,
        );
      return;
    }

    // 3. Store Purchase fallback (incomplete metadata but has store_id)
    if (metadata.store_id && !metadata.items) {
      await this.handleIncompleteStorePurchase(verified);
      return;
    }

    // 4. Publication Subscription
    if (this.isPublicationSubscription(metadata)) {
      await this.processPublicationSubscription(verified);
      console.log(
        `Successfully processed publication subscription: ${reference}`,
      );
      if (buyerEmail)
        this.tryRecordPartnerCommission(
          buyerEmail,
          "subscription",
          reference,
          amount,
        );
      return;
    }

    // 5. Store Membership Subscription
    if (this.isStoreMembershipSubscription(metadata)) {
      await this.processStoreMembershipSubscription(verified);
      console.log(
        `Successfully processed store membership subscription: ${reference}`,
      );
      if (buyerEmail)
        this.tryRecordPartnerCommission(
          buyerEmail,
          "subscription",
          reference,
          amount,
        );
      return;
    }

    // 6. Course purchase
    if (this.isCoursePurchase(metadata)) {
      await this.processCoursePurchase(verified);
      console.log(`Successfully processed course purchase: ${reference}`);
      return;
    }

    // 9. Campaign credit top-up
    if (this.isCampaignCreditTopUp(metadata)) {
      await this.processCampaignCreditTopUp(verified);
      console.log(`Successfully processed campaign credit top-up: ${reference}`);
      return;
    }

    // 7. Membership or Tipping
    await this.processNonEventPayment(verified);
    console.log(`Successfully processed payment: ${verified.reference}`);
  }

  /**
   * Record partner commission for any completed payment.
   * Non-blocking: silently skips if buyer is not a referred user.
   */
  private async tryRecordPartnerCommission(
    buyerEmail: string,
    transactionType: string,
    transactionId: string | undefined,
    amount: number,
  ): Promise<void> {
    try {
      // Lookup buyer user_id from email
      const { data: profile } = await this.supabase
        .from("profiles")
        .select("user_id")
        .eq("email", buyerEmail)
        .maybeSingle();

      if (!profile?.user_id) return;

      const { PartnerService } = await import("../services/partner.service");
      const partnerService = new PartnerService(this.supabase);
      await partnerService.recordCommission(
        profile.user_id,
        transactionType,
        transactionId,
        amount / 100, // Paystack amounts are in kobo
      );
    } catch (err) {
      console.error(
        "[WebhookController] Partner commission recording failed:",
        err,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Payment Type Detection
  // ---------------------------------------------------------------------------

  private isFormSubmission(metadata: PaystackMetadata): boolean {
    return (
      metadata.transaction_type === "form_submission" &&
      Boolean(metadata.form_id)
    );
  }

  private isBookingPayment(metadata: PaystackMetadata): boolean {
    return (
      metadata.transaction_type === "booking_payment" &&
      Boolean(metadata.booking_id)
    );
  }

  private isEventPurchase(metadata: PaystackMetadata): boolean {
    return Boolean(
      metadata.event_id && metadata.selectedTickets && metadata.tickets,
    );
  }

  private isStorePurchase(metadata: PaystackMetadata): boolean {
    // Primary: check transaction_type (new approach)
    // Fallback: check presence of store_id and items (backward compatibility)
    return (
      metadata.transaction_type === "store_purchase" ||
      Boolean(metadata.store_id && metadata.items)
    );
  }

  private isPublicationSubscription(metadata: PaystackMetadata): boolean {
    return (
      metadata.subscription_type === "publication" &&
      Boolean(metadata.publication_id)
    );
  }

  private isStoreMembershipSubscription(metadata: PaystackMetadata): boolean {
    return (
      metadata.subscription_type === "store_membership" &&
      Boolean(metadata.product_id)
    );
  }

  private isCoursePurchase(metadata: PaystackMetadata): boolean {
    return (
      (metadata as any).transaction_type === "course_purchase" &&
      !!(metadata as any).course_id
    );
  }

  private isCampaignCreditTopUp(metadata: PaystackMetadata): boolean {
    return (
      metadata.transaction_type === "campaign_credit_topup" &&
      !!metadata.business_id &&
      Number(metadata.credits) > 0
    );
  }

  /**
   * True when a charge landed in a business's dedicated virtual account rather
   * than a checkout VA. Both channels report dedicated_nuban, so the absence
   * of order metadata is the only discriminator.
   */
  private isDedicatedNubanDeposit(data: {
    metadata?: PaystackMetadata;
    authorization?: NormalisedPaymentData["authorization"];
  }): boolean {
    return (
      this.bankingService().isDedicatedNubanCharge(data) &&
      !this.hasOrderMetadata(data.metadata)
    );
  }

  private hasOrderMetadata(metadata: PaystackMetadata | undefined): boolean {
    if (!metadata || typeof metadata !== "object") return false;
    return (
      this.isEventPurchase(metadata) ||
      this.isStorePurchase(metadata) ||
      this.isBookingPayment(metadata) ||
      this.isSchedulingPayment(metadata) ||
      this.isFormSubmission(metadata) ||
      this.isPublicationSubscription(metadata) ||
      this.isStoreMembershipSubscription(metadata) ||
      this.isCoursePurchase(metadata) ||
      this.isCampaignCreditTopUp(metadata)
    );
  }

  private async processCampaignCreditTopUp(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const metadata = paymentData.metadata as PaystackMetadata;
    const service = new CampaignCreditsService(this.supabase);

    await service.creditTopUpFromPayment({
      businessId: metadata.business_id!,
      userId: metadata.user_id || null,
      credits: Number(metadata.credits),
      paystackReference: paymentData.reference,
      amountPaid: paymentData.amount,
      metadata: {
        package_id: metadata.package_id,
        customer_email: metadata.email,
        provider: paymentData.provider || "paystack",
        currency: paymentData.currency || "NGN",
      },
    });
  }

  private async processCoursePurchase(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const metadata = paymentData.metadata as any;
    const courseId: string | undefined = metadata.course_id;
    const userId: string | undefined = metadata.user_id;

    if (!courseId || !userId) {
      console.error(
        "[CoursePurchase] Missing course_id or user_id in metadata",
        metadata,
      );
      return;
    }

    // Upsert enrollment record
    const { error } = await this.supabase
      .from("course_enrollments")
      .upsert(
        {
          course_id: courseId,
          user_id: userId,
          enrolled_at: new Date().toISOString(),
        },
        { onConflict: "course_id,user_id" },
      );

    if (error) {
      console.error("[CoursePurchase] Failed to enroll user:", error.message);
      throw new Error(`Course enrollment failed: ${error.message}`);
    }

    console.log(
      `[CoursePurchase] Enrolled user ${userId} in course ${courseId}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Event Purchase Processing
  // ---------------------------------------------------------------------------

  private async processEventPurchase(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, amount, reference } = paymentData;
    const purchaseService = createPurchaseService(this.supabase);

    // FLW flattens meta to primitives, so nested fields arrive as JSON strings.
    const parseField = <T>(v: unknown, fallback: T): T => {
      if (v === null || v === undefined) return fallback;
      if (typeof v === "string") {
        try {
          return JSON.parse(v) as T;
        } catch {
          return fallback;
        }
      }
      return v as T;
    };

    const selectedTickets = parseField<Record<string, number>>(
      metadata.selectedTickets,
      {},
    );
    const tickets = parseField<EventTicket[]>(metadata.tickets, []);
    const recipients = parseField<Recipient[]>(metadata.recipients, []);
    const customAnswers = parseField<Record<string, string>>(
      metadata.custom_answers,
      {},
    );

    const customerInfo = {
      full_name: metadata.full_name ?? "",
      email: metadata.email ?? "",
      phone_number: metadata.phone_number,
      gender: metadata.gender ?? customAnswers?.gender,
    };
    const eventPaymentSummary =
      await this.resolveEventPaymentSummaryWithFallback(
        metadata,
        paymentData.reference,
        amount / 100,
        paymentData.currency,
      );

    const customerData = await purchaseService.saveCustomer(customerInfo);
    const orderData = eventPaymentSummary
      ? await purchaseService.createOrder(
          customerData.id,
          metadata.event_id!,
          amount,
          reference,
          {
            currency: eventPaymentSummary.currency,
            subtotal: eventPaymentSummary.subtotal,
            discount: eventPaymentSummary.discount,
            surcharge: eventPaymentSummary.surcharge,
            discountCode: eventPaymentSummary.coupon_code,
            discounts: eventPaymentSummary.discounts,
          },
        )
      : await purchaseService.createOrder(
          customerData.id,
          metadata.event_id!,
          amount,
          reference,
        );
    // null = INSERT was a no-op because the reference already existed (concurrent
    // webhook retry or admin replay). Stop here — tickets and emails were already
    // handled by whichever call won the insert race.
    if (!orderData) {
      console.log(
        `[processEventPurchase] Reference ${reference} already processed (concurrent call), skipping.`,
      );
      return;
    }

    const ticketSalesResp = await purchaseService.processTicketSales(
      orderData.id,
      selectedTickets,
      tickets,
    );

    await purchaseService.updateTicketQuantities(selectedTickets);

    const eventData = await purchaseService.getEventDetails(metadata.event_id!);

    // Authoritative per-seat pricing computed at checkout (present only when the
    // event has pricing rules); used to stamp each ticket's tier + adjustment.
    const { data: snapshot } = await this.supabase
      .from("event_pricing_snapshots")
      .select("breakdown")
      .eq("reference", reference)
      .maybeSingle();
    const pricingBreakdown = Array.isArray(snapshot?.breakdown)
      ? snapshot!.breakdown
      : [];
    // Generate tickets (with recipient support)
    const issuedTickets = await this.generateAndStoreTickets(
      ticketSalesResp,
      eventData,
      orderData,
      customerInfo,
      metadata.event_id!,
      recipients,
      customAnswers,
      pricingBreakdown,
    );

    // Send customer receipt — skip if the recipients flow already emailed the
    // purchaser. This happens when a buyer adds themselves as a recipient, which
    // causes generateAndStoreTickets to email them and processEventPurchase to
    // email them again, producing a duplicate.
    const purchaserEmailedAsRecipient = recipients.some(
      (r: Recipient) => (r.email ?? customerInfo.email) === customerInfo.email,
    );
    if (issuedTickets.length > 0 && !purchaserEmailedAsRecipient) {
      const receiptVenue = eventData.is_physical
        ? (eventData.venue?.placeDesc ??
          eventData.venue?.full_address ??
          "Venue TBA")
        : "Online Event";

      // Fetch the first registration number for this order
      const { data: firstTicketRow } = await this.supabase
        .from("issued_tickets")
        .select("registration_number")
        .eq("order_id", issuedTickets[0].orderId)
        .order("registration_number", { ascending: true })
        .limit(1)
        .single();

      const eventCalendarLinks = this.buildEventCalendarLinks(
        eventData,
        metadata.event_id as string,
      );
      await emailService.sendTicketReceiptEmail({
        userEmail: metadata.email ?? "",
        ticketId: issuedTickets[0].orderId,
        eventName: eventData.event_name,
        eventDate: formatEventDate(eventData.start_date, eventData.start_time),
        venue: receiptVenue,
        registrationNumber: firstTicketRow?.registration_number ?? null,
        confirmationEmail: (eventData as any).confirmation_email ?? null,
        googleCalendarUrl: eventCalendarLinks.googleCalendarUrl,
        icsUrl: eventCalendarLinks.icsUrl,
        dateTbd: isEventDateTbd(eventData.start_date),
        paymentSummary: eventPaymentSummary,
      });
      this.supabase
        .from("orders")
        .update({ confirmation_email_sent_at: new Date().toISOString() })
        .eq("id", orderData.id)
        .then(({ error }) => {
          if (error)
            console.error("[Webhook] Failed to stamp email timestamp:", error);
        });
    }

    // Send vendor notification
    const { data: vendor } = await this.supabase
      .from("users")
      .select("name, email")
      .eq("id", eventData.owner_id)
      .single();

    if (vendor) {
      await emailService.sendVendorSaleEmail({
        vendorEmail: vendor.email,
        vendorName: vendor.name,
        eventId: metadata.event_id!,
        eventName: eventData.event_name,
        buyerName: metadata.full_name ?? "",
        amount: amount / 100,
        currency: paymentData.currency,
        quantity: issuedTickets.length,
        dateTime: `${issuedTickets[0]?.orderDate} - ${issuedTickets[0]?.time}`,
        paymentSummary: eventPaymentSummary,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Store Purchase Processing
  // ---------------------------------------------------------------------------

  private async processStorePurchase(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, reference, amount } = paymentData;
    const { storeService } = require("../services/store.service");

    // Use new field names with fallback to legacy names
    const resolvedCustomerName = metadata.full_name || metadata.customer_name;
    const resolvedCustomerEmail = metadata.email || metadata.customer_email;
    const resolvedCustomerPhone =
      metadata.phone_number || metadata.customer_phone;

    // Build order items with product details
    const productIds = metadata.items!.map((i: any) => i.product_id);
    const { data: products } = await this.supabase
      .from("products")
      .select("id, name, price, type, cover_image")
      .in("id", productIds);

    const orderItems = metadata.items!.map((item: any) => {
      const product = products?.find((p: any) => p.id === item.product_id);

      if (!product) {
        console.warn(
          `[Store Webhook] Product not found in DB: ${item.product_id}`,
        );
      }

      // Bundles default to physical fulfilment.
      let productType = product?.type || item.product_type || "physical";
      if (productType === "bundle") {
        // Bundles are treated as physical for fulfillment purposes
        productType = "physical";
      }

      return {
        product_id: item.product_id,
        product_name: product?.name || item.product_name || "Unknown",
        product_type: productType,
        quantity: item.quantity,
        // Prefer the checkout-computed price (includes variant adjustments
        // and modifier/add-on deltas) — only fall back to the bare product
        // price if checkout didn't resolve one for some reason.
        price: item.price ?? product?.price,
        cover_image: product?.cover_image || null,
        slot: item.slot || null,
        variant_id: item.variant_id || null,
        variant_name: item.variant_name || null,
        variant_options: item.variant_options || [],
        selected_modifiers: item.selected_modifiers || [],
        note: item.note || null,
      };
    });

    await storeService.createOrder({
      store_id: metadata.store_id,
      payment_reference: reference,
      payment_provider: paymentData.provider ?? "paystack",
      customer: {
        name: resolvedCustomerName,
        email: resolvedCustomerEmail,
        phone: resolvedCustomerPhone,
        address: metadata.customer_address,
      },
      items: orderItems,
      booking_id: metadata.booking_id as string | undefined,
      discount_code: metadata.discount_code,
      // Payments initiated before the takeout→pickup rename deploy can
      // still carry the old value in their Paystack metadata.
      fulfillment_type:
        (metadata.fulfillment_type as string) === "takeout"
          ? "pickup"
          : metadata.fulfillment_type,
      branch_id: metadata.branch_id,
      utensils_requested: metadata.utensils_requested,
      notes: metadata.notes,
      qr_code_id: metadata.qr_code_id,
      location_label: metadata.location_label,
    });
  }

  private async handleIncompleteStorePurchase(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, reference, amount } = paymentData;

    console.warn(
      `[Store Webhook] Reference prefix detected but metadata incomplete: ${reference}`,
    );

    const referrer = metadata.referrer || "";
    const storeSlugMatch = referrer.match(/\/s\/([^\/]+)/);

    if (storeSlugMatch) {
      const storeSlug = storeSlugMatch[1];
      const { data: store } = await this.supabase
        .from("stores")
        .select("id")
        .eq("slug", storeSlug)
        .single();

      if (store) {
        const customerEmail = metadata.email || paymentData.customer?.email;
        const fullNameFromParts =
          `${paymentData.customer?.first_name || ""} ${paymentData.customer?.last_name || ""}`.trim();
        const customerName =
          metadata.full_name ||
          fullNameFromParts ||
          paymentData.customer?.name ||
          "Customer";

        await emailService.sendAuditEvent({
          toEmail: AUDIT_EMAIL,
          eventName: "store-purchase.incomplete-metadata",
          payload: {
            reference,
            store_id: store.id,
            store_slug: storeSlug,
            customer_email: customerEmail,
            customer_name: customerName,
            amount: amount / 100,
            metadata_keys: Object.keys(metadata),
            message: "Manual order creation may be required.",
          },
        });
        return;
      }
    }

    console.error(
      `[Store Webhook] Could not identify store from referrer: ${referrer}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Publication Subscription Processing
  // ---------------------------------------------------------------------------

  private async processPublicationSubscription(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, reference } = paymentData;
    const {
      publicationSubscriptionService,
    } = require("../services/publication-subscription.service");

    await publicationSubscriptionService.activatePaidSubscription(
      metadata.publication_id!,
      metadata.user_id!,
      metadata.plan as "monthly" | "yearly",
      reference,
      (paymentData as any).subscription_code,
      metadata.existing_subscription_id,
    );
  }

  private async processStoreMembershipSubscription(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, reference } = paymentData;
    const { SubscriptionService } = require("../services/subscription.service");
    const service = new SubscriptionService(this.supabase);

    await service.activateSubscription({
      productId: metadata.product_id!,
      userId: metadata.user_id!,
      paystackSubscriptionCode: (paymentData as any).subscription_code,
      paystackCustomerCode: (paymentData as any).customer?.customer_code,
      paystackEmailToken: (paymentData as any).customer?.email_token,
      reference,
    });
  }

  // ---------------------------------------------------------------------------
  // Booking Payment Processing
  // ---------------------------------------------------------------------------

  private async processBookingPayment(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, reference, amount } = paymentData;
    const bookingId = metadata.booking_id as string;

    if (!bookingId) {
      console.error(
        `[Booking Webhook] Missing booking_id in metadata for reference: ${reference}`,
      );
      return;
    }

    const service = new BookingService(this.supabase);
    await service.confirmBookingPayment(bookingId, reference, amount);

    console.log(
      `[Booking Webhook] Confirmed booking ${bookingId}, ref: ${reference}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Scheduling Payment Processing
  // ---------------------------------------------------------------------------

  private isSchedulingPayment(metadata: PaystackMetadata): boolean {
    return (
      metadata.transaction_type === "scheduling_payment" &&
      Boolean(metadata.booking_id)
    );
  }

  private async processSchedulingPayment(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, reference, amount } = paymentData;
    const bookingId = metadata.booking_id as string;

    if (!bookingId) {
      console.error(
        `[Scheduling Webhook] Missing booking_id for reference: ${reference}`,
      );
      return;
    }

    const { SchedulingService } =
      await import("../services/scheduling.service");
    const service = new SchedulingService(this.supabase);
    await service.confirmSchedulingPayment(bookingId, reference, amount);

    console.log(
      `[Scheduling Webhook] Confirmed scheduled booking ${bookingId}, ref: ${reference}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Form Submission Processing
  // ---------------------------------------------------------------------------

  private async processFormSubmission(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, reference, amount } = paymentData;

    if (!metadata.form_id) {
      console.error(
        `[Form Webhook] Missing form_id in metadata for reference: ${reference}`,
      );
      return;
    }

    const service = new FormService(this.supabase);

    await service.createSubmission(
      metadata.form_id,
      metadata.form_data || {},
      reference,
      amount,
      metadata.email,
      metadata.full_name,
      "NGN",
    );

    console.log(
      `[Form Webhook] Submission created for form ${metadata.form_id}, ref: ${reference}`,
    );

    const { notificationService } =
      await import("../services/notification.services");
    const { formSubmissionConfirmation, formSubmissionOwnerNotification } =
      await import("../utils/emailsTemplate");

    const amountPaid = `₦${(amount / 100).toLocaleString("en-NG")}`;
    const formTitle = metadata.form_title || "Form";
    const submitterName = metadata.full_name || metadata.email || "Submitter";

    // 1. Confirmation email to buyer
    if (metadata.email) {
      notificationService
        .createNotification({
          toEmail: metadata.email,
          emailName: submitterName,
          emailSubject: `Registration Confirmed – ${formTitle}`,
          formatType: "html",
          emailBody: formSubmissionConfirmation({
            submitter_name: submitterName,
            form_title: formTitle,
            amount_paid: amountPaid,
            payment_reference: reference,
          }),
        })
        .catch((err: any) =>
          console.error("[Form Webhook] Buyer confirmation email failed:", err),
        );
    }

    // 2. New submission notification to the form owner / business creator
    try {
      const { data: formRecord } = await this.supabase
        .from("hilaq_forms")
        .select(
          "title, business_id, user_id, businesses(owner_user_id, users!owner_user_id(name, email))",
        )
        .eq("id", metadata.form_id)
        .single();

      // Resolve owner: prefer business owner (via owner_user_id), fall back to form user_id
      let ownerEmail: string | null = null;
      let ownerName = "Form Owner";

      const businessUser = (formRecord as any)?.businesses?.users;
      if (businessUser?.email) {
        ownerEmail = businessUser.email;
        ownerName = businessUser.name || ownerName;
      } else if (formRecord?.user_id) {
        const { data: user } = await this.supabase
          .from("users")
          .select("name, email")
          .eq("id", formRecord.user_id)
          .single();
        ownerEmail = user?.email || null;
        ownerName = user?.name || ownerName;
      }

      if (ownerEmail) {
        const dashboardUrl = `${process.env.FRONTEND_URL || "https://hilaq.com"}/dashboard/forms`;
        notificationService
          .createNotification({
            toEmail: ownerEmail,
            emailName: ownerName,
            emailSubject: `New Submission: ${formTitle}`,
            formatType: "html",
            emailBody: formSubmissionOwnerNotification({
              owner_name: ownerName,
              form_title: formTitle,
              submitter_name: submitterName,
              submitter_email: metadata.email || "",
              amount_received: amountPaid,
              payment_reference: reference,
              dashboard_url: dashboardUrl,
            }),
          })
          .catch((err: any) =>
            console.error(
              "[Form Webhook] Owner notification email failed:",
              err,
            ),
          );
      }
    } catch (err) {
      console.error("[Form Webhook] Failed to send owner notification:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Non-Event Payment (Tipping Only)
  // ---------------------------------------------------------------------------

  private async processNonEventPayment(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    const { metadata, reference, status } = paymentData;

    // Audit log
    await emailService.sendAuditEvent({
      toEmail: AUDIT_EMAIL,
      eventName: "non-event-payment.received",
      payload: { reference, status, email: metadata.email },
    });

    // Tipping
    const buyerEmail = this.getCustomFieldValue(
      metadata.custom_fields,
      "buyer_email",
    );
    if (!buyerEmail) {
      await emailService.sendAuditEvent({
        toEmail: AUDIT_EMAIL,
        eventName: "non-event-payment.unclassified",
        payload: {
          reference,
          status,
          email: metadata.email,
          metadata_keys: Object.keys(metadata),
        },
      });
      return;
    }

    const buyerName = this.getCustomFieldValue(
      metadata.custom_fields,
      "buyer_name",
    );
    const recipientName = this.getCustomFieldValue(
      metadata.custom_fields,
      "recipient_name",
    );

    await emailService.sendTippingEmail({
      userEmail: buyerEmail,
      userName: buyerName || "User",
      recipientName: recipientName || "",
    });
  }

  // ---------------------------------------------------------------------------
  // Subscription Event Handlers
  // ---------------------------------------------------------------------------

  private async handleSubscriptionDisable(data: any): Promise<void> {
    const {
      publicationSubscriptionService,
    } = require("../services/publication-subscription.service");
    const { SubscriptionService } = require("../services/subscription.service");
    const subService = new SubscriptionService(this.supabase);

    if (data?.subscription_code) {
      // Try publication service first
      await publicationSubscriptionService.handleSubscriptionDisabled(
        data.subscription_code,
      );

      // Also try store subscription service
      await subService.updateFromWebhook(data.subscription_code, {
        status: "cancelled",
      });
    }
  }

  private async handleInvoicePaymentFailed(data: any): Promise<void> {
    const {
      publicationSubscriptionService,
    } = require("../services/publication-subscription.service");
    const { SubscriptionService } = require("../services/subscription.service");
    const subService = new SubscriptionService(this.supabase);

    if (data?.subscription_code) {
      // Notify publication subscriber that payment failed
      await publicationSubscriptionService
        .notifyPaymentFailed(data.subscription_code)
        .catch((err: any) =>
          console.error(
            "[PublicationSubscription] Payment failed notification error:",
            err,
          ),
        );

      // Also log/handle for store subscriptions
      console.log(
        `[StoreSubscription] Payment failed for code: ${data.subscription_code}`,
      );

      // Trigger dunning for business subscriptions
      if (data?.metadata?.business_id) {
        const businessId = data.metadata.business_id;
        const plan = data?.metadata?.plan || data?.plan?.name || "unknown";
        dunningService
          .startDunning(
            this.supabase,
            businessId,
            plan,
            "Invoice payment failed",
          )
          .catch((err) =>
            console.error(
              "[Dunning] invoice.payment_failed trigger error:",
              err,
            ),
          );
      }
    }
  }

  private async handlePublicationSubscriptionCreated(data: any): Promise<void> {
    const subscriptionCode = data?.subscription_code;
    const customerEmail = data?.customer?.email;
    if (!subscriptionCode || !customerEmail) return;

    const {
      publicationSubscriptionService,
    } = require("../services/publication-subscription.service");

    await publicationSubscriptionService
      .handleSubscriptionCreated(subscriptionCode, customerEmail)
      .catch((err: any) =>
        console.error(
          "[PublicationSubscription] subscription.create handler error:",
          err,
        ),
      );
  }

  private async handleExpiringCards(data: any): Promise<void> {
    const customer = data.customer || {};
    const email = customer.email;
    const brand = data.authorization?.brand || "Card";
    const last4 = data.authorization?.last4 || "****";

    try {
      // Find user
      const { data: user } = await this.supabase
        .from("users")
        .select("id, name")
        .eq("email", email)
        .single();

      if (user) {
        // Send notification email to user
        // Using a generic notification email for now since specific template might not exist
        await emailService.sendAuditEvent({
          toEmail: email, // Sending to user directly
          eventName: "card.expiring",
          payload: {
            user_name: user.name,
            card_brand: brand,
            card_last4: last4,
            expiry_month: data.authorization?.exp_month,
            expiry_year: data.authorization?.exp_year,
            message: `Your ${brand} ending in ${last4} is expiring soon. Please update your payment method to avoid service interruption.`,
          },
        });
      }

      // Log for audit
      await emailService.sendAuditEvent({
        toEmail: AUDIT_EMAIL,
        eventName: "subscription.expiring_cards",
        payload: { email, brand, last4 },
      });
    } catch (error: any) {
      console.error("Error handling expiring cards:", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Business Subscription Handler
  // ---------------------------------------------------------------------------

  private async handleBusinessSubscriptionEvent(
    event: string,
    data: any,
  ): Promise<{ success: boolean; message: string }> {
    const { businessSubscriptionService } =
      await import("../services/business-subscription.service");
    return businessSubscriptionService.handleSubscriptionWebhook(event, data);
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  private validatePaymentData(
    paymentData: NormalisedPaymentData,
    mode: "PAID" | "FREE" = "PAID",
  ): NormalisedPaymentData {
    const requiredFields: Array<keyof NormalisedPaymentData> =
      mode === "FREE"
        ? ["metadata", "reference"]
        : ["metadata", "reference", "amount"];

    for (const field of requiredFields) {
      if (!(paymentData as any)[field]) {
        throw new Error(`Missing required field: ${String(field)}`);
      }
    }

    // Populate missing full_name/email from various sources
    // Store purchases use customer_name, events use full_name
    if (!paymentData.metadata.full_name) {
      // 1. Check for customer_name (used by store purchases via initializePaystackPayment)
      const { customer_name, customer_email, customer_phone } =
        paymentData.metadata as any;
      if (customer_name) {
        paymentData.metadata.full_name = customer_name;
        paymentData.metadata.email =
          paymentData.metadata.email || customer_email;
        paymentData.metadata.phone_number =
          paymentData.metadata.phone_number || customer_phone;
      }

      // 2. Check Paystack's customer object (first_name + last_name, or name)
      if (!paymentData.metadata.full_name && paymentData.customer) {
        const { name, first_name, last_name, email, phone } =
          paymentData.customer;
        const fullNameFromParts =
          `${first_name || ""} ${last_name || ""}`.trim();
        paymentData.metadata.full_name = fullNameFromParts || name || "";
        paymentData.metadata.email = paymentData.metadata.email || email;
        paymentData.metadata.phone_number =
          paymentData.metadata.phone_number || phone;
      }

      // 3. Final fallback to legacy metadata fields (firstname/lastname)
      if (!paymentData.metadata.full_name) {
        const { firstname = "", lastname = "" } = paymentData.metadata as any;
        paymentData.metadata.full_name =
          `${firstname} ${lastname}`.trim() || "User";
      }
    }

    if (!paymentData.metadata.full_name || !paymentData.metadata.email) {
      throw new Error("Missing required metadata field: full_name or email");
    }

    return paymentData;
  }

  private getCustomFieldValue(
    customFields: any[] | undefined,
    fieldName: string,
  ): string | null {
    if (!customFields || !Array.isArray(customFields)) return null;
    const field = customFields.find(
      (f: any) => f.variable_name === fieldName || f.display_name === fieldName,
    );
    return field?.value || null;
  }

  private resolveEventPaymentSummary(
    value: unknown,
    verifiedAmount: number,
    verifiedCurrency: string,
  ): EventPaymentSummary | undefined {
    let parsed = value;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return undefined;
      }
    }
    if (!parsed || typeof parsed !== "object") return undefined;

    const summary = parsed as Partial<EventPaymentSummary>;
    const subtotal = Number(summary.subtotal);
    const discount = Number(summary.discount);
    const surcharge = Number(summary.surcharge);
    if (
      !Number.isFinite(subtotal) ||
      !Number.isFinite(discount) ||
      !Number.isFinite(surcharge)
    ) {
      return undefined;
    }

    return {
      currency: verifiedCurrency,
      subtotal,
      discount,
      surcharge,
      amount: verifiedAmount,
      coupon_code:
        typeof summary.coupon_code === "string" ? summary.coupon_code : null,
      coupon_applied: summary.coupon_applied === true,
      discounts: Array.isArray(summary.discounts)
        ? summary.discounts
            .filter(
              (discount) =>
                discount &&
                typeof discount.rule_id === "string" &&
                Number.isFinite(Number(discount.amount)),
            )
            .map((discount) => ({
              rule_id: discount.rule_id,
              mode: discount.mode === "percent" ? "percent" : "flat",
              value: Number(discount.value) || 0,
              amount: Number(discount.amount),
              coupon_code:
                typeof discount.coupon_code === "string"
                  ? discount.coupon_code
                  : undefined,
              message:
                typeof discount.message === "string"
                  ? discount.message
                  : undefined,
            }))
        : undefined,
    };
  }

  /**
   * Resolve the payment summary for an event purchase, reconstructing it from
   * authoritative checkout evidence when provider metadata lacks one (Paystack
   * strips oversized payloads; checkouts initiated before the accounting
   * deploy predate the field entirely).
   */
  private async resolveEventPaymentSummaryWithFallback(
    metadata: Pick<PaystackMetadata, "event_payment_summary" | "event_id">,
    reference: string,
    verifiedAmount: number,
    verifiedCurrency: string,
  ): Promise<EventPaymentSummary | undefined> {
    const direct = this.resolveEventPaymentSummary(
      metadata.event_payment_summary,
      verifiedAmount,
      verifiedCurrency,
    );
    if (direct) return direct;

    if (!metadata.event_id) return undefined;

    try {
      const [snapshotResult, pendingResult, eventResult] = await Promise.all([
        supabaseAdmin!
          .from("event_pricing_snapshots")
          .select(
            "reference, breakdown, base_total, adjustment_total, currency",
          )
          .eq("reference", reference)
          .maybeSingle(),
        pendingCheckoutService.findByReference(supabaseAdmin!, reference),
        supabaseAdmin!
          .from("events")
          .select("pricing_rules")
          .eq("id", metadata.event_id)
          .maybeSingle(),
      ]);

      const snapshot = snapshotResult.data;
      if (!snapshot) return undefined;

      const reconstructed = deriveEventPaymentSummary({
        snapshot: {
          reference,
          breakdown: snapshot.breakdown,
          base_total: snapshot.base_total,
          adjustment_total: snapshot.adjustment_total,
          currency: snapshot.currency,
        },
        couponRules: extractCouponRules(eventResult.data?.pricing_rules),
        submittedCode: extractSubmittedCoupon(pendingResult?.metadata ?? null),
        verifiedAmount,
      });
      if (reconstructed) {
        console.log(
          `[Webhook] Reconstructed event payment summary from pricing evidence for ${reference}`,
        );
      }
      return reconstructed;
    } catch (error) {
      console.error(
        `Failed to reconstruct event payment summary for ${reference}:`,
        error,
      );
      return undefined;
    }
  }

  private async generateAndStoreTickets(
    ticketSalesResp: any[],
    eventData: any,
    orderData: Order,
    purchaserData: any,
    event_id: string,
    recipients: Recipient[] = [],
    purchaserCustomAnswers: Record<string, string> = {},
    pricingBreakdown: any[] = [],
  ): Promise<any[]> {
    const now = new Date();
    const eventDateString = isEventDateTbd(eventData.start_date)
      ? EVENT_DATE_TBD_LABEL
      : `${eventData.start_date} from ${eventData.start_time} to ${eventData.end_time}`;

    // Consume one matching priced seat per issued ticket (by ticket + attendee
    // email), so each ticket records the exact tier/adjustment it was charged.
    const seats = pricingBreakdown.map((seat) => ({
      ...seat,
      consumed: false,
    }));
    const takeSeatPricing = (ticketId: string, email: string) => {
      const target = email?.toLowerCase();
      const seat = seats.find(
        (s) =>
          !s.consumed &&
          s.ticketId === ticketId &&
          s.attendeeEmail?.toLowerCase() === target,
      );
      if (!seat) return { price_adjustment: 0, pricing_tier: null };
      seat.consumed = true;
      return {
        price_adjustment: Number(seat.adjustment) || 0,
        pricing_tier: seat.tier ?? null,
      };
    };

    const baseTicketInfo = (purchase: any, customerName: string) => ({
      eventName: eventData.event_name,
      ticketName: `${purchase.ticket.ticket_name} - ₦${Number(purchase.ticket.ticket_price).toLocaleString()}`,
      ticketPrice: purchase.ticket.ticket_price,
      address: eventData.is_physical
        ? (eventData.venue?.placeDesc ?? "Unknown venue")
        : "Online Event",
      eventDate: eventDateString,
      orderId: orderData.id,
      customerName,
      orderDate: now.toDateString(),
      time: now.toLocaleTimeString(),
      date: now.toDateString(),
    });

    const generateTicketEntryCode = () => {
      const prefix = "TKT-";
      const randomPart = crypto.randomBytes(5).toString("hex").toUpperCase();
      return `${prefix}${randomPart}`;
    };

    const storeTickets = async (tickets: any[]) => {
      const payload = tickets.map((t) => ({
        order_id: t.orderId,
        customer_name: t.customerName,
        customer_phone: t.customer_phone,
        customer_gender: t.customer_gender,
        customer_custom_fields: t.customer_custom_fields || {},
        ticket_name: t.ticketName,
        ticket_price: t.ticketPrice,
        entry_code: t.ticketEntryCode,
        qr_code: t.qrCode,
        event_id,
        customer_email: t.customer_email,
        payment_method: "online",
        price_adjustment: t.price_adjustment ?? 0,
        pricing_tier: t.pricing_tier ?? null,
      }));
      const { data: inserted } = await this.supabase
        .from("issued_tickets")
        .insert(payload)
        .select("id");
      // Assign registration numbers sequentially (advisory lock handles concurrency)
      if (inserted) {
        for (const row of inserted) {
          const { error: regErr } = await this.supabase.rpc(
            "assign_registration_number",
            {
              p_ticket_id: row.id,
              p_event_id: event_id,
            },
          );
          if (regErr)
            console.error(
              `[Registration] Failed to assign number for ticket ${row.id}:`,
              regErr.message,
            );
        }
      }
    };

    const storeSingleTicket = async (t: any) => {
      const payload = {
        order_id: t.orderId,
        customer_name: t.customerName,
        customer_phone: t.customer_phone,
        customer_gender: t.customer_gender,
        customer_custom_fields: t.customer_custom_fields || {},
        ticket_name: t.ticketName,
        ticket_price: t.ticketPrice,
        entry_code: t.ticketEntryCode,
        qr_code: t.qrCode,
        event_id,
        customer_email: t.customer_email,
        payment_method: "online",
        price_adjustment: t.price_adjustment ?? 0,
        pricing_tier: t.pricing_tier ?? null,
      };
      const { data } = await this.supabase
        .from("issued_tickets")
        .insert(payload)
        .select()
        .single();

      // Assign sequential registration number atomically
      if (data?.id) {
        const { data: regNum, error: regErr } = await this.supabase.rpc(
          "assign_registration_number",
          { p_ticket_id: data.id, p_event_id: event_id },
        );
        if (regErr) {
          console.error(
            `[Registration] Failed to assign number for ticket ${data.id}:`,
            regErr.message,
          );
        } else {
          data.registration_number = regNum;
        }
      }

      return data;
    };

    let allIssuedTickets: any[] = [];

    // Handle recipients (gifted tickets)
    if (recipients.length > 0) {
      for (const r of recipients) {
        const email = r.email ?? purchaserData.email;
        const fullName = r.full_name ?? purchaserData.full_name;
        const entryCode = generateTicketEntryCode();
        const qrCode = await generateQRCode(entryCode);

        const match = ticketSalesResp.find((p) => p.ticket.id === r.ticketId);
        if (!match) continue;

        const ticket = {
          ...baseTicketInfo(match, fullName),
          id: r.ticketId,
          ticketEntryCode: entryCode,
          qrCode,
          customer_email: email,
          customer_phone: r.phone_number ?? purchaserData.phone_number,
          customer_gender:
            r.gender ??
            r.custom_answers?.gender ??
            purchaserData.gender ??
            purchaserCustomAnswers?.gender,
          customer_custom_fields:
            r.custom_answers ?? purchaserCustomAnswers ?? {},
          ...takeSeatPricing(r.ticketId, email),
        };

        const stored = await storeSingleTicket(ticket);
        const calendarLinks = this.buildEventCalendarLinks(eventData, event_id);
        await emailService.sendTicketReceiptEmail({
          userEmail: email,
          ticketId: stored.id,
          eventName: eventData.event_name,
          eventDate: formatEventDate(
            eventData.start_date,
            eventData.start_time,
          ),
          venue: eventData.is_physical
            ? (eventData.venue?.placeDesc ??
              eventData.venue?.full_address ??
              "Venue TBA")
            : "Online Event",
          registrationNumber: stored?.registration_number ?? null,
          confirmationEmail: eventData.confirmation_email ?? null,
          googleCalendarUrl: calendarLinks.googleCalendarUrl,
          icsUrl: calendarLinks.icsUrl,
          dateTbd: isEventDateTbd(eventData.start_date),
        });
        allIssuedTickets.push(ticket);
      }
      return allIssuedTickets;
    }

    // Purchaser flow
    const purchaserTickets = await Promise.all(
      ticketSalesResp.map(async (purchase) => {
        const tickets: any[] = [];
        for (let i = 0; i < purchase.quantity_sold; i++) {
          const entryCode = generateTicketEntryCode();
          const qrCode = await generateQRCode(entryCode);
          tickets.push({
            ...baseTicketInfo(purchase, purchaserData.full_name),
            ticketEntryCode: entryCode,
            qrCode,
            customer_email: purchaserData.email,
            customer_phone: purchaserData.phone_number,
            customer_gender:
              purchaserData.gender ?? purchaserCustomAnswers?.gender,
            customer_custom_fields: purchaserCustomAnswers || {},
            ...takeSeatPricing(purchase.ticket.id, purchaserData.email),
          });
        }
        return tickets;
      }),
    );

    const flat = purchaserTickets.flat();
    await storeTickets(flat);
    return flat;
  }

  // ---------------------------------------------------------------------------
  // Calendar Link Helpers
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Admin Payment Recovery
  // ---------------------------------------------------------------------------

  /**
   * Verify a payment reference through its provider adapter and fulfill the
   * order if not yet processed.
   * Used by admins to recover from missed or failed webhooks.
   */
  async replayWebhook(reference: string): Promise<{
    paymentStatus: string;
    paymentType: string;
    alreadyProcessed: boolean;
    fulfilled: boolean;
    customerEmail?: string;
    amount?: number;
    event?: { id: string; name: string } | null;
  }> {
    const paymentData = await this.verifyPaymentForRecovery(reference);

    const result = {
      paymentStatus: paymentData.status,
      paymentType: this.resolvePaymentType(paymentData.metadata),
      alreadyProcessed: false,
      fulfilled: false,
      customerEmail: paymentData.metadata?.email ?? paymentData.customer?.email,
      amount: paymentData.amount,
      event: null as { id: string; name: string } | null,
    };

    if (paymentData.status !== "success") return result;

    // Legacy Paystack event references embed the event id prefix. This remains
    // a fallback for old rows that predate pending_checkouts.
    const recoveredEvent = await this.resolveEventFromReference(reference);
    if (recoveredEvent) {
      result.paymentType = "event";
      result.event = recoveredEvent;
    }

    result.alreadyProcessed = await this.isReferenceAlreadyProcessed(
      reference,
      paymentData.metadata,
    );
    if (result.alreadyProcessed) return result;

    if (this.isDedicatedNubanDeposit(paymentData)) {
      const recorded = await this.bankingService().recordDedicatedNubanDeposit(
        {
          reference,
          authorization: paymentData.authorization,
        },
      );
      result.paymentType = "virtual_account_deposit";
      result.fulfilled = recorded;
      return result;
    }

    await this.handleChargeSuccess(paymentData);

    // Only report fulfillment when an order actually exists now — metadata-less
    // payments fall through the webhook routing and create nothing.
    const [storeOrder, eventOrder] = await Promise.all([
      this.supabase
        .from("store_orders")
        .select("id")
        .eq("payment_reference", reference)
        .maybeSingle(),
      this.supabase
        .from("orders")
        .select("id")
        .eq("payment_reference", reference)
        .maybeSingle(),
    ]);
    result.fulfilled = Boolean(storeOrder.data || eventOrder.data);
    return result;
  }

  /**
   * Fulfill an event purchase from admin-reconstructed checkout data.
   */
  async fulfillEventPurchase(
    paymentData: NormalisedPaymentData,
  ): Promise<void> {
    await this.processEventPurchase(paymentData);
  }

  /**
   * Resolve the event a payment belongs to from its reference. Legacy Paystack event
   * references are EVT-<eventIdPrefix>-<timestamp>, so the embedded prefix
   * uniquely identifies the event without any webhook metadata.
   */
  private async resolveEventFromReference(
    reference: string,
  ): Promise<{ id: string; name: string } | null> {
    if (!reference.startsWith("EVT-")) return null;
    const eventIdPrefix = reference.split("-")[1];
    if (!eventIdPrefix) return null;

    const { data } = await this.supabase
      .from("events")
      .select("id, event_name")
      .ilike("id", `${eventIdPrefix}%`)
      .maybeSingle();
    return data ? { id: data.id, name: data.event_name } : null;
  }

  /**
   * Complete an event order that exists but stopped before ticket issuance or
   * receipt delivery. This is deliberately separate from replayWebhook(), which
   * treats an existing order as fully processed.
   */
  async recoverEventOrderFulfillment(reference: string): Promise<{
    paymentStatus: string;
    paymentType: string;
    orderId?: string;
    ticketsIssued: number;
    emailsSent: boolean;
    alreadyComplete: boolean;
    customerEmail?: string;
    amount?: number;
  }> {
    const paymentData = await this.verifyPaymentForRecovery(reference);

    const paymentType = this.resolvePaymentType(paymentData.metadata);
    const result = {
      paymentStatus: paymentData.status,
      paymentType,
      orderId: undefined as string | undefined,
      ticketsIssued: 0,
      emailsSent: false,
      alreadyComplete: false,
      customerEmail: paymentData.metadata?.email ?? paymentData.customer?.email,
      amount: paymentData.amount,
    };

    if (paymentData.status !== "success") return result;
    if (!this.isEventPurchase(paymentData.metadata)) {
      throw new Error("This payment is not an event ticket purchase");
    }

    const verified = this.validatePaymentData(paymentData);
    const { metadata, amount } = verified;
    const eventPaymentSummary =
      await this.resolveEventPaymentSummaryWithFallback(
        metadata,
        paymentData.reference,
        amount / 100,
        verified.currency,
      );

    const parseField = <T>(value: unknown, fallback: T): T => {
      if (value === null || value === undefined) return fallback;
      if (typeof value === "string") {
        try {
          return JSON.parse(value) as T;
        } catch {
          return fallback;
        }
      }
      return value as T;
    };

    const selectedTickets = parseField<Record<string, number>>(
      metadata.selectedTickets,
      {},
    );
    const tickets = parseField<EventTicket[]>(metadata.tickets, []);
    const recipients = parseField<Recipient[]>(metadata.recipients, []);
    const customAnswers = parseField<Record<string, string>>(
      metadata.custom_answers,
      {},
    );
    const customerInfo = {
      full_name: metadata.full_name ?? "",
      email: metadata.email ?? "",
      phone_number: metadata.phone_number,
      gender: metadata.gender ?? customAnswers?.gender,
    };

    const purchaseService = createPurchaseService(this.supabase);
    const customerData = await purchaseService.saveCustomer(customerInfo);

    type RecoveryOrder = Order & { confirmation_email_sent_at?: string | null };

    let orderData: RecoveryOrder | null = null;
    const { data: foundOrder, error: orderError } = await this.supabase
      .from("orders")
      .select("id, customer_id, event_id, total_amount, payment_reference, created_at, confirmation_email_sent_at")
      .eq("payment_reference", reference)
      .maybeSingle();
    if (orderError) throw orderError;
    orderData = foundOrder as RecoveryOrder | null;

    if (!orderData) {
      orderData = eventPaymentSummary
        ? await purchaseService.createOrder(
            customerData.id,
            metadata.event_id!,
            amount,
            reference,
            {
              currency: eventPaymentSummary.currency,
              subtotal: eventPaymentSummary.subtotal,
              discount: eventPaymentSummary.discount,
              surcharge: eventPaymentSummary.surcharge,
              discountCode: eventPaymentSummary.coupon_code,
              discounts: eventPaymentSummary.discounts,
            },
          )
        : await purchaseService.createOrder(
            customerData.id,
            metadata.event_id!,
            amount,
            reference,
          );
    }
    if (!orderData) {
      const { data: existingOrder, error: existingOrderError } =
        await this.supabase
          .from("orders")
          .select("id, customer_id, event_id, total_amount, payment_reference, created_at, confirmation_email_sent_at")
          .eq("payment_reference", reference)
          .single();
      if (existingOrderError) throw existingOrderError;
      orderData = existingOrder as RecoveryOrder;
    }
    if (eventPaymentSummary) {
      const { data: updatedOrder, error: accountingError } = await this.supabase
        .from("orders")
        .update({
          subtotal_amount: eventPaymentSummary.subtotal,
          discount_amount: eventPaymentSummary.discount,
          surcharge_amount: eventPaymentSummary.surcharge,
          currency: eventPaymentSummary.currency,
          discount_code:
            eventPaymentSummary.discount > 0
              ? (eventPaymentSummary.coupon_code ?? null)
              : null,
          discount_details:
            eventPaymentSummary.discount > 0
              ? (eventPaymentSummary.discounts ?? [])
              : [],
        })
        .eq("id", orderData.id)
        .select("*")
        .single();
      if (accountingError) throw accountingError;
      orderData = updatedOrder;
    }
    if (!orderData) {
      throw new Error("Order could not be resolved for recovery");
    }
    result.orderId = orderData.id;

    const { data: existingIssuedTickets, error: issuedError } =
      await this.supabase
        .from("issued_tickets")
        .select("id")
        .eq("order_id", orderData.id);
    if (issuedError) throw issuedError;

    let generatedEventData: any = null;
    if (!existingIssuedTickets?.length) {
      const { data: existingTicketSales, error: salesError } =
        await this.supabase
          .from("ticket_sales")
          .select("id, order_id, ticket_id, quantity, total_price, ticket:ticket_id(id, ticket_name, ticket_price, event_id)")
          .eq("order_id", orderData.id);
      if (salesError) throw salesError;

      let ticketSalesResp: any[] = existingTicketSales ?? [];
      if (ticketSalesResp.length === 0) {
        ticketSalesResp = await purchaseService.processTicketSales(
          orderData.id,
          selectedTickets,
          tickets,
        );
        await purchaseService.updateTicketQuantities(selectedTickets);
      }

      const eventData = await purchaseService.getEventDetails(
        metadata.event_id!,
      );
      generatedEventData = eventData;
      const { data: snapshot } = await this.supabase
        .from("event_pricing_snapshots")
        .select("breakdown")
        .eq("reference", reference)
        .maybeSingle();
      const pricingBreakdown = Array.isArray(snapshot?.breakdown)
        ? snapshot!.breakdown
        : [];

      const issuedTickets = await this.generateAndStoreTickets(
        ticketSalesResp,
        eventData,
        orderData,
        customerInfo,
        metadata.event_id!,
        recipients,
        customAnswers,
        pricingBreakdown,
      );
      result.ticketsIssued = issuedTickets.length;
    }

    const { data: refreshedTickets, error: refreshedError } =
      await this.supabase
        .from("issued_tickets")
        .select("id")
        .eq("order_id", orderData.id);
    if (refreshedError) throw refreshedError;

    if (refreshedTickets?.length && !orderData.confirmation_email_sent_at) {
      if (result.ticketsIssued > 0 && recipients.length > 0) {
        const purchaserEmailedAsRecipient = recipients.some(
          (r: Recipient) =>
            (r.email ?? customerInfo.email) === customerInfo.email,
        );

        if (!purchaserEmailedAsRecipient && generatedEventData) {
          const receiptVenue = generatedEventData.is_physical
            ? (generatedEventData.venue?.placeDesc ??
              generatedEventData.venue?.full_address ??
              "Venue TBA")
            : "Online Event";
          const { data: firstTicketRow } = await this.supabase
            .from("issued_tickets")
            .select("registration_number")
            .eq("order_id", orderData.id)
            .order("registration_number", { ascending: true })
            .limit(1)
            .single();
          const eventCalendarLinks = this.buildEventCalendarLinks(
            generatedEventData,
            metadata.event_id as string,
          );

          await emailService.sendTicketReceiptEmail({
            userEmail: metadata.email ?? "",
            ticketId: orderData.id,
            eventName: generatedEventData.event_name,
            eventDate: formatEventDate(
              generatedEventData.start_date,
              generatedEventData.start_time,
            ),
            venue: receiptVenue,
            registrationNumber: firstTicketRow?.registration_number ?? null,
            confirmationEmail:
              (generatedEventData as any).confirmation_email ?? null,
            googleCalendarUrl: eventCalendarLinks.googleCalendarUrl,
            icsUrl: eventCalendarLinks.icsUrl,
            dateTbd: isEventDateTbd(generatedEventData.start_date),
            paymentSummary: eventPaymentSummary,
          });
        }
      } else {
        await this.resendEventOrderEmails(orderData.id);
      }
      const { error: stampError } = await this.supabase
        .from("orders")
        .update({ confirmation_email_sent_at: new Date().toISOString() })
        .eq("id", orderData.id);
      if (stampError) throw stampError;
      result.emailsSent = true;
    }

    result.alreadyComplete =
      !!existingIssuedTickets?.length && !!orderData.confirmation_email_sent_at;
    if (!result.ticketsIssued && refreshedTickets?.length) {
      result.ticketsIssued = refreshedTickets.length;
    }
    return result;
  }

  /**
   * Provider-neutral verification used by every admin recovery operation.
   * Provider adapters normalize remote responses; pending_checkouts restores
   * the original local metadata required by the fulfillment router.
   */
  async verifyPaymentForRecovery(
    reference: string,
  ): Promise<NormalisedPaymentData> {
    const provider = PaymentProviderFactory.getProviderForReference(reference);
    const paymentData = await provider.verifyPayment(reference);
    const restored = await this.restorePendingCheckoutMetadata(
      paymentData,
      "PAID",
    );

    if (restored && "blocked" in restored) {
      throw new Error(
        "Payment amount does not match the pending checkout; fulfillment is blocked",
      );
    }

    return restored?.paymentData ?? paymentData;
  }

  private resolvePaymentType(metadata: PaystackMetadata): string {
    if (this.isEventPurchase(metadata)) return "event";
    if (this.isStorePurchase(metadata)) return "store";
    if (this.isBookingPayment(metadata)) return "booking";
    if (this.isFormSubmission(metadata)) return "form";
    if (this.isCoursePurchase(metadata)) return "course";
    if (this.isCampaignCreditTopUp(metadata)) return "campaign_credit_topup";
    if (this.isStoreMembershipSubscription(metadata)) return "store_membership";
    if (this.isPublicationSubscription(metadata)) return "publication";
    return "unknown";
  }

  private async isReferenceAlreadyProcessed(
    reference: string,
    metadata: PaystackMetadata,
  ): Promise<boolean> {
    // A wallet deposit is fulfilled by its wallet_transactions credit, not an
    // order row — check it first so replays report alreadyProcessed instead of
    // attempting a second credit.
    const { data: walletTransaction } = await this.supabase
      .from("wallet_transactions")
      .select("id")
      .eq("provider", "paystack")
      .eq("provider_reference", reference)
      .maybeSingle();
    if (walletTransaction) return true;

    if (this.isStorePurchase(metadata)) {
      const { data } = await this.supabase
        .from("store_orders")
        .select("id")
        .eq("payment_reference", reference)
        .maybeSingle();
      return !!data;
    }

    if (this.isEventPurchase(metadata)) {
      const { data } = await this.supabase
        .from("orders")
        .select("id")
        .eq("payment_reference", reference)
        .maybeSingle();
      return !!data;
    }

    if (this.isBookingPayment(metadata)) {
      const { data } = await this.supabase
        .from("service_bookings")
        .select("id")
        .eq("payment_reference", reference)
        .maybeSingle();
      return !!data;
    }

    return false;
  }

  /**
   * Resend ticket receipt emails for an event order that is already in the DB.
   * Fetches issued tickets and event details, then fires the same emails the
   * webhook would have sent.
   */
  async resendEventOrderEmails(
    orderId: string,
    supabaseClient?: SupabaseClient,
  ): Promise<void> {
    const client = supabaseClient ?? this.supabase;

    const { data: order } = await client
      .from("orders")
      .select("id, event_id, payment_reference, total_amount")
      .eq("id", orderId)
      .single();
    if (!order) throw new Error(`Order ${orderId} not found`);

    const { data: tickets } = await client
      .from("issued_tickets")
      .select("id, customer_email, customer_name, registration_number")
      .eq("order_id", orderId)
      .order("registration_number", { ascending: true });
    if (!tickets?.length)
      throw new Error("No issued tickets found for this order");

    const purchaseService = createPurchaseService(client);
    const eventData = await purchaseService.getEventDetails(order.event_id);

    const receiptVenue = eventData.is_physical
      ? (eventData.venue?.placeDesc ??
        eventData.venue?.full_address ??
        "Venue TBA")
      : "Online Event";
    const calendarLinks = this.buildEventCalendarLinks(
      eventData,
      order.event_id,
    );
    const pendingCheckout = await pendingCheckoutService.findByReference(
      client,
      order.payment_reference,
    );
    const snapshottedCurrency =
      pendingCheckout?.metadata?.currency ??
      pendingCheckout?.metadata?.event_payment_summary?.currency;
    const verifiedPayment = snapshottedCurrency
      ? null
      : await PaymentProviderFactory.getProviderForReference(
          order.payment_reference,
        )
          .verifyPayment(order.payment_reference)
          .catch(() => null);
    const paidAmount = pendingCheckout
      ? pendingCheckout.amount_kobo / 100
      : verifiedPayment
        ? verifiedPayment.amount / 100
        : Number(order.total_amount) || 0;
    const paidCurrency =
      snapshottedCurrency ?? verifiedPayment?.currency ?? "NGN";
    const eventPaymentSummary =
      await this.resolveEventPaymentSummaryWithFallback(
        {
          event_payment_summary:
            pendingCheckout?.metadata?.event_payment_summary ??
            verifiedPayment?.metadata?.event_payment_summary,
          event_id: order.event_id,
        },
        order.payment_reference,
        paidAmount,
        paidCurrency,
      );
    const buyerEmail =
      pendingCheckout?.metadata?.email ?? verifiedPayment?.customer?.email;

    // Send one receipt to each unique customer email in the ticket set
    const emailedAddresses = new Set<string>();
    for (const ticket of tickets) {
      const email = ticket.customer_email;
      if (!email || emailedAddresses.has(email)) continue;
      emailedAddresses.add(email);
      await emailService.sendTicketReceiptEmail({
        userEmail: email,
        ticketId: orderId,
        eventName: eventData.event_name,
        eventDate: formatEventDate(eventData.start_date, eventData.start_time),
        venue: receiptVenue,
        registrationNumber: ticket.registration_number ?? null,
        confirmationEmail: (eventData as any).confirmation_email ?? null,
        googleCalendarUrl: calendarLinks.googleCalendarUrl,
        icsUrl: calendarLinks.icsUrl,
        dateTbd: isEventDateTbd(eventData.start_date),
        paymentSummary:
          buyerEmail && email.toLowerCase() === buyerEmail.toLowerCase()
            ? eventPaymentSummary
            : undefined,
      });
    }

    // Vendor notification
    const { data: vendor } = await client
      .from("users")
      .select("name, email")
      .eq("id", eventData.owner_id)
      .single();
    if (vendor) {
      await emailService.sendVendorSaleEmail({
        vendorEmail: vendor.email,
        vendorName: vendor.name,
        eventId: order.event_id,
        eventName: eventData.event_name,
        buyerName: tickets[0]?.customer_name ?? "",
        amount: paidAmount,
        currency: paidCurrency,
        quantity: tickets.length,
        dateTime: new Date().toLocaleString(),
        paymentSummary: eventPaymentSummary,
      });
    }
  }

  /**
   * Resend confirmation email for a store order that is already in the DB.
   */
  async resendStoreOrderEmails(
    orderId: string,
    supabaseClient?: SupabaseClient,
  ): Promise<void> {
    const client = supabaseClient ?? this.supabase;

    const { data: order, error: orderError } = await client
      .from("store_orders")
      .select("id, store_id, user_id, customer_name, customer_email, customer_phone, customer_address, order_number, items, subtotal, discount, total, delivery_fee, shipping_carrier, created_at, currency, payment_reference, tax_amount, service_charge_amount")
      .eq("id", orderId)
      .single();
    if (orderError || !order) {
      throw new Error(`Store order ${orderId} not found`);
    }

    // Orders created before multi-currency recovery stored an NGN-derived
    // total. Rehydrate the actual buyer charge for accurate resend emails.
    const pendingCheckout = await pendingCheckoutService.findByReference(
      client,
      order.payment_reference,
    );
    const verifiedPayment = pendingCheckout
      ? null
      : await PaymentProviderFactory.getProviderForReference(
          order.payment_reference,
        )
          .verifyPayment(order.payment_reference)
          .catch(() => null);
    const paidCurrency = (pendingCheckout?.metadata?.currency ??
      verifiedPayment?.currency ??
      order.currency ??
      "NGN") as SupportedCurrency;
    const pricingSnapshot = pendingCheckout?.metadata?.pricing_snapshot;
    const originalDeliveryFee = Number(
      pendingCheckout?.metadata?.delivery_fee ?? order.delivery_fee ?? 0,
    );
    const snapshottedDeliveryFee = Number(
      pendingCheckout?.metadata?.converted_delivery_fee,
    );
    const paidDeliveryFee =
      pricingSnapshot?.version === 1
        ? pricingSnapshot.delivery.converted_amount
        : originalDeliveryFee === 0 || paidCurrency === "NGN"
          ? originalDeliveryFee
          : Number.isFinite(snapshottedDeliveryFee)
            ? snapshottedDeliveryFee
            : await resolvePaymentAmount(originalDeliveryFee, paidCurrency);
    const snapshottedSubtotal = Number(
      pendingCheckout?.metadata?.converted_subtotal,
    );
    const snapshottedDiscount = Number(
      pendingCheckout?.metadata?.converted_discount,
    );
    let paidSubtotal: number;
    let paidDiscount: number;

    if (pricingSnapshot?.version === 1) {
      paidSubtotal = pricingSnapshot.subtotal;
      paidDiscount = pricingSnapshot.discount;
    } else if (
      Number.isFinite(snapshottedSubtotal) &&
      Number.isFinite(snapshottedDiscount)
    ) {
      paidSubtotal = snapshottedSubtotal;
      paidDiscount = snapshottedDiscount;
    } else if (paidCurrency === "NGN") {
      paidSubtotal = Number(order.subtotal) || 0;
      paidDiscount = Number(order.discount) || 0;
    } else {
      const orderSubtotal = Number(order.subtotal) || 0;
      const orderDiscount = Number(order.discount) || 0;
      const discountRate =
        orderSubtotal > 0 ? orderDiscount / orderSubtotal : 0;
      const convertedBaseTotal = Number(
        pendingCheckout?.metadata?.converted_items_total,
      );
      const orderTaxes =
        (Number(order.tax_amount) || 0) +
        (Number(order.service_charge_amount) || 0);
      const paidTaxes = await resolvePaymentAmount(orderTaxes, paidCurrency);
      const paidNetMerchandise =
        Number.isFinite(convertedBaseTotal) && discountRate < 1
          ? convertedBaseTotal - paidDeliveryFee - paidTaxes
          : NaN;

      if (Number.isFinite(paidNetMerchandise)) {
        paidSubtotal = Number(
          (paidNetMerchandise / (1 - discountRate)).toFixed(2),
        );
        paidDiscount = Number((paidSubtotal * discountRate).toFixed(2));
      } else {
        paidSubtotal = await resolvePaymentAmount(orderSubtotal, paidCurrency);
        paidDiscount = await resolvePaymentAmount(orderDiscount, paidCurrency);
      }
    }
    const paidTax =
      pricingSnapshot?.version === 1
        ? pricingSnapshot.tax.converted_amount
        : paidCurrency === "NGN"
          ? Number(order.tax_amount) || 0
          : await resolvePaymentAmount(
              Number(order.tax_amount) || 0,
              paidCurrency,
            );
    const paidServiceCharge =
      pricingSnapshot?.version === 1
        ? pricingSnapshot.service_charge.converted_amount
        : paidCurrency === "NGN"
          ? Number(order.service_charge_amount) || 0
          : await resolvePaymentAmount(
              Number(order.service_charge_amount) || 0,
              paidCurrency,
            );
    const internalItems = Array.isArray(order.items) ? order.items : [];
    const internalItemsSubtotal = internalItems.reduce(
      (sum: number, item: any) =>
        sum + (Number(item.price) || 0) * (Number(item.quantity) || 1),
      0,
    );
    const paymentItems =
      pricingSnapshot?.version === 1
        ? pricingSnapshot.items.map((item) => ({
            productId: item.product_id,
            name: item.product_name,
            variantName: item.variant_name,
            quantity: item.quantity,
            unitPrice: item.converted_unit_price,
            lineTotal: item.converted_line_total,
          }))
        : internalItems.map((item: any) => {
            const quantity = Number(item.quantity) || 1;
            const internalLineTotal = (Number(item.price) || 0) * quantity;
            const lineTotal =
              internalItemsSubtotal > 0
                ? Number(
                    (
                      paidSubtotal *
                      (internalLineTotal / internalItemsSubtotal)
                    ).toFixed(2),
                  )
                : 0;
            return {
              productId: item.product_id ?? "",
              name: item.product_name ?? "Item",
              variantName: item.variant_name ?? null,
              quantity,
              unitPrice: Number((lineTotal / quantity).toFixed(2)),
              lineTotal,
            };
          });
    const paymentSummary = {
      amount:
        (pendingCheckout?.amount_kobo ??
          verifiedPayment?.amount ??
          order.total * 100) / 100,
      currency: paidCurrency,
      subtotal: paidSubtotal,
      discount: paidDiscount,
      deliveryFee: paidDeliveryFee,
      tax: paidTax,
      serviceCharge: paidServiceCharge,
      items: paymentItems,
    };

    const { data: store } = await client
      .from("stores")
      .select("name, user_id, business_id, after_purchase")
      .eq("id", order.store_id)
      .single();

    const storeName = store?.name ?? "Store";
    const { storeEmailService } = require("../utils/storeEmails.util");
    await storeEmailService.sendOrderConfirmation(
      order,
      storeName,
      store?.business_id,
      store?.after_purchase?.thank_you_message,
      paymentSummary,
    );

    if (store?.user_id) {
      const { data: owner } = await client
        .from("users")
        .select("email")
        .eq("id", store.user_id)
        .single();
      if (owner?.email) {
        await storeEmailService.sendNewOrderNotification(
          order,
          owner.email,
          storeName,
          paymentSummary,
        );
      }
    }
  }

  private buildEventCalendarLinks(
    eventData: {
      event_name: string;
      start_date: string | null;
      start_time: string | null;
      end_date?: string | null;
      end_time?: string | null;
      venue?: { placeDesc?: string; full_address?: string };
      is_physical?: boolean;
    },
    eventId: string,
  ): { googleCalendarUrl: string | null; icsUrl: string | null } {
    // No date yet (TBD) — a calendar invite cannot be built. The email
    // template renders a "Dates to be Disclosed" note instead of buttons.
    if (isEventDateTbd(eventData.start_date)) {
      return { googleCalendarUrl: null, icsUrl: null };
    }

    // PostgreSQL TIME columns arrive as "HH:MM:SS". Slice to "HH:MM" before
    // constructing the ISO string — appending ":00" to a full "HH:MM:SS" value
    // produces an unparseable string that causes new Date() to return Invalid Date,
    // and toISOString() then throws, killing the entire processAsync chain before
    // the ticket receipt email is sent.
    const toHHMM = (time: string) => time.slice(0, 5);

    const startIso = `${eventData.start_date}T${toHHMM(eventData.start_time!)}`;
    const endIso = eventData.end_time
      ? `${eventData.end_date ?? eventData.start_date}T${toHHMM(eventData.end_time)}`
      : undefined;
    const location = eventData.is_physical
      ? (eventData.venue?.placeDesc ??
        eventData.venue?.full_address ??
        undefined)
      : "Online Event";

    const googleCalendarUrl = buildGoogleCalendarUrl({
      title: eventData.event_name,
      start: startIso,
      end: endIso ?? null,
      location: location ?? null,
    });

    const serverUrl = process.env.SERVER_URL ?? "https://api.hilaq.com";
    const icsUrl = `${serverUrl}/events/public/event/${eventId}/calendar`;

    return { googleCalendarUrl, icsUrl };
  }
}

// =============================================================================
// Singleton Export (maintains backward compatibility)
// =============================================================================

const webhookController = new WebhookController();
export { webhookController };

export const handlePaystackWebhook = (req: Request, res: Response) =>
  webhookController.handlePaystackWebhook(req, res);

export const handlePaystackWebhookJob = (req: Request, res: Response) =>
  webhookController.processPaystackWebhookJob(req, res);

export const handleFlutterwaveWebhook = (req: Request, res: Response) =>
  webhookController.handleFlutterwaveWebhook(req, res);

export const handleFreeTickets = (req: Request, res: Response) =>
  webhookController.handleFreeTickets(req, res);

// Also export for handleSuccessfulPayment (used internally by handleFreeTickets test)
export const handleSuccessfulPayment = async (
  paymentData: NormalisedPaymentData,
  _supabaseClient: any,
  mode: "PAID" | "FREE" = "PAID",
) => {
  // This is a compatibility shim - the new controller handles this internally
  const controller = new WebhookController();
  return (controller as any).handleChargeSuccess(paymentData, mode);
};

export default WebhookController;
