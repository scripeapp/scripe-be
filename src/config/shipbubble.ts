export const shipbubbleConfig = {
  apiKey: process.env.SHIPBUBBLE_API_KEY || "",
  baseUrl: "https://api.shipbubble.com/v1",
  webhookSecret: process.env.SHIPBUBBLE_WEBHOOK_SECRET || "",
  // Shipbubble package category. 20754594 = "Light weight items" — a safe
  // general default. Fetch valid IDs from GET /shipping/labels/categories.
  defaultCategoryId:
    Number(process.env.SHIPBUBBLE_DEFAULT_CATEGORY_ID) || 20754594,
  defaultPackageDimensions: {
    length: Number(process.env.SHIPBUBBLE_DEFAULT_PKG_LENGTH) || 30,
    width: Number(process.env.SHIPBUBBLE_DEFAULT_PKG_WIDTH) || 20,
    height: Number(process.env.SHIPBUBBLE_DEFAULT_PKG_HEIGHT) || 10,
  },
  markupPercent: Number(process.env.SHIPBUBBLE_MARKUP_PERCENT) || 10,
};
