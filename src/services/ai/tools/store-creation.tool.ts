/**
 * The extraction tool: turns the session's uploaded document into a
 * validated kitchen-JSON draft and emits a preview card. Deliberately
 * does NOT provision anything — approval happens on a separate endpoint
 * guarded by store-creation permission (see ai-agent.routes.ts).
 */
import { randomUUID } from "crypto";
import { z } from "zod";
import { AITool } from "../ai-provider.types";
import { resolveAgentProvider } from "../agent-settings.service";
import {
  AgentEmit,
  KitchenJson,
  StoreDraft,
  StoreDraftSummary,
  kitchenJsonSchema,
} from "../../../types/ai-agent.types";
import { getDocument, saveDraft, pointSessionAtDraft } from "../draft.store";

interface ExtractionToolContext {
  sessionKey: string;
  businessId: string;
  userId: string;
  emit: AgentEmit;
}

const EXTRACTION_SYSTEM = `You convert restaurant/food-business documents into a strict JSON structure. Output ONLY a JSON object — no markdown fences, no commentary.

The JSON must match this shape:
{
  "restaurant": {
    "name": string, "description": string,
    "address": { "line1": string, "city": string, "state": string },
    "phone"?: string,
    "hours"?: { "mon_thu"?: "HH:MM - HH:MM", "fri_sat"?: "...", "sun"?: "...", or per-day keys "monday".."sunday" },
    "service_types"?: ["dine_in" | "pickup" | "delivery" | "curbside"],
    "vat_rate"?: number (fraction, e.g. 0.075 for 7.5%),
    "delivery"?: { "zones": [{ "area": string, "fee_ngn": number, "min_order_ngn"?: number }] }
  },
  "modifier_groups": [{ "id": string, "name": string, "selection_type": "single"|"multiple", "min_selections": number, "max_selections": number|null, "options": [{ "name": string, "price_delta": number }] }],
  "add_ons": [{ "id": string, "name": string, "price": number }],
  "menu": { "categories": [{ "id": string, "name": string, "items": [{ "id": string, "name": string, "description": string, "price": number, "modifier_groups": [group ids] }] }] },
  "extraction_notes": [string]
}

Rules:
- Prices are in Naira (plain numbers, not kobo). If a price is missing or unreadable, use 0 and add an extraction_note naming the item.
- Invent stable ids like "cat_1", "item_1", "mg_1".
- Put anything you could not represent (missing address, unclear hours, ambiguous prices, items you skipped) into extraction_notes in plain merchant-friendly language.
- If the document is not about a food business or contains no menu-like content, return {"error": "<one sentence why>"} instead.`;

export function buildExtractionTool(ctx: ExtractionToolContext): AITool {
  const { sessionKey, businessId, userId, emit } = ctx;

  return {
    name: "extract_store_from_document",
    description:
      "Read the merchant's uploaded document and extract a structured store draft (branches, menus, categories, items, modifiers). The platform then shows the merchant a preview card to approve. Call this when the merchant asks to create a store from their document.",
    parameters: z.object({
      merchant_instructions: z
        .string()
        .max(1000)
        .optional()
        .describe(
          "Anything specific the merchant asked for, e.g. 'skip the drinks section'",
        ),
    }),
    execute: async ({
      merchant_instructions,
    }: {
      merchant_instructions?: string;
    }) => {
      const doc = await getDocument(sessionKey);
      if (!doc) {
        return {
          error:
            "No document is attached. Ask the merchant to attach their menu or business document first (paperclip icon).",
        };
      }

      const provider = await resolveAgentProvider();
      const userContent = [
        merchant_instructions
          ? `Merchant instructions: ${merchant_instructions}`
          : null,
        `Document (${doc.filename}):\n\n${doc.text}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      let raw = "";
      let parsed: KitchenJson | null = null;
      let extractionNotes: string[] = [];

      // One retry with validation feedback if the first output doesn't parse.
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        const response = await provider.generateContent([
          { role: "system", content: EXTRACTION_SYSTEM },
          { role: "user", content: userContent },
          ...(attempt > 0 && raw
            ? [
                { role: "assistant" as const, content: raw },
                {
                  role: "user" as const,
                  content:
                    "That JSON failed validation. Return corrected JSON only.",
                },
              ]
            : []),
        ]);
        raw = response.text ?? "";

        let candidate: unknown;
        try {
          candidate = JSON.parse(stripJsonFences(raw));
        } catch {
          continue;
        }

        if (
          candidate &&
          typeof candidate === "object" &&
          "error" in (candidate as any) &&
          !("restaurant" in (candidate as any))
        ) {
          return { error: (candidate as any).error };
        }

        extractionNotes = Array.isArray((candidate as any)?.extraction_notes)
          ? (candidate as any).extraction_notes.map(String)
          : [];
        const result = kitchenJsonSchema.safeParse(candidate);
        if (result.success) parsed = result.data;
      }

      if (!parsed) {
        return {
          error:
            "I couldn't reliably extract a store structure from this document. It may be formatted in a way I can't read — try a cleaner version.",
        };
      }

      const items = parsed.menu.categories.flatMap((c) => c.items);
      const gaps = [...extractionNotes];
      if (!parsed.restaurant.address.line1 || !parsed.restaurant.address.city) {
        gaps.push("No full address found — add it under Store → Branches.");
      }
      if (!parsed.restaurant.hours || !Object.keys(parsed.restaurant.hours).length) {
        gaps.push("No opening hours found — set them under Store → Branches.");
      }
      const zeroPriced = items.filter((i) => i.price === 0).length;
      if (zeroPriced > 0) {
        gaps.push(`${zeroPriced} item(s) had no readable price (set to ₦0).`);
      }

      const summary: StoreDraftSummary = {
        storeName: parsed.restaurant.name,
        sellsInPerson: true,
        branchCount: 1,
        menuCount: 1,
        categoryCount: parsed.menu.categories.length,
        itemCount: items.length,
        sampleItems: items.slice(0, 5).map((i) => i.name),
        gaps,
      };

      const draft: StoreDraft = {
        draftId: randomUUID(),
        businessId,
        userId,
        status: "pending",
        json: parsed,
        summary,
        createdAt: new Date().toISOString(),
      };
      await saveDraft(draft);
      await pointSessionAtDraft(sessionKey, draft.draftId);

      emit("preview", { draftId: draft.draftId, summary });

      return {
        ok: true,
        summary,
        note: "A preview card with an Approve button is now showing to the merchant. Briefly describe what you found (store name, item count, any gaps). Do not claim the store is created.",
      };
    },
  };
}

function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
