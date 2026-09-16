/**
 * The event-creation tool: turns a merchant request ("create an event
 * called X about Y") into a fully-specified pending action.
 *
 * Two-phase by design: missing details → detail card (`questions`) →
 * merchant answers → tool re-invoked with a complete payload → approval
 * card (`action`). Only the separate approve endpoint executes the
 * action — the agent itself never writes. The shared mechanics live in
 * action-tool.utils.
 */
import { z } from "zod";
import { AITool } from "../ai-provider.types";
import { AgentQuestion } from "../../../types/ai-agent.types";
import { ActionToolContext, presentQuestions, presentPendingAction } from "./action-tool.utils";

/** Tickets carry the event_tickets table's NOT-NULL columns with sensible
 *  defaults: an agent-created ticket always has a quantity limit (so it is
 *  limited stock) and nothing sold yet. */
const TICKET_SCHEMA = z
  .object({
    ticket_name: z.string().min(1).max(120),
    ticket_price: z.number().min(0),
    available_quantity: z.number().int().min(1).max(100_000),
    ticket_is_limited_stock: z.boolean().default(true),
    quantity_sold: z.number().int().min(0).default(0),
  })
  .strict();

export const createEventPayloadSchema = z.object({
  event_name: z.string().min(1).max(120),
  event_description: z.string().max(2000).optional(),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
  start_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM")
    .optional(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
  end_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM")
    .optional(),
  venue: z
    .object({
      placeDesc: z.string().max(200),
      placeId: z.string().max(200).optional(),
      full_address: z.string().max(300).optional(),
    })
    .optional(),
  is_online: z.boolean().optional(),
  is_physical: z.boolean().optional(),
  event_url: z.string().url().optional(),
  language: z.string().max(60).optional(),
  platform_name: z.string().max(120).optional(),
  platform_url: z.string().max(300).optional(),
  tickets: z.array(TICKET_SCHEMA).max(10).optional(),
}).strict();

export type CreateEventPayload = z.infer<typeof createEventPayloadSchema>;

function hasLocation(payload: CreateEventPayload): boolean {
  return Boolean(payload.venue?.placeDesc) || payload.is_online === true;
}

/** The questions the detail card should ask, one per missing field. */
function missingQuestions(
  payload: CreateEventPayload,
): AgentQuestion[] {
  const questions: AgentQuestion[] = [];

  const pushText = (key: keyof CreateEventPayload, question: string, required: boolean) => {
    if (payload[key] === undefined) {
      questions.push({ key, question, type: "text", required });
    }
  };

  pushText("start_date", "What date should it start? (YYYY-MM-DD)", true);
  pushText("start_time", "What time does it start? (24h HH:MM)", true);
  pushText("end_date", "What date does it end? Leave blank if it's a single-day event.", false);
  pushText("end_time", "What time does it end? (24h HH:MM)", false);

  if (!hasLocation(payload)) {
    questions.push({
      key: "location",
      question: "Where will the event be held?",
      type: "radio",
      options: ["Online event", "Physical venue"],
      required: true,
    });
  }

  if (
    payload.is_physical === true &&
    !payload.venue?.placeDesc
  ) {
    questions.push({
      key: "venue",
      question: "What is the venue? (Name, plus address or link)",
      type: "text",
      required: true,
    });
  }

  return questions;
}

/** Mirrors the app's event payload: always-present venue object, language
 *  and platform fields, trimmed text — so the insert matches what the
 *  create-event form sends. */
function formatPayloadForEvent(payload: CreateEventPayload) {
  return {
    ...payload,
    event_name: payload.event_name.trim(),
    event_description: payload.event_description?.trim() || undefined,
    venue: payload.venue
      ? {
          placeDesc: payload.venue.placeDesc.trim(),
          placeId: payload.venue.placeId?.trim() || undefined,
          full_address: payload.venue.full_address?.trim() || undefined,
        }
      : { placeDesc: "", placeId: "", full_address: "" },
    language: payload.language || "English",
    platform_name: payload.platform_name || "",
    platform_url: payload.platform_url || "",
  };
}

export function buildCreateEventTool(
  ctx: ActionToolContext,
): AITool<CreateEventPayload> {
  return {
    name: "create_event",
    description:
      "Create an event for the merchant's business (ticketed or free). Call this when the merchant asks to create/launch/add an event. If start date/time or venue are missing, the tool asks the merchant via a detail card — you will get their answers on the next turn, then call this tool again with the complete details.",
    parameters: createEventPayloadSchema,
    execute: async (input) => {
      const payload = formatPayloadForEvent(input);
      const missing = missingQuestions(payload);

      if (missing.length > 0) {
        return presentQuestions(
          ctx,
          missing,
          payload as Record<string, unknown>,
        );
      }

      return presentPendingAction(ctx, {
        type: "event.create",
        payload: payload as Record<string, unknown>,
        summary: {
          title: `Create event: ${payload.event_name}`,
          body: buildSummaryBody(payload),
          label: "Ready to create",
          cta: "Create event",
          signal: 3,
        },
      });
    },
  };
}

function buildSummaryBody(payload: CreateEventPayload): string {
  const parts: string[] = [];
  if (payload.start_date) {
    const when = `${payload.start_date}${payload.start_time ? ` at ${payload.start_time}` : ""}`;
    const end =
      payload.end_date || payload.end_time
        ? ` until ${payload.end_date ?? payload.start_date}${payload.end_time ? ` at ${payload.end_time}` : ""}`
        : "";
    parts.push(`Starts ${when}${end}.`);
  }
  if (payload.venue?.placeDesc) {
    parts.push(`Venue: ${payload.venue.placeDesc}.`);
  } else if (payload.is_online) {
    parts.push("Online event.");
  }
  const ticketCount = payload.tickets?.length ?? 0;
  if (ticketCount > 0) {
    parts.push(
      `${ticketCount} ticket type${ticketCount !== 1 ? "s" : ""} (from ₦${Math.min(
        ...payload.tickets!.map((t) => t.ticket_price),
      )}).`,
    );
  } else {
    parts.push("No tickets — free entry.");
  }
  if (payload.event_description) {
    parts.push(payload.event_description.length > 100 ? `${payload.event_description.slice(0, 100)}…` : payload.event_description);
  }
  return parts.join(" ");
}