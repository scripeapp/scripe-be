/**
 * The scheduling-module tool: turns a merchant request ("add a booking
 * type for consultations") into a pending action.
 *
 * Same two-phase contract as create_event, with the mechanics shared in
 * action-tool.utils. The slug is derived from the title by the executor,
 * never invented by the model.
 */
import { z } from "zod";
import { AITool } from "../ai-provider.types";
import { AgentQuestion } from "../../../types/ai-agent.types";
import { ActionToolContext, presentQuestions, presentPendingAction } from "./action-tool.utils";

export const LOCATION_TYPES = [
  "google_meet",
  "in_person",
  "phone",
  "custom",
] as const;

export const createEventTypePayloadSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    duration_minutes: z.number().int().min(5).max(480),
    location_type: z.enum(LOCATION_TYPES),
    location_details: z.string().max(300).optional(),
    color: z.string().max(20).optional(),
    requires_payment: z.boolean().optional(),
    payment_amount: z.number().positive().optional(),
    payment_label: z.string().max(80).optional(),
  })
  .strict();

export type CreateEventTypePayload = z.infer<
  typeof createEventTypePayloadSchema
>;

const LOCATION_LABELS: Record<(typeof LOCATION_TYPES)[number], string> = {
  google_meet: "Online (Google Meet)",
  in_person: "In person",
  phone: "Phone call",
  custom: "Custom link or location",
};

/** The questions the detail card should ask, one per missing field. */
function missingQuestions(
  payload: CreateEventTypePayload,
): AgentQuestion[] {
  const questions: AgentQuestion[] = [];

  const pushText = (
    key: keyof CreateEventTypePayload,
    question: string,
    required: boolean,
  ) => {
    if (payload[key] === undefined) {
      questions.push({ key, question, type: "text", required });
    }
  };

  pushText(
    "title",
    "What should this booking type be called?",
    true,
  );
  pushText(
    "duration_minutes",
    "How long is one session? (minutes, e.g. 30 or 60)",
    true,
  );
  pushText(
    "description",
    "Add a short description your customers will see (optional)",
    false,
  );
  pushText(
    "location_details",
    "Where or how will sessions happen? (link or address — optional)",
    false,
  );

  if (!payload.location_type) {
    questions.push({
      key: "location_type",
      question: "How will sessions happen?",
      type: "radio",
      options: LOCATION_TYPES.map((type) => LOCATION_LABELS[type]),
      required: true,
    });
  }

  return questions;
}

function buildSummaryBody(payload: CreateEventTypePayload): string {
  const parts: string[] = [];
  parts.push(`${payload.duration_minutes}-minute session.`);
  parts.push(LOCATION_LABELS[payload.location_type] || payload.location_type);
  if (payload.requires_payment && payload.payment_amount) {
    parts.push(`Paid: ₦${payload.payment_amount}`);
  } else {
    parts.push("Free.");
  }
  if (payload.description) {
    parts.push(
      payload.description.length > 100
        ? `${payload.description.slice(0, 100)}…`
        : payload.description,
    );
  }
  return parts.join(" ");
}

export function buildCreateEventTypeTool(
  ctx: ActionToolContext,
): AITool<CreateEventTypePayload> {
  return {
    name: "create_event_type",
    description:
      "Create a schedulable booking type for the merchant's business (consultations, classes, sessions). Call this when the merchant asks to add/set up a booking type, schedule availability, or let customers book time with them. If the title, duration, or session format are missing, the tool asks via a detail card — you will get the answers on the next turn, then call this tool again with the complete details.",
    parameters: createEventTypePayloadSchema,
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
        type: "scheduling.event_type.create",
        payload: payload as Record<string, unknown>,
        summary: {
          title: `Create booking type: ${payload.title}`,
          body: buildSummaryBody(payload),
          label: "Ready to create",
          cta: "Create booking type",
          signal: 3,
        },
      });
    },
  };
}
