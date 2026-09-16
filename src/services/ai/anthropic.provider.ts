import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  AIMessage,
  AIProvider,
  AIProviderResponse,
  AITool,
} from "./ai-provider.types";

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 4096;

/**
 * Native Anthropic provider for the agent stack. Unlike the
 * OpenAI-compatible providers, Claude keeps the system prompt as a
 * top-level param and represents tool calls/results as typed content
 * blocks — this class translates the provider-agnostic AIMessage shape
 * both ways so the agent loop stays vendor-neutral.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private client: Anthropic | null = null;
  private readonly modelOverride?: string;

  constructor(modelOverride?: string) {
    this.modelOverride = modelOverride;
  }

  isAvailable(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async generateContent(
    messages: AIMessage[],
    tools?: AITool[],
  ): Promise<AIProviderResponse> {
    if (!this.isAvailable()) {
      throw new Error("anthropic provider is not configured");
    }
    if (!this.client) {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const response = await this.client.messages.create({
      model: this.modelOverride || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: system || undefined,
      messages: toAnthropicMessages(messages),
      tools: toAnthropicTools(tools),
    });

    return parseResponse(response);
  }
}

function toAnthropicMessages(
  messages: AIMessage[],
): Anthropic.MessageParam[] {
  const mapped: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue; // hoisted into the top-level system param
    }

    if (message.role === "tool") {
      mapped.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            content: message.content,
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.args ?? {},
        });
      }
      mapped.push({ role: "assistant", content: blocks });
      continue;
    }

    mapped.push({ role: message.role, content: message.content });
  }

  // The Messages API expects alternating roles; tool results (mapped to
  // user turns) can land next to real user turns, so merge consecutive
  // same-role messages into one multi-block message.
  const merged: Anthropic.MessageParam[] = [];
  for (const message of mapped) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = [
        ...toBlocks(previous.content),
        ...toBlocks(message.content),
      ];
    } else {
      merged.push(message);
    }
  }
  return merged;
}

function toBlocks(
  content: Anthropic.MessageParam["content"],
): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return [...content];
}

function toAnthropicTools(tools?: AITool[]): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(
      tool.parameters,
    ) as Anthropic.Tool.InputSchema,
  }));
}

function parseResponse(response: Anthropic.Message): AIProviderResponse {
  let text = "";
  const toolCalls: NonNullable<AIProviderResponse["toolCalls"]> = [];

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input ?? {},
      });
    }
  }

  return {
    text: text || undefined,
    toolCalls,
    tokensUsed:
      (response.usage?.input_tokens ?? 0) +
      (response.usage?.output_tokens ?? 0),
  };
}
