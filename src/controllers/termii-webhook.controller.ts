import { createHmac, timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabaseAdmin";
import ApiResponse from "../utils/apiResponse";
import { normalizeInternationalPhone } from "../utils/phone-number";

interface TermiiDeliveryEvent {
  type?: string;
  message_id: string;
  status: string;
  message?: string;
  sender?: string;
  receiver?: string;
  channel?: string;
}

function normalizeStatus(status: string): "delivered" | "failed" | "accepted" {
  const normalized = status.trim().toLowerCase();
  if (normalized === "delivered") return "delivered";
  if (normalized === "message sent") return "accepted";
  return "failed";
}

export class TermiiWebhookController {
  private isSignatureValid(req: Request): boolean {
    const secretKey = process.env.TERMII_SECRET_KEY;
    const signature = req.header("x-termii-signature");
    if (!secretKey || !signature) return false;

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) return false;
    const expected = createHmac("sha512", secretKey).update(rawBody).digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    const signatureBuffer = Buffer.from(signature, "hex");

    return (
      expectedBuffer.length === signatureBuffer.length &&
      timingSafeEqual(expectedBuffer, signatureBuffer)
    );
  }

  async handle(req: Request, res: Response): Promise<Response> {
    if (!this.isSignatureValid(req)) {
      return ApiResponse.unauthorized(res, "Invalid Termii signature");
    }

    const event = req.body as Partial<TermiiDeliveryEvent>;
    if (this.isSmsOptOut(event)) {
      try {
        await this.recordSmsOptOut(event.sender || "");
        return ApiResponse.success(res, "SMS opt-out recorded");
      } catch (error) {
        console.error("[TermiiWebhook] Failed to record SMS opt-out:", error);
        return ApiResponse.serverError(res, "Unable to record SMS opt-out");
      }
    }

    if (!event.message_id || !event.status) {
      return ApiResponse.badRequest(res, "Invalid Termii delivery event");
    }
    if (!supabaseAdmin) {
      return ApiResponse.serverError(res, "Supabase Admin not initialized");
    }

    try {
      const deliveryStatus = normalizeStatus(event.status);
      const now = new Date().toISOString();
      const { data: delivery, error } = await supabaseAdmin
        .from("channel_message_delivery")
        .update({
          status: deliveryStatus,
          provider_status: event.status,
          delivered_at: deliveryStatus === "delivered" ? now : null,
          error_message:
            deliveryStatus === "failed" ? `Termii status: ${event.status}` : null,
          updated_at: now,
        })
        .eq("provider_message_id", event.message_id)
        .select("message_id")
        .maybeSingle();
      if (error) throw error;

      if (!delivery) {
        return ApiResponse.success(res, "Unknown Termii message ignored");
      }

      await this.refreshMessageStats(delivery.message_id);
      return ApiResponse.success(res, "Termii delivery status recorded");
    } catch (error) {
      console.error("[TermiiWebhook] Failed to record delivery event:", error);
      return ApiResponse.serverError(
        res,
        error instanceof Error ? error.message : "Unable to record Termii event",
      );
    }
  }

  private isSmsOptOut(event: Partial<TermiiDeliveryEvent>): boolean {
    return (
      event.status?.trim().toLowerCase() === "received" &&
      event.message?.trim().toLowerCase() === "stop" &&
      !!event.sender
    );
  }

  private async recordSmsOptOut(sender: string): Promise<void> {
    if (!supabaseAdmin) throw new Error("Supabase Admin not initialized");
    const phone = normalizeInternationalPhone(sender);
    if (!phone) throw new Error("Invalid inbound sender phone number");

    const { data: delivery, error } = await supabaseAdmin
      .from("channel_message_delivery")
      .select("business_id, contact_id, message:channel_message!inner(channel)")
      .eq("phone", phone)
      .eq("message.channel", "sms")
      .not("contact_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!delivery?.contact_id) return;

    const { error: updateError } = await supabaseAdmin
      .from("contacts")
      .update({ sms_opted_out: true })
      .eq("id", delivery.contact_id)
      .eq("business_id", delivery.business_id);
    if (updateError) throw updateError;
  }

  private async refreshMessageStats(messageId: string): Promise<void> {
    if (!supabaseAdmin) throw new Error("Supabase Admin not initialized");
    const { data, error } = await supabaseAdmin
      .from("channel_message_delivery")
      .select("status, accepted_at")
      .eq("message_id", messageId);
    if (error) throw error;

    const statuses = (data ?? []) as Array<{
      status: string;
      accepted_at: string | null;
    }>;
    const acceptedCount = statuses.filter((item) => !!item.accepted_at).length;
    const deliveredCount = statuses.filter(
      (item) => item.status === "delivered",
    ).length;
    const failedCount = statuses.filter((item) => item.status === "failed").length;
    const successfulCount = statuses.filter((item) =>
      ["accepted", "delivered"].includes(item.status),
    ).length;
    const hasUnresolvedDeliveries = statuses.some((item) =>
      ["pending", "processing"].includes(item.status),
    );

    const { error: statsError } = await supabaseAdmin
      .from("channel_message")
      .update({ accepted_count: acceptedCount, delivered_count: deliveredCount, failed_count: failedCount, updated_at: new Date().toISOString() })
      .eq("id", messageId);
    if (statsError) throw statsError;

    if (!hasUnresolvedDeliveries) {
      const status =
        successfulCount === 0
          ? "failed"
          : failedCount > 0
            ? "partial"
            : "sent";
      const { error: messageError } = await supabaseAdmin
        .from("channel_message")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", messageId);
      if (messageError) throw messageError;
    }
  }
}

export default new TermiiWebhookController();
