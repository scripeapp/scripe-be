export const MERCHANT_CAPABILITIES = [
  {
    id: "daily_business_briefing",
    title: "Daily business briefing",
    category: "operations",
    mode: "analysis",
    description:
      "Summarize sales, orders, inventory, bookings, campaigns, and urgent issues.",
  },
  {
    id: "business_data_search",
    title: "Business data search",
    category: "operations",
    mode: "analysis",
    description: "Answer natural-language questions using live merchant data.",
  },
  {
    id: "order_management",
    title: "Order management",
    category: "operations",
    mode: "action_plan",
    description:
      "Find orders and prepare status, fulfilment, note, or refund actions.",
  },
  {
    id: "product_creation",
    title: "Product creation",
    category: "operations",
    mode: "draft",
    description:
      "Prepare complete drafts for physical, digital, course, event, service, and bundle products.",
  },
  {
    id: "product_editing",
    title: "Product editing",
    category: "operations",
    mode: "action_plan",
    description:
      "Prepare product pricing, content, availability, and channel changes.",
  },
  {
    id: "inventory_monitoring",
    title: "Inventory monitoring",
    category: "operations",
    mode: "analysis",
    description:
      "Find low stock, stockouts, excess stock, and unusual inventory levels.",
  },
  {
    id: "restock_recommendations",
    title: "Restock recommendations",
    category: "operations",
    mode: "analysis",
    description:
      "Recommend reorder quantities from stock and recent sales velocity.",
  },
  {
    id: "bulk_action_planner",
    title: "Bulk action planner",
    category: "operations",
    mode: "action_plan",
    description:
      "Preview a validated batch operation across selected merchant records.",
  },
  {
    id: "store_health_check",
    title: "Store health check",
    category: "operations",
    mode: "analysis",
    description:
      "Audit store readiness, incomplete products, missing media, stock, and configuration.",
  },
  {
    id: "command_center_navigation",
    title: "Command centre",
    category: "operations",
    mode: "navigation",
    description:
      "Direct merchants to the correct Hilaq workflow and explain the next action.",
  },
  {
    id: "sales_performance_analysis",
    title: "Sales performance analyst",
    category: "sales",
    mode: "analysis",
    description:
      "Explain revenue and order performance by product, store, status, and period.",
  },
  {
    id: "demand_forecasting",
    title: "Demand forecasting",
    category: "sales",
    mode: "analysis",
    description: "Forecast near-term demand from recent order history.",
  },
  {
    id: "pricing_recommendations",
    title: "Pricing recommendations",
    category: "sales",
    mode: "analysis",
    description:
      "Recommend product pricing changes using demand, stock, and current price data.",
  },
  {
    id: "discount_builder",
    title: "Discount builder",
    category: "sales",
    mode: "draft",
    description:
      "Draft a percentage, fixed, bundle, coupon, or limited-time promotion.",
  },
  {
    id: "promotion_effectiveness",
    title: "Promotion effectiveness",
    category: "sales",
    mode: "analysis",
    description: "Evaluate discount usage, revenue, and campaign outcomes.",
  },
  {
    id: "upsell_recommendations",
    title: "Upsell recommendations",
    category: "sales",
    mode: "analysis",
    description:
      "Find higher-value and complementary offers for existing products.",
  },
  {
    id: "bundle_generator",
    title: "Cross-sell bundle generator",
    category: "sales",
    mode: "draft",
    description: "Find products bought together and prepare bundle drafts.",
  },
  {
    id: "abandoned_cart_recovery",
    title: "Abandoned-cart recovery",
    category: "sales",
    mode: "draft",
    description: "Identify checkout drop-off and draft a recovery campaign.",
  },
  {
    id: "revenue_opportunity_detection",
    title: "Revenue opportunity detector",
    category: "sales",
    mode: "analysis",
    description:
      "Find high-interest, low-conversion, unavailable, or under-promoted products.",
  },
  {
    id: "profitability_calculator",
    title: "Profitability calculator",
    category: "sales",
    mode: "analysis",
    description:
      "Estimate revenue, costs, fees, refunds, and gross profit from supplied assumptions.",
  },
  {
    id: "customer_profile_summary",
    title: "Customer profile summarizer",
    category: "customers",
    mode: "analysis",
    description:
      "Summarize a customer's orders, value, recency, and preferences.",
  },
  {
    id: "customer_segmentation",
    title: "Customer segmentation",
    category: "customers",
    mode: "analysis",
    description:
      "Group customers by value, recency, frequency, and lifecycle stage.",
  },
  {
    id: "campaign_message_writer",
    title: "Campaign message writer",
    category: "customers",
    mode: "draft",
    description: "Draft email, SMS, WhatsApp, push, or social campaign copy.",
  },
  {
    id: "personalized_campaign",
    title: "Personalized campaign generator",
    category: "customers",
    mode: "draft",
    description:
      "Prepare an audience, offer, message, timing, and channel plan.",
  },
  {
    id: "customer_support_copilot",
    title: "Customer support copilot",
    category: "customers",
    mode: "draft",
    description: "Draft an accurate response using order and store context.",
  },
  {
    id: "support_triage",
    title: "Support triage",
    category: "customers",
    mode: "analysis",
    description:
      "Classify a support request by topic, urgency, sentiment, and owner.",
  },
  {
    id: "complaint_resolution",
    title: "Complaint resolution assistant",
    category: "customers",
    mode: "action_plan",
    description:
      "Investigate a complaint and propose an appropriate resolution.",
  },
  {
    id: "review_response",
    title: "Review response assistant",
    category: "customers",
    mode: "draft",
    description: "Draft brand-appropriate responses to customer reviews.",
  },
  {
    id: "customer_retention_alerts",
    title: "Customer retention alerts",
    category: "customers",
    mode: "analysis",
    description:
      "Find valuable customers whose purchase frequency is declining.",
  },
  {
    id: "win_back_campaign",
    title: "Win-back campaign builder",
    category: "customers",
    mode: "draft",
    description: "Build a campaign for inactive customer segments.",
  },
  {
    id: "product_description_generator",
    title: "Description generator",
    category: "content",
    mode: "draft",
    description: "Write a clear, accurate product description.",
  },
  {
    id: "product_seo",
    title: "Product SEO assistant",
    category: "content",
    mode: "draft",
    description: "Draft search titles, metadata, keywords, and readable URLs.",
  },
  {
    id: "image_quality_audit",
    title: "Image quality auditor",
    category: "content",
    mode: "analysis",
    description: "Find missing or structurally incomplete product image sets.",
  },
  {
    id: "product_image_brief",
    title: "Product image generator",
    category: "content",
    mode: "draft",
    description:
      "Create a production-ready brief and prompts for product imagery.",
  },
  {
    id: "catalog_cleanup",
    title: "Catalog cleanup assistant",
    category: "content",
    mode: "analysis",
    description:
      "Find duplicate names, missing descriptions, SKUs, media, and inconsistent records.",
  },
  {
    id: "automatic_categorization",
    title: "Automatic product categorization",
    category: "content",
    mode: "draft",
    description: "Recommend categories, tags, attributes, and search terms.",
  },
  {
    id: "digital_file_validation",
    title: "Digital-file validator",
    category: "content",
    mode: "analysis",
    description:
      "Audit digital products for missing or incomplete downloadable assets.",
  },
  {
    id: "course_curriculum_builder",
    title: "Course curriculum builder",
    category: "content",
    mode: "draft",
    description: "Draft modules, lessons, objectives, and assessments.",
  },
  {
    id: "event_setup",
    title: "Event setup assistant",
    category: "content",
    mode: "draft",
    description:
      "Draft schedules, venues, multi-day times, tickets, and capacity.",
  },
  {
    id: "service_setup",
    title: "Service setup assistant",
    category: "content",
    mode: "draft",
    description:
      "Draft duration, availability, location, buffers, pricing, and booking rules.",
  },
  {
    id: "cash_flow_forecast",
    title: "Cash-flow forecast",
    category: "finance",
    mode: "analysis",
    description:
      "Forecast short-term income, expenses, refunds, and cash position.",
  },
  {
    id: "payout_reconciliation",
    title: "Payout reconciliation",
    category: "finance",
    mode: "analysis",
    description:
      "Compare sales, refunds, fees, and payout batches for discrepancies.",
  },
  {
    id: "refund_risk_detection",
    title: "Refund-risk detector",
    category: "finance",
    mode: "analysis",
    description:
      "Find products and fulfilment patterns associated with refunds.",
  },
  {
    id: "fraud_review",
    title: "Fraud review assistant",
    category: "finance",
    mode: "analysis",
    description:
      "Surface suspicious high-value or unusual order patterns for manual review.",
  },
  {
    id: "invoice_receipt_assistant",
    title: "Invoice and receipt assistant",
    category: "finance",
    mode: "draft",
    description: "Find transactions and prepare invoice or receipt details.",
  },
  {
    id: "expense_categorization",
    title: "Expense categorization",
    category: "finance",
    mode: "analysis",
    description: "Classify expenses and identify unusual recurring costs.",
  },
  {
    id: "schedule_optimization",
    title: "Schedule optimization",
    category: "growth",
    mode: "analysis",
    description: "Recommend availability from booking demand and capacity.",
  },
  {
    id: "no_show_reduction",
    title: "No-show reduction assistant",
    category: "growth",
    mode: "draft",
    description:
      "Identify no-show patterns and prepare reminder or confirmation plans.",
  },
  {
    id: "business_goal_planner",
    title: "Business goal planner",
    category: "growth",
    mode: "draft",
    description:
      "Turn a revenue or growth target into measurable weekly actions.",
  },
  {
    id: "opportunity_monitor",
    title: "Autonomous opportunity monitor",
    category: "growth",
    mode: "analysis",
    description:
      "Scan current business data for actionable risks and opportunities.",
  },
] as const;

export type MerchantCapability = (typeof MERCHANT_CAPABILITIES)[number];
export type MerchantCapabilityId = MerchantCapability["id"];
export type MerchantCapabilityMode = MerchantCapability["mode"];

export const MERCHANT_CAPABILITY_IDS = MERCHANT_CAPABILITIES.map(
  (capability) => capability.id,
) as [MerchantCapabilityId, ...MerchantCapabilityId[]];

export function getMerchantCapability(
  capabilityId: MerchantCapabilityId,
): MerchantCapability {
  const capability = MERCHANT_CAPABILITIES.find(
    (candidate) => candidate.id === capabilityId,
  );
  if (!capability)
    throw new Error(`Unknown merchant capability: ${capabilityId}`);
  return capability;
}
