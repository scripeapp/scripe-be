import { AIProvider } from "./ai-provider.types";
import { createAIProvider } from "./ai-providers";
import { AnthropicProvider } from "./anthropic.provider";
import { MockAIProvider } from "./mock.provider";

/**
 * Returns the configured AI provider.
 *
 * Configured via AI_PROVIDER: "gemini" | "ollama" | "openai" | "anthropic"
 * (default: "gemini")
 */
export function getAIProvider(): AIProvider {
  return buildProvider(process.env.AI_PROVIDER);
}

export interface AgentProviderOverride {
  provider?: string;
  model?: string;
}

/**
 * Provider for the dashboard agent (chat panel / doc-to-store).
 * Precedence: explicit override (admin settings) → AI_AGENT_PROVIDER env →
 * AI_PROVIDER env → anthropic. The override's model, when set, replaces
 * the provider's env-configured model.
 */
export function getAgentAIProvider(
  override?: AgentProviderOverride,
): AIProvider {
  const key =
    override?.provider ||
    process.env.AI_AGENT_PROVIDER ||
    process.env.AI_PROVIDER ||
    "anthropic";
  return buildProvider(key, override?.model);
}

function buildProvider(key?: string, model?: string): AIProvider {
  const normalised = (key || "").toLowerCase();
  if (normalised === "anthropic") {
    return new AnthropicProvider(model);
  }
  // Offline deterministic provider for local testing — never set this in
  // production; it fabricates responses.
  if (normalised === "mock") {
    return new MockAIProvider();
  }
  return createAIProvider(key, model);
}

export default getAIProvider;
