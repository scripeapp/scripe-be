/**
 * The product-update tool: turns a merchant request ("drop the hoodie to
 * 4500", "restock the mugs") into a pending action.
 *
 * Same two-phase contract as create_event. `name` names the EXISTING
 * product in the business's first store (identity); `new_name` renames
 * it. Every other field maps to a real `products` column, and the schema
 * is strict so a hallucinated field is rejected before it can reach the
 * database.
 */
import { z } from "zod";
import { AITool } from "../ai-provider.types";
import { AgentQuestion } from "../../../types/ai-agent.types";
import { ActionToolContext, presentQuestions, presentPendingAction } from "./action-tool.utils";

export const updateProductPayloadSchema = z
  .object({
    name: z.string().min(1).max(120),
    new_name: z.string().min(1).max(120).optional(),
    price: z.number().positive().optional(),
    currency: z.string().length(3).optional(),
    stock: z.number().int().min(0).max(1_000_000).optional(),
    description: z.string().max(2000).optional(),
    status: z.enum(["published", "draft"]).optional(),
  })
  .strict();

export type UpdateProductPayload = z.infer<typeof updateProductPayloadSchema>;

const UPDATE_FIELDS: ReadonlyArray<keyof UpdateProductPayload> = [
  "new_name",
  "price",
  "currency",
  "stock",
  "description",
  "status",
];

/** The questions the detail card should ask, one per missing field. */
function missingQuestions(payload: UpdateProductPayload): AgentQuestion[] {
  const questions: AgentQuestion[] = [];

  if (!payload.name) {
    questions.push({
      key: "name",
      question: "Which product would you like to change?",
      type: "text",
      required: true,
    });
    return questions;
  }

  if (!UPDATE_FIELDS.some((field) => payload[field] !== undefined)) {
    questions.push({
      key: "changes",
      question:
        "What would you like to change? For example the price, stock, or description.",
      type: "text",
      required: true,
    });
  }

  return questions;
}

function buildSummaryBody(payload: UpdateProductPayload): string {
  const changes: string[] = [];
  if (payload.new_name) changes.push(`renamed to "${payload.new_name}"`);
  if (payload.price !== undefined) {
    changes.push(`price → ${payload.currency || "NGN"} ${payload.price}`);
  }
  if (payload.stock !== undefined) changes.push(`stock → ${payload.stock}`);
  if (payload.status) changes.push(`status → ${payload.status}`);
  if (payload.description) changes.push("description updated");
  if (changes.length === 0) changes.push("no visible change");
  return changes.join("; ");
}

export function buildUpdateProductTool(
  ctx: ActionToolContext,
): AITool<UpdateProductPayload> {
  return {
    name: "update_product",
    description:
      "Update an existing product (change its name, price, currency, stock, description, or publish status). Call this when the merchant asks to change, edit, reprice, restock, rename, publish, or unpublish a product. Provide the current name plus the fields to change. If details are missing, the tool asks via a detail card — you will get the answers on the next turn, then call this tool again.",
    parameters: updateProductPayloadSchema,
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
        type: "product.update",
        payload: payload as Record<string, unknown>,
        summary: {
          title: `Update product: ${payload.name}`,
          body: buildSummaryBody(payload),
          label: "Ready to update",
          cta: "Update product",
          signal: 2,
        },
      });
    },
  };
}