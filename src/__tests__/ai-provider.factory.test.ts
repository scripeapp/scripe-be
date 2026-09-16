import { getAIProvider } from "../services/ai/ai-provider.factory";

describe("getAIProvider", () => {
  const originalProvider = process.env.AI_PROVIDER;

  afterEach(() => {
    process.env.AI_PROVIDER = originalProvider;
  });

  it("returns the Gemini provider by default", () => {
    delete process.env.AI_PROVIDER;
    expect(getAIProvider().name).toBe("gemini");
  });

  it("selects a provider from AI_PROVIDER regardless of casing", () => {
    process.env.AI_PROVIDER = "OpenAI";
    expect(getAIProvider().name).toBe("openai");

    process.env.AI_PROVIDER = "ollama";
    expect(getAIProvider().name).toBe("ollama");
  });

  it("falls back to Gemini for an unknown provider key", () => {
    process.env.AI_PROVIDER = "unsupported-vendor";
    expect(getAIProvider().name).toBe("gemini");
  });
});
