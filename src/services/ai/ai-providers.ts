import axios from "axios";
import { z } from "zod";
import {
  AIMessage,
  AIProvider,
  AIProviderResponse,
  AITool,
} from "./ai-provider.types";

const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PROVIDER = "gemini";

interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  model: string;
  /** Models tried in order when the primary is rate-limited or unavailable. */
  fallbackModels?: string[];
  apiKey?: string;
  requiresApiKey: boolean;
}

interface ChatCompletionMessage {
  role: AIMessage["role"];
  // Null (not "") on assistant tool-call turns — Gemini's OpenAI-compat
  // endpoint 400s on an empty string there.
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatCompletionToolCall[];
}

interface ChatCompletionToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
  /** Provider-specific payload (e.g. Gemini's thought_signature) that
   *  must be sent back verbatim with the call on later turns. */
  extra_content?: unknown;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ChatCompletionToolCall[];
    };
  }>;
  usage?: { total_tokens?: number };
}

/**
 * Talks to any backend that speaks the OpenAI `/chat/completions` protocol.
 * Gemini, OpenAI, and Ollama all expose this contract, so they differ only by
 * endpoint, model, and authentication — supplied through config. Adding another
 * compatible backend is a new entry in PROVIDER_CONFIGS, not new code.
 */
class OpenAICompatibleProvider implements AIProvider {
  readonly name: string;
  private readonly config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.name = config.name;
    this.config = config;
  }

  isAvailable(): boolean {
    if (!this.config.requiresApiKey) {
      return true;
    }
    return Boolean(this.config.apiKey);
  }

  async generateContent(
    messages: AIMessage[],
    tools?: AITool[],
  ): Promise<AIProviderResponse> {
    if (!this.isAvailable()) {
      throw new Error(`${this.name} provider is not configured`);
    }

    const payload = {
      messages: toChatMessages(messages),
      tools: toChatTools(tools),
    };

    const response = await this.requestWithFallback(payload);
    return parseResponse(response);
  }

  private async requestWithFallback(
    payload: Record<string, unknown>,
  ): Promise<ChatCompletionResponse> {
    const models = [this.config.model, ...(this.config.fallbackModels ?? [])];
    let lastError: unknown = null;

    for (const model of models) {
      try {
        const response = await axios.post<ChatCompletionResponse>(
          `${this.config.baseUrl}/chat/completions`,
          { model, ...payload },
          { headers: this.buildHeaders(), timeout: REQUEST_TIMEOUT_MS },
        );
        return response.data;
      } catch (error) {
        lastError = error;
        if (!isRetryableModelError(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }
}

/**
 * Per-provider configuration. Each entry is read lazily so environment changes
 * (e.g. in tests) are always reflected.
 */
const PROVIDER_CONFIGS: Record<string, () => OpenAICompatibleConfig> = {
  gemini: () => ({
    name: "gemini",
    baseUrl:
      process.env.GEMINI_BASE_URL ||
      "https://generativelanguage.googleapis.com/v1beta/openai",
    model: process.env.GEMINI_AI_MODEL || "gemini-flash-latest",
    fallbackModels: ["gemini-2.5-flash", "gemini-2.0-flash-lite"],
    apiKey: process.env.GEMINI_AI_API_KEY,
    requiresApiKey: true,
  }),
  openai: () => ({
    name: "openai",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY,
    requiresApiKey: true,
  }),
  ollama: () => ({
    name: "ollama",
    baseUrl: process.env.OLLAMA_BASE_URL || "https://ollama.com/v1",
    model: process.env.OLLAMA_MODEL || "gpt-oss:20b-cloud",
    apiKey: process.env.OLLAMA_API_KEY,
    requiresApiKey: isCloudOllamaUrl(
      process.env.OLLAMA_BASE_URL || "https://ollama.com/v1",
    ),
  }),
};

/**
 * Builds the provider for the given key, falling back to the default provider
 * when the key is unset or unknown. `modelOverride` replaces the
 * env-configured model (used by the admin agent settings).
 */
export function createAIProvider(
  requestedKey?: string,
  modelOverride?: string,
): AIProvider {
  const key = (requestedKey || DEFAULT_PROVIDER).toLowerCase();
  const buildConfig =
    PROVIDER_CONFIGS[key] ?? PROVIDER_CONFIGS[DEFAULT_PROVIDER];
  const config = buildConfig();
  if (modelOverride) {
    config.model = modelOverride;
    config.fallbackModels = [];
  }
  return new OpenAICompatibleProvider(config);
}

/** A model is worth retrying past when it is rate-limited or unavailable. */
function isRetryableModelError(error: unknown): boolean {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  if (status === 429 || status === 404) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /429|quota|404|not found/i.test(message);
}

function isCloudOllamaUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "ollama.com" || hostname.endsWith(".ollama.com");
  } catch {
    return false;
  }
}

function toChatMessages(messages: AIMessage[]): ChatCompletionMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? "",
      };
    }

    const chatMessage: ChatCompletionMessage = {
      role: message.role,
      content: message.content,
    };
    if (message.name) {
      chatMessage.name = message.name;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      chatMessage.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
        ...(call.extra ? { extra_content: call.extra } : {}),
      }));
      if (!message.content) {
        chatMessage.content = null;
      }
    }
    return chatMessage;
  });
}

function toChatTools(tools?: AITool[]) {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters),
    },
  }));
}

function parseResponse(data: ChatCompletionResponse): AIProviderResponse {
  const message = data.choices[0]?.message;

  const toolCalls = (message?.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    args: parseArguments(call.function.arguments),
    ...(call.extra_content ? { extra: call.extra_content } : {}),
  }));

  return {
    text: message?.content || undefined,
    toolCalls,
    tokensUsed: data.usage?.total_tokens,
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
