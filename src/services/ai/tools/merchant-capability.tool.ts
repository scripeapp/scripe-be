import { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AITool } from "../ai-provider.types";
import {
  getMerchantCapability,
  MERCHANT_CAPABILITIES,
  MERCHANT_CAPABILITY_IDS,
  MerchantCapabilityId,
} from "../merchant-capabilities";
import {
  loadMerchantData,
  MerchantDataSnapshot,
  MerchantPeriod,
} from "../merchant-data.service";

interface MerchantCapabilityToolContext {
  businessId: string;
  supabase: SupabaseClient;
}

interface CapabilityInput {
  capability: MerchantCapabilityId;
  period: MerchantPeriod;
  goal?: string;
  query?: string;
  entity_id?: string;
  details?: Record<string, unknown>;
  limit: number;
}

const capabilityInputSchema = z.object({
  capability: z.enum(MERCHANT_CAPABILITY_IDS),
  period: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
  goal: z.string().max(1000).optional(),
  query: z.string().max(500).optional(),
  entity_id: z.string().uuid().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

const MODE_GUIDANCE = {
  analysis:
    "Analyze only the returned live data. State the evidence, distinguish facts from recommendations, and mention when the sample limit prevents a firm conclusion.",
  draft:
    "Create a complete draft from the merchant's request and returned context. Label assumptions and leave unknown values explicit instead of inventing them.",
  action_plan:
    "Prepare a precise action preview. List affected records, proposed changes, validation concerns, and expected impact. Do not claim the action has been executed.",
  navigation:
    "Give the shortest relevant dashboard path and the immediate next step. Do not invent pages or controls not represented in the business context.",
} as const;

function containsSearchTerm(value: unknown, searchTerm: string): boolean {
  if (!searchTerm) return true;
  return JSON.stringify(value).toLowerCase().includes(searchTerm);
}

function selectRows<T extends { id?: string }>(
  rows: T[] | undefined,
  input: CapabilityInput,
): T[] | undefined {
  if (!rows) return undefined;
  const searchTerm = input.query?.trim().toLowerCase() ?? "";
  return rows
    .filter((row) => !input.entity_id || row.id === input.entity_id)
    .filter((row) => containsSearchTerm(row, searchTerm))
    .slice(0, input.limit);
}

function omitCustomerEmails<T extends object>(
  rows: T[] | undefined,
  input: CapabilityInput,
): unknown[] | undefined {
  if (!rows || input.query || input.entity_id) return rows;
  return rows.map((row) => {
    const redactedRow = { ...row } as Record<string, unknown>;
    delete redactedRow.email;
    delete redactedRow.customer_email;
    delete redactedRow.attendee_email;
    return redactedRow;
  });
}

function toModelPayload(
  snapshot: MerchantDataSnapshot,
  input: CapabilityInput,
): Record<string, unknown> {
  return {
    period: snapshot.period,
    generated_at: snapshot.generated_at,
    summary: snapshot.summary,
    stores: selectRows(snapshot.stores, input),
    products: selectRows(snapshot.products, input),
    orders: omitCustomerEmails(selectRows(snapshot.orders, input), input),
    customers: omitCustomerEmails(selectRows(snapshot.customers, input), input),
    events: selectRows(snapshot.events, input),
    bookings: omitCustomerEmails(selectRows(snapshot.bookings, input), input),
    campaigns: selectRows(snapshot.campaigns, input),
    transactions: selectRows(snapshot.transactions, input),
    expenses: selectRows(snapshot.expenses, input),
    payouts: selectRows(snapshot.payouts, input),
    refunds: selectRows(snapshot.refunds, input),
    reviews: selectRows(snapshot.reviews, input),
  };
}

export function buildMerchantCapabilityTool(
  context: MerchantCapabilityToolContext,
): AITool<CapabilityInput> {
  return {
    name: "use_merchant_capability",
    description: `Use one of Hilaq's merchant capabilities. Select the closest capability and provide the merchant's goal or search query. Available capabilities: ${MERCHANT_CAPABILITIES.map((capability) => `${capability.id}: ${capability.description}`).join(" ")}`,
    parameters: capabilityInputSchema,
    execute: async (input) => {
      const capability = getMerchantCapability(input.capability);
      const snapshot = await loadMerchantData(
        context,
        input.capability,
        input.period,
      );

      return {
        capability: capability.id,
        title: capability.title,
        category: capability.category,
        mode: capability.mode,
        approval_required: capability.mode === "action_plan",
        merchant_request: {
          goal: input.goal,
          query: input.query,
          entity_id: input.entity_id,
          details: input.details,
        },
        live_data: toModelPayload(snapshot, input),
        response_guidance: MODE_GUIDANCE[capability.mode],
      };
    },
  };
}
