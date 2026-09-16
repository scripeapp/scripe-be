/**
 * The agent loop: call the model, dispatch any tool calls to their
 * execute() handlers (in parallel), feed results back, repeat until the
 * model answers in text (or the iteration cap is hit). Transport-agnostic
 * — progress is reported through an emit callback so the SSE controller
 * owns the wire format.
 *
 * Interrupted turns (dropped SSE connection) are checkpointed after each
 * tool round, so a client retry resumes from the checkpoint instead of
 * re-running the whole turn.
 */
import { resolveAgentProvider } from "./agent-settings.service";
import { aiContextStore } from "./context.store";
import { AGENT_SYSTEM_PROMPT } from "./agent-system-prompt";
import { AIMessage, AIProviderResponse, AITool } from "./ai-provider.types";
import { AgentEmit } from "../../types/ai-agent.types";

const MAX_ITERATIONS = 8;

export interface AgentTurnOptions {
  sessionKey: string;
  userText: string;
  tools: AITool[];
  emit: AgentEmit;
  signal?: AbortSignal;
  /** Extra system guidance injected after context (e.g. "the merchant
   *  answered your detail questions — finish the tool call"). */
  systemNote?: string;
}

type ToolCall = NonNullable<AIProviderResponse["toolCalls"]>[number];

interface ToolExecution {
  call: ToolCall;
  result: unknown;
}

export async function runAgentTurn(options: AgentTurnOptions): Promise<void> {
  const { sessionKey, userText, tools, emit, signal, systemNote } = options;
  const provider = await resolveAgentProvider();

  const messages = await buildTurnMessages(sessionKey, userText, systemNote);
  let totalTokens = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (signal?.aborted) return;

    const response = await provider.generateContent(messages, tools);
    totalTokens += response.tokensUsed ?? 0;

    if (!response.toolCalls?.length) {
      const text = response.text ?? "";
      emit("message", { text });
      await aiContextStore.addMessage(sessionKey, {
        role: "user",
        content: userText,
      });
      await aiContextStore.addMessage(sessionKey, {
        role: "assistant",
        content: text,
      });
      await aiContextStore.clearInflightTurn(sessionKey);
      emit("done", { tokensUsed: totalTokens });
      return;
    }

    messages.push({
      role: "assistant",
      content: response.text ?? "",
      toolCalls: response.toolCalls,
    });

    const executions = await executeToolCallsInParallel(
      response.toolCalls,
      tools,
      emit,
      signal,
    );
    for (const execution of executions) {
      messages.push({
        role: "tool",
        content: JSON.stringify(execution.result),
        toolCallId: execution.call.id,
      });
    }

    if (signal?.aborted) return;
    await aiContextStore.saveInflightTurn(sessionKey, messages);
  }

  await aiContextStore.clearInflightTurn(sessionKey);
  emit("error", {
    message: "The assistant took too many steps. Please try rephrasing.",
  });
}

/** Resume the checkpointed buffer when the previous turn was interrupted
 *  and the client retried the same message; otherwise assemble a fresh
 *  conversation from the stored context. */
async function buildTurnMessages(
  sessionKey: string,
  userText: string,
  systemNote?: string,
): Promise<AIMessage[]> {
  const inflight = await aiContextStore.getInflightTurn(sessionKey);
  if (
    inflight &&
    inflight.length > 0 &&
    hasSameUserMessage(inflight, userText)
  ) {
    return inflight;
  }

  const context = await aiContextStore.getContext(sessionKey);
  const messages: AIMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
  ];
  if (context.summary) {
    messages.push({
      role: "system",
      content: `Summary of earlier conversation:\n${context.summary}`,
    });
  }
  messages.push(...context.messages);
  if (systemNote) {
    messages.push({ role: "system", content: systemNote });
  }
  messages.push({ role: "user", content: userText });
  return messages;
}

function hasSameUserMessage(messages: AIMessage[], userText: string): boolean {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  return lastUserMessage?.content === userText;
}

async function executeToolCallsInParallel(
  calls: ToolCall[],
  tools: AITool[],
  emit: AgentEmit,
  signal?: AbortSignal,
): Promise<ToolExecution[]> {
  const pendingCalls = signal?.aborted ? [] : calls;
  for (const call of pendingCalls) {
    emit("tool_status", { tool: call.name, status: "started" });
  }

  const executions = await Promise.all(
    pendingCalls.map(async (call) => ({
      call,
      result: await executeToolCall(call, tools, signal),
    })),
  );

  for (const { call, result } of executions) {
    emit("tool_status", {
      tool: call.name,
      status: isToolError(result) ? "error" : "finished",
    });
  }
  return executions;
}

async function executeToolCall(
  call: ToolCall,
  tools: AITool[],
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) return { error: "Turn was cancelled." };

  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return { error: `Unknown tool: ${call.name}` };
  }

  const parsed = tool.parameters.safeParse(call.args ?? {});
  if (!parsed.success) {
    return { error: `Invalid arguments: ${parsed.error.message}` };
  }

  try {
    return await tool.execute(parsed.data);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}