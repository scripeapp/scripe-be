import {
  getMerchantCapability,
  MERCHANT_CAPABILITIES,
  MERCHANT_CAPABILITY_IDS,
} from "../services/ai/merchant-capabilities";
import { buildMerchantCapabilityTool } from "../services/ai/tools/merchant-capability.tool";

describe("merchant capability registry", () => {
  it("exposes the complete set of 50 unique capabilities", () => {
    expect(MERCHANT_CAPABILITIES).toHaveLength(50);
    expect(new Set(MERCHANT_CAPABILITY_IDS).size).toBe(50);
  });

  it("gives every capability usable merchant-facing metadata", () => {
    for (const capability of MERCHANT_CAPABILITIES) {
      expect(capability.title.trim()).not.toBe("");
      expect(capability.description.trim()).not.toBe("");
      expect(["analysis", "draft", "action_plan", "navigation"]).toContain(
        capability.mode,
      );
    }
  });

  it("marks consequential workflows as action plans", () => {
    expect(getMerchantCapability("order_management").mode).toBe("action_plan");
    expect(getMerchantCapability("bulk_action_planner").mode).toBe(
      "action_plan",
    );
    expect(getMerchantCapability("product_editing").mode).toBe("action_plan");
  });
});

describe("merchant capability dispatcher", () => {
  const tool = buildMerchantCapabilityTool({
    businessId: "00000000-0000-4000-8000-000000000001",
    supabase: {} as never,
  });

  it("accepts registered capabilities with bounded query controls", () => {
    const parsed = tool.parameters.safeParse({
      capability: "sales_performance_analysis",
      period: "30d",
      limit: 20,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown capabilities and excessive result limits", () => {
    expect(
      tool.parameters.safeParse({ capability: "unknown_capability" }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({
        capability: "business_data_search",
        limit: 500,
      }).success,
    ).toBe(false);
  });

  it("does not let the model provide tenant identity", () => {
    expect(Object.keys(tool.parameters.shape)).not.toContain("business_id");
    expect(Object.keys(tool.parameters.shape)).not.toContain("user_id");
  });
});
