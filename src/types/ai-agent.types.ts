/**
 * Types + validation schemas for the dashboard AI agent
 * (Command Center panel: business Q&A + doc-to-store provisioning).
 */
import { z } from "zod";

export const agentChatSchema = z.object({
  message: z
    .string()
    .min(1, "Message is required")
    .max(4000, "Message too long (max 4000 characters)"),
  business_id: z.string().uuid("Invalid business ID"),
  // Client-chosen conversation thread. Only partitions within the
  // caller's own business+user namespace, so it needs no ownership check.
  thread_id: z.string().uuid("Invalid thread ID").optional(),
  // Page the merchant is looking at (path + search), so the agent can
  // anchor "here"-relative questions. Client-supplied and non-sensitive.
  current_page: z.string().max(300).optional(),
});

export type AgentChatInput = z.infer<typeof agentChatSchema>;

export const submitAnswersSchema = z.object({
  question_set_id: z.string().min(1, "Question set ID is required"),
  answers: z
    .array(
      z.object({
        key: z.string().min(1),
        values: z.array(z.string()).max(20),
      }),
    )
    .max(20),
  business_id: z.string().uuid("Invalid business ID"),
  // Client-chosen conversation thread, same partitioning rule as chat.
  thread_id: z.string().uuid("Invalid thread ID").optional(),
  current_page: z.string().max(300).optional(),
});

export type SubmitAnswersInput = z.infer<typeof submitAnswersSchema>;

/** Server-derived conversation key. The business/user segments come from
 *  auth (never the client); threadId only partitions within that
 *  namespace, so a client-chosen value is safe once format-validated. */
export function agentSessionKey(
  businessId: string,
  userId: string,
  threadId?: string,
): string {
  const base = `agent:${businessId}:${userId}`;
  return threadId ? `${base}:${threadId}` : base;
}

/** Loose format guard for thread ids arriving outside zod-validated
 *  bodies (multipart fields, query params) — keeps Redis keys clean. */
export function sanitizeThreadId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return /^[0-9a-f-]{8,64}$/i.test(raw) ? raw : undefined;
}

/** Redis key for the session's uploaded-document text. */
export function agentDocKey(sessionKey: string): string {
  return `ai:doc:${sessionKey}`;
}

/** Redis key for an extraction draft. */
export function agentDraftKey(draftId: string): string {
  return `ai:draft:${draftId}`;
}

/** Redis key pointing a session at its latest draft. */
export function agentSessionDraftKey(sessionKey: string): string {
  return `ai:session-draft:${sessionKey}`;
}

/** Redis key for a detail-collection question set. */
export function agentQuestionSetKey(questionSetId: string): string {
  return `ai:questions:${questionSetId}`;
}

/** Redis key for a pending (awaiting approval) action. */
export function agentActionKey(actionId: string): string {
  return `ai:action:${actionId}`;
}

/** Redis key pointing a session at its latest pending action. */
export function agentSessionActionKey(sessionKey: string): string {
  return `ai:session-action:${sessionKey}`;
}

/** Redis key for an interrupted turn's checkpointed message buffer. */
export function agentInflightKey(sessionKey: string): string {
  return `ai:session-inflight:${sessionKey}`;
}

/** SSE event names emitted by the agent chat endpoint. */
export type AgentEventName =
  | "tool_status"
  | "message"
  | "preview"
  | "questions"
  | "action"
  | "done"
  | "error";

export type AgentQuestionType = "radio" | "check" | "text";

export interface AgentQuestion {
  /** Maps to a field of the action the tool is preparing (e.g. start_date). */
  key: string;
  question: string;
  type: AgentQuestionType;
  options?: string[];
  required?: boolean;
}

export interface AgentQuestionSet {
  questionSetId: string;
  sessionKey: string;
  questions: AgentQuestion[];
  /** The partial action payload the model already collected, so answers
   *  can be merged back into it on the continuation turn. */
  partialPayload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentQuestionAnswer {
  key: string;
  values: string[];
}

export type PendingActionStatus =
  | "pending"
  | "executing"
  | "executed"
  | "failed"
  | "rejected";

export interface PendingAction {
  actionId: string;
  /** Registry key consumed by action-executor.service (e.g. "event.create"). */
  type: string;
  businessId: string;
  userId: string;
  payload: Record<string, unknown>;
  summary: {
    title: string;
    body: string;
    label: string;
    cta: string;
    signal: number;
  };
  status: PendingActionStatus;
  result?: unknown;
  error?: string;
  createdAt: string;
}

export type AgentEmit = (event: AgentEventName, data: unknown) => void;

/** Extraction draft lifecycle (stored in Redis at ai:draft:<draftId>). */
export type DraftStatus =
  | "pending"
  | "provisioning"
  | "provisioned"
  | "failed"
  | "rejected";

export interface StoreDraft {
  draftId: string;
  businessId: string;
  userId: string;
  status: DraftStatus;
  json: unknown;
  summary: StoreDraftSummary;
  provisionResult?: { storeId: string; counts: Record<string, number> };
  error?: string;
  createdAt: string;
}

export interface StoreDraftSummary {
  storeName: string;
  sellsInPerson: boolean;
  branchCount: number;
  menuCount: number;
  categoryCount: number;
  itemCount: number;
  sampleItems: string[];
  gaps: string[];
}

// ============================================================================
// Kitchen JSON — the structured shape the extraction agent emits and the
// provisioning service consumes. Same data model the import-*-json.ts
// scripts use (see docs/food-store-onboarding-prd.md).
// ============================================================================

const kitchenModifierOptionSchema = z.object({
  name: z.string().min(1),
  price_delta: z.number(),
});

const kitchenModifierGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  selection_type: z.enum(["single", "multiple"]),
  min_selections: z.number().int().min(0).default(0),
  max_selections: z.number().int().min(1).nullable().default(null),
  note: z.string().optional(),
  options: z.array(kitchenModifierOptionSchema).default([]),
});

const kitchenAddOnSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.number().min(0),
});

const kitchenItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  price: z.number().min(0),
  price_note: z.string().optional(),
  unit: z.string().optional(),
  availability_note: z.string().optional(),
  eaten_by_hand: z.boolean().optional(),
  lead_time_hours: z.number().optional(),
  calories: z.number().optional(),
  allergens: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  modifier_groups: z.array(z.string()).default([]),
});

const kitchenCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  items: z.array(kitchenItemSchema).default([]),
});

const kitchenDeliveryZoneSchema = z.object({
  area: z.string().min(1),
  fee_ngn: z.number().min(0),
  min_order_ngn: z.number().optional(),
  est_minutes_off_peak: z.number().optional(),
});

export const kitchenJsonSchema = z.object({
  restaurant: z.object({
    name: z.string().min(1),
    description: z.string().default(""),
    address: z.object({
      line1: z.string().default(""),
      city: z.string().default(""),
      state: z.string().default(""),
      zip: z.string().optional(),
      country: z.string().optional(),
    }),
    phone: z.string().optional(),
    hours: z.record(z.string(), z.string()).optional(),
    service_types: z.array(z.string()).optional(),
    vat_rate: z.number().optional(),
    tax_rate: z.number().optional(),
    delivery: z
      .object({ zones: z.array(kitchenDeliveryZoneSchema).optional() })
      .optional(),
  }),
  modifier_groups: z.array(kitchenModifierGroupSchema).default([]),
  add_ons: z.array(kitchenAddOnSchema).default([]),
  menu: z.object({
    categories: z.array(kitchenCategorySchema).default([]),
  }),
});

export type KitchenJson = z.infer<typeof kitchenJsonSchema>;
