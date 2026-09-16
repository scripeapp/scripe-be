/**
 * The product-creation tool: turns a merchant request ("add a product
 * that costs X") into a pending action.
 *
 * Same two-phase contract as create_event, with the mechanics shared in
 * action-tool.utils. Products are created as drafts with minimal fields
 * (no image, no variants) — the merchant publishes and enriches them in
 * the store admin afterward.
 */
import { z } from "zod";
import { AITool } from "../ai-provider.types";
import { AgentQuestion } from "../../../types/ai-agent.types";
import { ActionToolContext, presentQuestions, presentPendingAction } from "./action-tool.utils";

export const createProductPayloadSchema = z
  .object({
    name: z.string().min(1).max(120),
    price: z.number().positive(),
    currency: z.string().length(3).optional(),
    stock: z.number().int().min(0).max(1_000_000).optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();

export type CreateProductPayload = z.infer<typeof createProductPayloadSchema>;

/** The questions the detail card should ask, one per missing field. */
function missingQuestions(payload: CreateProductPayload): AgentQuestion[] {
  const questions: AgentQuestion[] = [];

  const pushText = (
    key: keyof CreateProductPayload,
    question: string,
    required: boolean,
  ) => {
    if (payload[key] === undefined) {
      questions.push({ key, question, type: "text", required });
    }
  };

  pushText("name", "What is the product called?", true);
  pushText("price", "What is the price? (e.g. 5000)", true);
  pushText(
    "stock",
    "How many units are in stock? (optional — leave blank if unlimited)",
    false,
  );
  pushText(
    "description",
    "Add a short description customers will see (optional)",
    false,
  );

  return questions;
}

function buildSummaryBody(payload: CreateProductPayload): string {
  const parts: string[] = [];
  parts.push(`Price: ${payload.currency || "NGN"} ${payload.price}`);
  if (payload.stock !== undefined) {
    parts.push(`Stock: ${payload.stock} units.`);
  } else {
    parts.push("Unlimited stock.");
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

export function buildCreateProductTool(
  ctx: ActionToolContext,
): AITool<CreateProductPayload> {
  return {
    name: "create_product",
    description:
      "Add a product to the merchant's store as a draft (name and price; optional stock and description; no image or variants yet). Call this when the merchant asks to add/create a new product. If the name or price are missing, the tool asks via a detail card — you will get the answers on the next turn, then call this tool again with the complete details.",
    parameters: createProductPayloadSchema,
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
        type: "product.create",
        payload: payload as Record<string, unknown>,
        summary: {
          title: `Add product: ${payload.name}`,
          body: buildSummaryBody(payload),
          label: "Ready to create",
          cta: "Add product",
          signal: 3,
        },
      });
    },
  };
}