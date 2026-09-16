import { Request, Response } from "express";
import { Receiver } from "@upstash/qstash";
import { supabaseAdmin } from "../config/supabaseAdmin";
import {
  ChannelCampaignJobPayload,
  queueChannelCampaignJob,
} from "../config/qstash";
import { getChannelProvider } from "../services/channel-provider";
import type { ChannelType } from "../types/channel.types";
import ApiResponse from "../utils/apiResponse";

interface DeliveryRecord {
  id: string;
  phone: string;
  body: string;
  credit_cost: number;
  attempt_count: number;
  status: "pending" | "processing" | "accepted" | "delivered" | "failed";
}

interface MessageRecord {
  id: string;
  business_id: string;
  channel: ChannelType;
  status: string;
  credits_reserved: number;
  send_attempt_id: string;
}

interface QStashFailureBody {
  sourceBody?: string;
}

const DELIVERY_BATCH_SIZE = 20;

export class ChannelProcessController {
  private readonly receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
  });

  private get database() {
    if (!supabaseAdmin) throw new Error("Supabase Admin not initialized");
    return supabaseAdmin;
  }

  private async verifyRequest(req: Request): Promise<boolean> {
    if (process.env.NODE_ENV !== "production") return true;
    const signature = req.header("upstash-signature");
    if (!signature) return false;

    try {
      return await this.receiver.verify({
        signature,
        body:
          (req as Request & { rawBody?: Buffer }).rawBody?.toString("utf8") ||
          JSON.stringify(req.body),
      });
    } catch (error) {
      console.error("[ChannelProcess] QStash signature verification failed:", error);
      return false;
    }
  }

  private async getMessage(payload: ChannelCampaignJobPayload): Promise<MessageRecord> {
    const { data, error } = await this.database
      .from("channel_message")
      .select(
        "id, business_id, channel, status, credits_reserved, send_attempt_id",
      )
      .eq("id", payload.messageId)
      .eq("business_id", payload.businessId)
      .single();
    if (error || !data) throw new Error(error?.message || "Channel message not found");
    if (!data.send_attempt_id) throw new Error("Channel message has no send attempt");
    return data as MessageRecord;
  }

  private async getPendingDeliveries(messageId: string): Promise<DeliveryRecord[]> {
    const { data, error } = await this.database
      .from("channel_message_delivery")
      .select("id, phone, body, credit_cost, status, attempt_count")
      .eq("message_id", messageId)
      .eq("status", "pending")
      .order("id")
      .limit(DELIVERY_BATCH_SIZE);
    if (error) throw error;
    return (data ?? []) as DeliveryRecord[];
  }

  private async processDelivery(
    channel: ChannelType,
    delivery: DeliveryRecord,
  ): Promise<void> {
    const { data: claimed, error: claimError } = await this.database
      .from("channel_message_delivery")
      .update({
        status: "processing",
        attempt_count: delivery.attempt_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return;

    try {
      const provider = getChannelProvider(channel);
      const result = await provider.send({
        to: delivery.phone,
        body: delivery.body,
      });
      const now = new Date().toISOString();
      const { error } = await this.database
        .from("channel_message_delivery")
        .update({
          status: result.accepted ? "accepted" : "failed",
          provider_message_id: result.providerMessageId ?? null,
          provider_status: result.accepted ? "Message Sent" : "Rejected",
          error_message: result.error ?? null,
          accepted_at: result.accepted ? now : null,
          updated_at: now,
        })
        .eq("id", delivery.id);
      if (error) throw error;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider request failed";
      const { error: updateError } = await this.database
        .from("channel_message_delivery")
        .update({
          status: "pending",
          provider_status: "Retry Pending",
          error_message: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", delivery.id);
      if (updateError) throw updateError;
      throw error;
    }
  }

  private async finalize(message: MessageRecord): Promise<void> {
    const { data, error } = await this.database
      .from("channel_message_delivery")
      .select("status, credit_cost")
      .eq("message_id", message.id);
    if (error) throw error;

    const deliveries = (data ?? []) as Array<{
      status: DeliveryRecord["status"];
      credit_cost: number;
    }>;
    const acceptedCount = deliveries.filter((item) =>
      ["accepted", "delivered"].includes(item.status),
    ).length;
    const deliveredCount = deliveries.filter(
      (item) => item.status === "delivered",
    ).length;
    const failedDeliveries = deliveries.filter((item) => item.status === "failed");
    const failedCredits = failedDeliveries.reduce(
      (total, item) => total + item.credit_cost,
      0,
    );
    const status =
      acceptedCount === 0 ? "failed" : failedDeliveries.length > 0 ? "partial" : "sent";
    const now = new Date().toISOString();

    if (failedCredits > 0) {
      const { error: refundError } = await this.database.rpc(
        "refund_channel_message_credits",
        {
          p_business_id: message.business_id,
          p_message_id: message.id,
          p_attempt_id: message.send_attempt_id,
          p_amount: failedCredits,
          p_reason: "provider_rejection",
        },
      );
      if (refundError) throw refundError;
    }

    const { error: messageError } = await this.database
      .from("channel_message")
      .update({ status, sent_at: now, accepted_count: acceptedCount, delivered_count: deliveredCount, failed_count: failedDeliveries.length, updated_at: now })
      .eq("id", message.id)
      .eq("business_id", message.business_id);
    if (messageError) throw messageError;
  }

  async process(req: Request, res: Response): Promise<Response> {
    if (!(await this.verifyRequest(req))) {
      return ApiResponse.unauthorized(res, "Invalid QStash signature");
    }

    try {
      const payload = req.body as ChannelCampaignJobPayload;
      if (!payload.messageId || !payload.businessId) {
        return ApiResponse.badRequest(res, "Invalid channel campaign payload");
      }

      const message = await this.getMessage(payload);
      if (["sent", "partial", "failed"].includes(message.status)) {
        return ApiResponse.success(res, "Channel campaign already finalized");
      }

      await this.database
        .from("channel_message")
        .update({ status: "processing", updated_at: new Date().toISOString() })
        .eq("id", message.id)
        .in("status", ["queued", "scheduled", "processing"]);

      await this.database
        .from("channel_message_delivery")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("message_id", message.id)
        .eq("status", "processing");

      const deliveries = await this.getPendingDeliveries(message.id);
      for (const delivery of deliveries) {
        await this.processDelivery(message.channel, delivery);
      }

      const remainingDeliveries = await this.getPendingDeliveries(message.id);
      if (remainingDeliveries.length > 0) {
        const queuedId = await queueChannelCampaignJob({ payload });
        if (!queuedId) throw new Error("Unable to queue the next delivery batch");
      } else {
        await this.finalize(message);
      }

      return ApiResponse.success(res, "Channel campaign batch processed", {
        processed: deliveries.length,
        has_more: remainingDeliveries.length > 0,
      });
    } catch (error) {
      console.error("[ChannelProcess] Batch failed:", error);
      return ApiResponse.serverError(
        res,
        error instanceof Error ? error.message : "Channel campaign batch failed",
      );
    }
  }

  async failure(req: Request, res: Response): Promise<Response> {
    if (!(await this.verifyRequest(req))) {
      return ApiResponse.unauthorized(res, "Invalid QStash signature");
    }

    const callback = req.body as QStashFailureBody;
    let payload: Partial<ChannelCampaignJobPayload> = {};
    try {
      payload = callback.sourceBody
        ? (JSON.parse(
            Buffer.from(callback.sourceBody, "base64").toString("utf8"),
          ) as ChannelCampaignJobPayload)
        : (req.body as Partial<ChannelCampaignJobPayload>);
    } catch {
      return ApiResponse.badRequest(res, "Invalid QStash failure payload");
    }
    if (!payload.messageId || !payload.businessId) {
      return ApiResponse.badRequest(res, "Invalid channel campaign failure payload");
    }

    try {
      const message = await this.getMessage({
        messageId: payload.messageId,
        businessId: payload.businessId,
      });
      const { error } = await this.database
        .from("channel_message_delivery")
        .update({
          status: "failed",
          provider_status: "Retries Exhausted",
          error_message: "Delivery failed after all queue retries",
          updated_at: new Date().toISOString(),
        })
        .eq("message_id", payload.messageId)
        .in("status", ["pending", "processing"]);
      if (error) throw error;
      await this.finalize(message);
    } catch (error) {
      return ApiResponse.serverError(
        res,
        error instanceof Error ? error.message : "Unable to record campaign failure",
      );
    }

    return ApiResponse.success(res, "Channel campaign failure recorded");
  }
}

export default new ChannelProcessController();
