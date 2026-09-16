import { Client } from "@upstash/qstash";

let qstashClient: Client | null = null;

const QUEUE_NAME = "campaign-processing";
const PAYSTACK_WEBHOOK_QUEUE_NAME = "paystack-webhooks";
const PAYSTACK_WEBHOOK_QUEUE_PARALLELISM = Math.min(
  Number(process.env.QSTASH_PAYSTACK_WEBHOOK_PARALLELISM || 2),
  2,
);

export function getQStashClient(): Client | null {
  if (!process.env.QSTASH_TOKEN) {
    console.warn("[QStash] QSTASH_TOKEN not configured");
    return null;
  }

  if (!qstashClient) {
    qstashClient = new Client({ token: process.env.QSTASH_TOKEN });
    console.log("[QStash] Client initialized");
  }

  return qstashClient;
}

export function isQStashAvailable(): boolean {
  return !!process.env.QSTASH_TOKEN;
}

// ---------------------------------------------------------------------------
// Video Processing
// ---------------------------------------------------------------------------

export interface VideoProcessingPayload {
  uploadId: string;
  fileKey: string;
  mimeType: string;
  businessId: string;
  context: string;
}

/**
 * Enqueue a video-processing job for a confirmed R2 upload.
 * Returns the QStash message ID on success, or null if QStash is unavailable.
 * Non-fatal — callers must not throw on null.
 */
export async function queueVideoProcessingJob(
  payload: VideoProcessingPayload,
): Promise<string | null> {
  const client = getQStashClient();
  if (!client) return null;

  const serverUrl = process.env.SERVER_URL || "http://localhost:8000";
  const baseUrl = serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const callbackUrl = `${baseUrl}/api/upload/process-video`;

  try {
    const queue = client.queue({ queueName: "video-processing" });
    await queue.upsert({ parallelism: 3 });

    const result = await queue.enqueueJSON({
      url: callbackUrl,
      body: payload,
      retries: 3,
    });

    console.log(
      `[QStash] Enqueued video-processing job for uploadId=${payload.uploadId} (messageId=${result.messageId})`,
    );
    return result.messageId;
  } catch (error) {
    console.error("[QStash] Failed to enqueue video-processing job:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Campaign Processing
// ---------------------------------------------------------------------------

export interface CampaignJobPayload {
  campaignId: string;
  businessId: string;
  dbJobId: string | null;
  isRetry: boolean;
  cursorId?: string | null;
}

export interface ChannelCampaignJobPayload {
  messageId: string;
  businessId: string;
}

export async function queueChannelCampaignJob(params: {
  payload: ChannelCampaignJobPayload;
  scheduledAt?: string | null;
}): Promise<string | null> {
  const client = getQStashClient();
  if (!client) return null;

  const serverUrl = process.env.SERVER_URL || "http://localhost:8000";
  const baseUrl = serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const callbackUrl = `${baseUrl}/api/channels/process`;
  const failureCallbackUrl = `${baseUrl}/api/channels/process/failure`;
  const notBefore = params.scheduledAt
    ? Math.floor(new Date(params.scheduledAt).getTime() / 1000)
    : undefined;

  try {
    const queue = client.queue({ queueName: QUEUE_NAME });
    await queue.upsert({ parallelism: 1 });
    const result = await queue.enqueueJSON({
      url: callbackUrl,
      body: params.payload,
      retries: 5,
      failureCallback: failureCallbackUrl,
      notBefore,
    });
    return result.messageId;
  } catch (error) {
    console.error("[QStash] Failed to enqueue channel campaign job:", error);
    return null;
  }
}

export async function queueCampaignJob(
  payload: CampaignJobPayload,
): Promise<boolean> {
  const client = getQStashClient();
  if (!client) return false;

  const serverUrl = process.env.SERVER_URL || "http://localhost:8000";

  const baseUrl = serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const callbackUrl = `${baseUrl}/api/crm/campaigns/process`;
  const failureCallbackUrl = `${baseUrl}/api/crm/campaigns/process/failure`;

  try {
    const queue = client.queue({ queueName: QUEUE_NAME });

    // Ensure queue exists with parallelism=1 so batches run one at a time.
    // upsert is idempotent — safe to call on every enqueue.
    await queue.upsert({ parallelism: 1 });

    await queue.enqueueJSON({
      url: callbackUrl,
      body: payload,
      retries: 5,
      failureCallback: failureCallbackUrl,
    });

    console.log(
      `[QStash] Enqueued to '${QUEUE_NAME}' for campaign ${payload.campaignId}` +
        (payload.cursorId
          ? ` (cursor: ${payload.cursorId})`
          : " (first batch)"),
    );
    return true;
  } catch (error) {
    console.error("[QStash] Failed to enqueue campaign job:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Paystack Webhook Processing
// ---------------------------------------------------------------------------

export interface PaystackWebhookJobPayload {
  event: string;
  data: unknown;
  receivedAt: string;
}

/**
 * Enqueue verified Paystack webhook work after the public webhook endpoint has
 * already validated the Paystack signature. Returns the QStash message ID, or
 * null so callers can fall back without losing the event.
 */
export async function queuePaystackWebhookJob(
  payload: PaystackWebhookJobPayload,
): Promise<string | null> {
  const client = getQStashClient();
  if (!client) return null;

  const serverUrl = process.env.SERVER_URL || "http://localhost:8000";
  const baseUrl = serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const callbackUrl = `${baseUrl}/api/webhook/paystack/process`;

  try {
    const queue = client.queue({ queueName: PAYSTACK_WEBHOOK_QUEUE_NAME });

    await queue.upsert({ parallelism: PAYSTACK_WEBHOOK_QUEUE_PARALLELISM });

    const result = await queue.enqueueJSON({
      url: callbackUrl,
      body: payload,
      retries: 5,
    });

    console.log(
      `[QStash] Enqueued Paystack webhook ${payload.event}` +
        ((payload.data as any)?.reference
          ? ` reference=${(payload.data as any).reference}`
          : "") +
        ` (messageId=${result.messageId})`,
    );
    return result.messageId;
  } catch (error) {
    console.error("[QStash] Failed to enqueue Paystack webhook job:", error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Certificate auto-release (delayed, one-off delivery)
// ---------------------------------------------------------------------------

export interface CertificateReleasePayload {
  eventId: string;
}

/**
 * Schedule an event's certificates to auto-release at `releaseAt` by publishing
 * a delayed message to the worker endpoint. Returns the QStash messageId (so it
 * can be cancelled if the schedule changes) or null if unavailable.
 */
export async function queueCertificateRelease(
  payload: CertificateReleasePayload,
  releaseAt: Date,
): Promise<string | null> {
  const client = getQStashClient();
  if (!client) return null;

  const serverUrl = process.env.SERVER_URL || "http://localhost:8000";
  const baseUrl = serverUrl.replace(/\/+$/, "").replace(/\/api$/, "");
  const callbackUrl = `${baseUrl}/api/event-certificates/process-release`;

  // notBefore is an absolute unix timestamp (seconds). Refuse to schedule a
  // release in the past — otherwise QStash would fire it almost immediately
  // (e.g. saving config for an already-ended event would "release on save").
  const notBefore = Math.floor(releaseAt.getTime() / 1000);
  if (notBefore <= Math.floor(Date.now() / 1000)) {
    console.warn(
      `[QStash] Skipping certificate auto-release for event ${payload.eventId} — releaseAt ${releaseAt.toISOString()} is in the past.`,
    );
    return null;
  }

  try {
    const res = await client.publishJSON({
      url: callbackUrl,
      body: payload,
      notBefore,
      retries: 3,
    });
    console.log(
      `[QStash] Scheduled certificate auto-release for event ${payload.eventId} at ${new Date(
        notBefore * 1000,
      ).toISOString()} (messageId=${(res as any).messageId})`,
    );
    return (res as any).messageId ?? null;
  } catch (error) {
    console.error("[QStash] Failed to schedule certificate release:", error);
    return null;
  }
}

/** Cancel a previously scheduled auto-release message. */
export async function cancelCertificateRelease(
  messageId: string,
): Promise<void> {
  const client = getQStashClient();
  if (!client || !messageId) return;
  try {
    await client.messages.delete(messageId);
  } catch (error) {
    console.error("[QStash] Failed to cancel certificate release:", error);
  }
}
