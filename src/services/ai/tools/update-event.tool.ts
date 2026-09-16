/**
 * The event-update tool: turns a merchant request ("move my Friday event
 * to next week", "rename event X to Y") into a pending action.
 *
 * Same two-phase contract as create_event. The `event_name` field names
 * the EXISTING event (identity — the executor resolves it within the
 * business); `new_name` renames it. Every other field maps to a real
 * `events` column, and the schema is strict so a hallucinated field is
 * rejected before it can reach the database.
 */
import { z } from "zod";
import { AITool } from "../ai-provider.types";
import { AgentQuestion } from "../../../types/ai-agent.types";
import { ActionToolContext, presentQuestions, presentPendingAction } from "./action-tool.utils";

export const updateEventPayloadSchema = z
  .object({
    event_name: z.string().min(1).max(120),
    new_name: z.string().min(1).max(120).optional(),
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
      .strict()
      .optional(),
    is_online: z.boolean().optional(),
    is_physical: z.boolean().optional(),
    event_url: z.string().url().optional(),
    status: z.enum(["draft", "published", "cancelled"]).optional(),
    language: z.string().max(60).optional(),
    platform_name: z.string().max(120).optional(),
    platform_url: z.string().max(300).optional(),
  })
  .strict();

export type UpdateEventPayload = z.infer<typeof updateEventPayloadSchema>;

const UPDATE_FIELDS: ReadonlyArray<keyof UpdateEventPayload> = [
  "new_name",
  "event_description",
  "start_date",
  "start_time",
  "end_date",
  "end_time",
  "venue",
  "is_online",
  "is_physical",
  "event_url",
  "status",
  "language",
  "platform_name",
  "platform_url",
];

/** The questions the detail card should ask, one per missing field. */
function missingQuestions(payload: UpdateEventPayload): AgentQuestion[] {
  const questions: AgentQuestion[] = [];

  if (!payload.event_name) {
    questions.push({
      key: "event_name",
      question: "Which event would you like to change?",
      type: "text",
      required: true,
    });
    return questions;
  }

  if (!UPDATE_FIELDS.some((field) => payload[field] !== undefined)) {
    questions.push({
      key: "changes",
      question:
        "What would you like to change? For example the date, time, venue, or description.",
      type: "text",
      required: true,
    });
  }

  return questions;
}

function buildSummaryBody(payload: UpdateEventPayload): string {
  const changes: string[] = [];
  if (payload.new_name) changes.push(`renamed to "${payload.new_name}"`);
  if (payload.start_date || payload.start_time) {
    const when = `${payload.start_date ?? ""}${payload.start_time ? ` at ${payload.start_time}` : ""}`.trim();
    changes.push(`new start ${when}`);
  }
  if (payload.venue?.placeDesc) changes.push(`venue: ${payload.venue.placeDesc}`);
  if (payload.is_online === true) changes.push("now online");
  if (payload.is_physical === true) changes.push("now physical");
  if (payload.event_url) changes.push("new event link");
  if (payload.status) changes.push(`status → ${payload.status}`);
  if (payload.event_description) changes.push("description updated");
  if (changes.length === 0) changes.push("no visible change");
  return changes.join("; ");
}

export function buildUpdateEventTool(
  ctx: ActionToolContext,
): AITool<UpdateEventPayload> {
  return {
    name: "update_event",
    description:
      "Update an existing event (change its name, date, time, venue, link, status, or description). Call this when the merchant asks to change, edit, reschedule, rename, or cancel an event. Provide the event's current name as event_name plus the fields to change. If details are missing, the tool asks via a detail card — you will get the answers on the next turn, then call this tool again.",
    parameters: updateEventPayloadSchema,
    execute: async (input) => {
      const payload = { ...input };
      const missing = missingQuestions(payload);

      if (missing.length > 0) {
        return presentQuestions(
          ctx,
          missing,
          payload as Record<string, unknown>,
        );
      }

      return presentPendingAction(ctx, {
        type: "event.update",
        payload: payload as Record<string, unknown>,
        summary: {
          title: `Update event: ${payload.event_name}`,
          body: buildSummaryBody(payload),
          label: "Ready to update",
          cta: "Update event",
          signal: 2,
        },
      });
    },
  };
}