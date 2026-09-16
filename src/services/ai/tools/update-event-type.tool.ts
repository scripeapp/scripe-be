/**
 * The booking-type update tool: turns a merchant request ("make sessions
 * 45 minutes", "rename my consultation type") into a pending action.
 *
 * Same two-phase contract as create_event. `title` names the EXISTING
 * booking type (identity); `new_title` renames it. Every other field maps
 * to a real `event_types` column, and the schema is strict so a
 * hallucinated field is rejected before it can reach the database.
 */
import { z } from "zod";
import { AITool } from "../ai-provider.types";
import { AgentQuestion } from "../../../types/ai-agent.types";
import { LOCATION_TYPES } from "./create-event-type.tool";
import { ActionToolContext, presentQuestions, presentPendingAction } from "./action-tool.utils";

export const updateEventTypePayloadSchema = z
  .object({
    title: z.string().min(1).max(120),
    new_title: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    duration_minutes: z.number().int().min(5).max(480).optional(),
    location_type: z.enum(LOCATION_TYPES).optional(),
    location_details: z.string().max(300).optional(),
    color: z.string().max(20).optional(),
    requires_confirmation: z.boolean().optional(),
    is_active: z.boolean().optional(),
    requires_payment: z.boolean().optional(),
    payment_amount: z.number().positive().optional(),
    payment_label: z.string().max(80).optional(),
    min_notice_minutes: z.number().int().min(0).optional(),
    max_advance_days: z.number().int().min(1).optional(),
    buffer_before_minutes: z.number().int().min(0).optional(),
    buffer_after_minutes: z.number().int().min(0).optional(),
  })
  .strict();

export type UpdateEventTypePayload = z.infer<typeof updateEventTypePayloadSchema>;

const UPDATE_FIELDS: ReadonlyArray<keyof UpdateEventTypePayload> = [
  "new_title",
  "description",
  "duration_minutes",
  "location_type",
  "location_details",
  "color",
  "requires_confirmation",
  "is_active",
  "requires_payment",
  "payment_amount",
  "payment_label",
  "min_notice_minutes",
  "max_advance_days",
  "buffer_before_minutes",
  "buffer_after_minutes",
];

/** The questions the detail card should ask, one per missing field. */
function missingQuestions(payload: UpdateEventTypePayload): AgentQuestion[] {
  const questions: AgentQuestion[] = [];

  if (!payload.title) {
    questions.push({
      key: "title",
      question: "Which booking type would you like to change?",
      type: "text",
      required: true,
    });
    return questions;
  }

  if (!UPDATE_FIELDS.some((field) => payload[field] !== undefined)) {
    questions.push({
      key: "changes",
      question:
        "What would you like to change? For example the duration, session format, or price.",
      type: "text",
      required: true,
    });
  }

  return questions;
}

function buildSummaryBody(payload: UpdateEventTypePayload): string {
  const changes: string[] = [];
  if (payload.new_title) changes.push(`renamed to "${payload.new_title}"`);
  if (payload.duration_minutes) changes.push(`${payload.duration_minutes}-minute sessions`);
  if (payload.location_type) changes.push(`format → ${payload.location_type}`);
  if (payload.requires_payment !== undefined) {
    changes.push(payload.requires_payment ? "now paid" : "now free");
  }
  if (payload.is_active !== undefined) {
    changes.push(payload.is_active ? "active" : "paused");
  }
  if (changes.length === 0) changes.push("no visible change");
  return changes.join("; ");
}

export function buildUpdateEventTypeTool(
  ctx: ActionToolContext,
): AITool<UpdateEventTypePayload> {
  return {
    name: "update_event_type",
    description:
      "Update an existing booking type (change its name, duration, session format, price, or availability). Call this when the merchant asks to change, edit, rename, or pause a booking type. Provide the current title plus the fields to change. If details are missing, the tool asks via a detail card — you will get the answers on the next turn, then call this tool again.",
    parameters: updateEventTypePayloadSchema,
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
        type: "scheduling.event_type.update",
        payload: payload as Record<string, unknown>,
        summary: {
          title: `Update booking type: ${payload.title}`,
          body: buildSummaryBody(payload),
          label: "Ready to update",
          cta: "Update booking type",
          signal: 2,
        },
      });
    },
  };
}