/**
 * Deterministic mock AI provider — no network, no API key. Lets the full
 * agent stack (SSE, tool dispatch, extraction preview, approve flow) be
 * exercised locally before a real model key is configured. Same spirit as
 * DevProvider in channel-provider.ts. Select with AI_AGENT_PROVIDER=mock.
 */
import {
  AIMessage,
  AIProvider,
  AIProviderResponse,
  AITool,
} from "./ai-provider.types";

const SAMPLE_KITCHEN_JSON = {
  restaurant: {
    name: "Mock Suya Spot",
    description: "A demo store extracted by the mock provider.",
    address: { line1: "12 Demo Street", city: "Lagos", state: "Lagos" },
    phone: "+2348000000000",
    hours: { mon_thu: "10:00 - 21:00", fri_sat: "10:00 - 22:00" },
    service_types: ["pickup", "delivery"],
    delivery: { zones: [{ area: "Lekki Phase 1", fee_ngn: 1500 }] },
  },
  modifier_groups: [
    {
      id: "mg_1",
      name: "Spice level",
      selection_type: "single",
      min_selections: 1,
      max_selections: 1,
      options: [
        { name: "Mild", price_delta: 0 },
        { name: "Hot", price_delta: 0 },
      ],
    },
  ],
  add_ons: [{ id: "ao_1", name: "Extra Onions", price: 200 }],
  menu: {
    categories: [
      {
        id: "cat_1",
        name: "Grills",
        items: [
          {
            id: "item_1",
            name: "Beef Suya",
            description: "Spicy grilled beef skewers.",
            price: 2500,
            modifier_groups: ["mg_1"],
          },
          {
            id: "item_2",
            name: "Chicken Suya",
            description: "Grilled chicken skewers.",
            price: 3000,
            modifier_groups: ["mg_1"],
          },
        ],
      },
    ],
  },
  extraction_notes: ["This draft came from the mock provider, not a real document."],
};

export class MockAIProvider implements AIProvider {
  readonly name = "mock";

  isAvailable(): boolean {
    return true;
  }

  async generateContent(
    messages: AIMessage[],
    tools?: AITool[],
  ): Promise<AIProviderResponse> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const lastMessage = messages[messages.length - 1];
    const lastUserText =
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

    // Extraction call (recognised by its dedicated system prompt): return
    // the canned kitchen JSON regardless of the document's content.
    if (system.startsWith("You convert restaurant")) {
      return { text: JSON.stringify(SAMPLE_KITCHEN_JSON), tokensUsed: 0 };
    }

    // Agent turn. After a tool result, answer in text so the loop ends.
    if (lastMessage?.role === "tool") {
      return {
        text: `(mock) Here's what the tool returned:\n${truncate(lastMessage.content, 600)}`,
        toolCalls: [],
        tokensUsed: 0,
      };
    }

    const wantsTool = (name: string) => tools?.some((t) => t.name === name);
    const text = lastUserText.toLowerCase();

    if (
      wantsTool("extract_store_from_document") &&
      /(create|set ?up|build).*(store|shop)|document|menu.*upload/.test(text)
    ) {
      return {
        toolCalls: [
          { id: "mock_call_1", name: "extract_store_from_document", args: {} },
        ],
        tokensUsed: 0,
      };
    }
    if (wantsTool("get_dashboard_stats") && /revenue|sales|made|earn/.test(text)) {
      return {
        toolCalls: [
          {
            id: "mock_call_2",
            name: "get_dashboard_stats",
            args: { period: "30d" },
          },
        ],
        tokensUsed: 0,
      };
    }
    if (wantsTool("list_products") && /product|how many|catalog/.test(text)) {
      return {
        toolCalls: [
          {
            id: "mock_call_3",
            name: "list_products",
            args: { query: undefined, limit: 20 },
          },
        ],
        tokensUsed: 0,
      };
    }
    if (wantsTool("get_top_products") && /best.?sell/.test(text)) {
      return {
        toolCalls: [
          {
            id: "mock_call_6",
            name: "get_top_products",
            args: { period: "30d", limit: 5 },
          },
        ],
        tokensUsed: 0,
      };
    }
    if (wantsTool("get_recent_orders") && /order/.test(text)) {
      return {
        toolCalls: [
          { id: "mock_call_4", name: "get_recent_orders", args: { limit: 5 } },
        ],
        tokensUsed: 0,
      };
    }
    if (wantsTool("list_stores") && /store/.test(text)) {
      return {
        toolCalls: [{ id: "mock_call_5", name: "list_stores", args: {} }],
        tokensUsed: 0,
      };
    }

    return {
      text: "(mock) I'm the offline test provider. Try: \"How much did I make this month?\", \"What are my best-selling products?\", or attach a document and say \"create a store from this\".",
      toolCalls: [],
      tokensUsed: 0,
    };
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
