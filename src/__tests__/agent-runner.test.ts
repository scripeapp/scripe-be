import { z } from "zod";
import { runAgentTurn } from "../services/ai/agent-runner";
import { resolveAgentProvider } from "../services/ai/agent-settings.service";
import { aiContextStore } from "../services/ai/context.store";
import {
  AIMessage,
  AIProvider,
  AITool,
} from "../services/ai/ai-provider.types";
import { AgentEmit, AgentEventName } from "../types/ai-agent.types";
import { delay } from "./test-utils";

jest.mock("../services/ai/agent-settings.service", () => ({
  resolveAgentProvider: jest.fn(),
}));

// Keep the agent's stores on the in-memory fallback so tests never hit
// real Redis (dotenv loads real credentials in config/redis.ts).
jest.mock("../config/redis", () => ({ redis: null }));

const mockedResolveAgentProvider = resolveAgentProvider as jest.Mock;

const SESSION_KEY = "agent:test-business:runner-user";

function captureEmit() {
  const events: Array<{ event: AgentEventName; data: unknown }> = [];
  const emit: AgentEmit = (event, data) => {
    events.push({ event, data });
  };
  return { events, emit };
}

type MockedProvider = AIProvider & { generateContent: jest.Mock };

function makeProvider(generateContent: jest.Mock): MockedProvider {
  return {
    name: "test-provider",
    isAvailable: () => true,
    generateContent,
  };
}

function makeTool(
  name: string,
  execute?: jest.Mock,
  schema: z.ZodObject<any> = z.object({}),
): AITool {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: schema,
    execute: execute ?? jest.fn().mockResolvedValue({ ok: true }),
  };
}

function findToolStatus(
  events: Array<{ event: AgentEventName; data: unknown }>,
  tool: string,
  status: string,
) {
  return events.find(
    (e) =>
      e.event === "tool_status" &&
      (e.data as { tool: string; status: string }).tool === tool &&
      (e.data as { tool: string; status: string }).status === status,
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  await aiContextStore.clearContext(SESSION_KEY);
  await aiContextStore.clearInflightTurn(SESSION_KEY);
});

describe("runAgentTurn", () => {
  it("emits the model's text answer and persists the conversation", async () => {
    const provider = makeProvider(
      jest.fn().mockResolvedValue({ text: "Hello!", tokensUsed: 12 }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const { events, emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "Hi",
      tools: [],
      emit,
    });

    expect(events.map((e) => e.event)).toEqual(["message", "done"]);
    expect(events[0].data).toEqual({ text: "Hello!" });
    expect(events[1].data).toEqual({ tokensUsed: 12 });

    const context = await aiContextStore.getContext(SESSION_KEY);
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]).toEqual({ role: "user", content: "Hi" });
    expect(context.messages[1]).toEqual({
      role: "assistant",
      content: "Hello!",
    });
  });

  it("executes independent tool calls in parallel and feeds results back in order", async () => {
    const fastTool = makeTool(
      "fast_tool",
      jest.fn(async () => {
        await delay(5);
        return { ok: "fast" };
      }),
    );
    const slowTool = makeTool(
      "slow_tool",
      jest.fn(async () => {
        await delay(30);
        return { ok: "slow" };
      }),
    );
    const tools = [slowTool, fastTool];

    const provider = makeProvider(
      jest
        .fn()
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [
            { id: "call_1", name: "slow_tool", args: {} },
            { id: "call_2", name: "fast_tool", args: {} },
          ],
        })
        .mockResolvedValueOnce({ text: "Done", tokensUsed: 3 }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const { events, emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "do it",
      tools,
      emit,
    });

    // Sequential dispatch would finish slow_tool before fast_tool starts.
    const fastStartedIndex = events.indexOf(
      findToolStatus(events, "fast_tool", "started")!,
    );
    const slowFinishedIndex = events.indexOf(
      findToolStatus(events, "slow_tool", "finished")!,
    );
    expect(slowFinishedIndex).toBeGreaterThan(fastStartedIndex);

    expect(findToolStatus(events, "slow_tool", "finished")).toBeDefined();
    expect(findToolStatus(events, "fast_tool", "finished")).toBeDefined();

    // Tool results are fed back in the order the model issued the calls.
    const secondCallMessages = provider.generateContent.mock.calls[1][0] as AIMessage[];
    const toolMessages = secondCallMessages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.toolCallId)).toEqual([
      "call_1",
      "call_2",
    ]);
    expect(provider.generateContent.mock.calls[1][1]).toBe(tools);
  });

  it("reports tool failures as tool_status errors and feeds the error back", async () => {
    const failingTool = makeTool(
      "failing_tool",
      jest.fn().mockRejectedValue(new Error("boom")),
    );
    const provider = makeProvider(
      jest
        .fn()
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [{ id: "call_1", name: "failing_tool", args: {} }],
        })
        .mockResolvedValueOnce({ text: "Recovered", tokensUsed: 0 }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const { events, emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "run it",
      tools: [failingTool],
      emit,
    });

    expect(findToolStatus(events, "failing_tool", "error")).toBeDefined();

    const secondCallMessages = provider.generateContent.mock.calls[1][0] as AIMessage[];
    const toolMessage = secondCallMessages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("boom");
  });

  it("feeds back errors for unknown tools and invalid arguments", async () => {
    const knownTool = makeTool(
      "known_tool",
      jest.fn().mockResolvedValue({ ok: true }),
      z.object({ required_field: z.string() }),
    );
    const provider = makeProvider(
      jest
        .fn()
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [
            { id: "call_1", name: "unknown_tool", args: {} },
            { id: "call_2", name: "known_tool", args: {} },
          ],
        })
        .mockResolvedValueOnce({ text: "Done", tokensUsed: 0 }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const { emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "go",
      tools: [knownTool],
      emit,
    });

    const secondCallMessages = provider.generateContent.mock.calls[1][0] as AIMessage[];
    const toolContents = secondCallMessages
      .filter((m) => m.role === "tool")
      .map((m) => m.content);
    expect(toolContents[0]).toContain("Unknown tool: unknown_tool");
    expect(toolContents[1]).toContain("Invalid arguments");
  });

  it("resumes an interrupted turn from its checkpoint when the message matches", async () => {
    const tool = makeTool("some_tool");
    const provider = makeProvider(
      jest.fn().mockResolvedValue({ text: "Resumed answer", tokensUsed: 0 }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const checkpoint: AIMessage[] = [
      { role: "system", content: "agent system prompt" },
      { role: "user", content: "make it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "some_tool", args: {} }],
      },
      { role: "tool", content: '{"ok":true}', toolCallId: "call_1" },
    ];
    await aiContextStore.saveInflightTurn(SESSION_KEY, checkpoint);

    const { events, emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "make it",
      tools: [tool],
      emit,
    });

    expect(tool.execute).not.toHaveBeenCalled();
    expect(provider.generateContent).toHaveBeenCalledTimes(1);
    const messages = provider.generateContent.mock.calls[0][0] as AIMessage[];
    expect(messages).toHaveLength(checkpoint.length);
    expect(events.some((e) => e.event === "message")).toBe(true);
    expect(await aiContextStore.getInflightTurn(SESSION_KEY)).toBeNull();
  });

  it("starts fresh when the retried message differs from the checkpoint", async () => {
    const provider = makeProvider(
      jest.fn().mockResolvedValue({ text: "Fresh answer", tokensUsed: 0 }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    await aiContextStore.saveInflightTurn(SESSION_KEY, [
      { role: "system", content: "agent system prompt" },
      { role: "user", content: "old message" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "some_tool", args: {} }],
      },
      { role: "tool", content: '{"ok":true}', toolCallId: "call_1" },
    ]);

    const { emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "new message",
      tools: [],
      emit,
    });

    const messages = provider.generateContent.mock.calls[0][0] as AIMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "user", content: "new message" });
  });

  it("checkpoints after each tool round so a dropped stream can resume", async () => {
    const checkpointSeen: { buffer: AIMessage[] | null } = { buffer: null };
    const roundTwoTool = makeTool(
      "round_two_tool",
      jest.fn(async () => {
        // Snapshot at capture time: the in-memory fallback hands back the
        // live buffer reference, which the runner keeps mutating.
        const inflight = await aiContextStore.getInflightTurn(SESSION_KEY);
        checkpointSeen.buffer = inflight
          ? JSON.parse(JSON.stringify(inflight))
          : null;
        return { ok: true };
      }),
    );
    const provider = makeProvider(
      jest
        .fn()
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [
            { id: "call_1", name: "round_one_tool", args: {} },
          ],
        })
        .mockResolvedValueOnce({
          text: "",
          toolCalls: [
            { id: "call_2", name: "round_two_tool", args: {} },
          ],
        })
        .mockResolvedValueOnce({ text: "Done", tokensUsed: 0 }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const { emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "make it",
      tools: [makeTool("round_one_tool"), roundTwoTool],
      emit,
    });

    // Round two observed the checkpoint saved after round one, so a turn
    // dropped right after a tool round can resume from that buffer.
    expect(checkpointSeen.buffer).not.toBeNull();
    expect(
      checkpointSeen.buffer?.some(
        (m) => m.role === "tool" && m.toolCallId === "call_1",
      ),
    ).toBe(true);
    expect(
      checkpointSeen.buffer?.some(
        (m) => m.role === "tool" && m.toolCallId === "call_2",
      ),
    ).toBe(false);
  });

  it("emits an error after the iteration cap", async () => {
    const tool = makeTool("some_tool");
    const provider = makeProvider(
      jest.fn().mockResolvedValue({
        text: "",
        toolCalls: [{ id: "call_1", name: "some_tool", args: {} }],
      }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const { events, emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "keep going",
      tools: [tool],
      emit,
    });

    expect(provider.generateContent).toHaveBeenCalledTimes(8);
    expect(events[events.length - 1]).toMatchObject({
      event: "error",
      data: { message: "The assistant took too many steps. Please try rephrasing." },
    });
    expect(await aiContextStore.getInflightTurn(SESSION_KEY)).toBeNull();
  });

  it("stops immediately when the signal is already aborted", async () => {
    const provider = makeProvider(jest.fn());
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const controller = new AbortController();
    controller.abort();

    const { emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "hi",
      tools: [],
      emit,
      signal: controller.signal,
    });

    expect(provider.generateContent).not.toHaveBeenCalled();
  });

  it("does not checkpoint when aborted mid-tool-execution", async () => {
    const controller = new AbortController();
    const abortingTool = makeTool(
      "aborting_tool",
      jest.fn(async () => {
        controller.abort();
        return { ok: true };
      }),
    );
    const provider = makeProvider(
      jest.fn().mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "call_1", name: "aborting_tool", args: {} }],
      }),
    );
    mockedResolveAgentProvider.mockResolvedValue(provider);

    const { emit } = captureEmit();
    await runAgentTurn({
      sessionKey: SESSION_KEY,
      userText: "go",
      tools: [abortingTool],
      emit,
      signal: controller.signal,
    });

    expect(provider.generateContent).toHaveBeenCalledTimes(1);
    expect(await aiContextStore.getInflightTurn(SESSION_KEY)).toBeNull();
  });
});
