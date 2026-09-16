/**
 * DB-backed runtime settings for the dashboard AI agent, stored as a
 * feature_flags row (key: "ai_agent_panel") so admins can flip
 * availability and switch provider/model from the admin console without
 * a deploy. The AI_AGENT_ENABLED env var remains the master override —
 * when it's off, nothing in the DB can turn the agent on.
 */
import { supabaseAdmin } from "../../config/supabase";
import { AIProvider } from "./ai-provider.types";
import { getAgentAIProvider } from "./ai-provider.factory";

export const AGENT_FLAG_KEY = "ai_agent_panel";

export interface AgentSettings {
  /** DB-level toggle (admin console). */
  enabled: boolean;
  /** Provider key override: "anthropic" | "gemini" | "openai" | "ollama" | "mock". */
  provider?: string;
  /** Model override passed to the provider. */
  model?: string;
}

const CACHE_TTL_MS = 30_000;
let cache: { value: AgentSettings; expires: number } | null = null;

export function invalidateAgentSettingsCache(): void {
  cache = null;
}

export async function getAgentSettings(): Promise<AgentSettings> {
  if (cache && Date.now() < cache.expires) {
    return cache.value;
  }

  let settings: AgentSettings = { enabled: true };
  try {
    const { data } = await supabaseAdmin
      .from("feature_flags")
      .select("enabled, metadata")
      .eq("key", AGENT_FLAG_KEY)
      .maybeSingle();

    if (data) {
      settings = {
        enabled: Boolean(data.enabled),
        provider: data.metadata?.provider || undefined,
        model: data.metadata?.model || undefined,
      };
    }
    // No row = default enabled (env + provider key still gate below).
  } catch (err) {
    console.warn("[AgentSettings] read failed, using defaults:", err);
  }

  cache = { value: settings, expires: Date.now() + CACHE_TTL_MS };
  return settings;
}

/** Env master switch && DB toggle && provider configured. */
export async function isAgentPanelEnabled(): Promise<boolean> {
  if (process.env.AI_AGENT_ENABLED !== "true") return false;
  const settings = await getAgentSettings();
  if (!settings.enabled) return false;
  return resolveAgentProviderFromSettings(settings).isAvailable();
}

/** The provider instance the agent should use right now. */
export async function resolveAgentProvider(): Promise<AIProvider> {
  const settings = await getAgentSettings();
  return resolveAgentProviderFromSettings(settings);
}

function resolveAgentProviderFromSettings(
  settings: AgentSettings,
): AIProvider {
  return getAgentAIProvider({
    provider: settings.provider,
    model: settings.model,
  });
}
