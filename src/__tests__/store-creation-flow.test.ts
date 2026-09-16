import { z } from "zod";
import { storeCreationFlow } from "../services/ai/store-creation-flow.service";
import { aiContextStore } from "../services/ai/context.store";
import { getDocument } from "../services/ai/draft.store";
import { AITool } from "../services/ai/ai-provider.types";
import { AgentEmit, AgentEventName } from "../types/ai-agent.types";

jest.mock("../services/ai/draft.store", () => ({
  getDocument: jest.fn(),
}));

// Keep the agent's context store on the in-memory fallback so tests
// never hit real Redis (dotenv loads real credentials in config/redis.ts).
jest.mock("../config/redis", () => ({ redis: null }));

const mockedGetDocument = getDocument as jest.Mock;

const SESSION_KEY = "agent:test-business:flow-user";

function makeExtractionTool(execute: jest.Mock): AITool {
  return {
    name: "extract_store_from_document",
    description: "Extract a store from an uploaded document",
    parameters: z.object({ merchant_instructions: z.string().optional() }),
    execute,
  };
}

function captureEmit() {
  const events: Array<{ event: AgentEventName; data: unknown }> = [];
  const emit: AgentEmit = (event, data) => {
    events.push({ event, data });
  };
  return { events, emit };
}

function findEvent(
  events: Array<{ event: AgentEventName; data: unknown }>,
  event: AgentEventName,
) {
  return events.find((e) => e.event === event);
}

beforeEach(async () => {
  jest.clearAllMocks();
  await aiContextStore.clearContext(SESSION_KEY);
});

describe("StoreCreationFlowService.hasStoreCreationIntent", () => {
  it("matches store-creation phrasings", () => {
    expect(storeCreationFlow.hasStoreCreationIntent("create a store from my document")).toBe(true);
    expect(storeCreationFlow.hasStoreCreationIntent("please set up my shop")).toBe(true);
    expect(storeCreationFlow.hasStoreCreationIntent("make a menu for my restaurant")).toBe(true);
    expect(storeCreationFlow.hasStoreCreationIntent("build a catalogue")).toBe(true);
  });

  it("ignores non-store messages", () => {
    expect(storeCreationFlow.hasStoreCreationIntent("how do I create an event?")).toBe(false);
    expect(storeCreationFlow.hasStoreCreationIntent("what are my store hours?")).toBe(false);
    expect(storeCreationFlow.hasStoreCreationIntent("hello")).toBe(false);
  });
});

describe("StoreCreationFlowService.tryRunExtractionTurn", () => {
  it("returns false when no document is attached", async () => {
    mockedGetDocument.mockResolvedValue(null);

    const { events, emit } = captureEmit();
    const tool = makeExtractionTool(jest.fn());

    const handled = await storeCreationFlow.tryRunExtractionTurn({
      sessionKey: SESSION_KEY,
      message: "create a store from this",
      extractionTool: tool,
      emit,
    });

    expect(handled).toBe(false);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("returns false when the message is not store-creation intent", async () => {
    mockedGetDocument.mockResolvedValue({ filename: "menu.pdf", text: "x", truncated: false, uploadedAt: "2026-01-01" });

    const { emit } = captureEmit();
    const tool = makeExtractionTool(jest.fn());

    const handled = await storeCreationFlow.tryRunExtractionTurn({
      sessionKey: SESSION_KEY,
      message: "how much did I make this month?",
      extractionTool: tool,
      emit,
    });

    expect(handled).toBe(false);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("emits a summary message and persists the conversation on success", async () => {
    mockedGetDocument.mockResolvedValue({ filename: "menu.pdf", text: "x", truncated: false, uploadedAt: "2026-01-01" });
    const tool = makeExtractionTool(
      jest.fn().mockResolvedValue({
        ok: true,
        summary: {
          storeName: "Suya Spot",
          itemCount: 12,
          categoryCount: 3,
          gaps: ["No opening hours found."],
        },
        note: "preview shown",
      }),
    );

    const { events, emit } = captureEmit();
    const handled = await storeCreationFlow.tryRunExtractionTurn({
      sessionKey: SESSION_KEY,
      message: "create a store from this",
      extractionTool: tool,
      emit,
    });

    expect(handled).toBe(true);
    expect(tool.execute).toHaveBeenCalledWith({
      merchant_instructions: "create a store from this",
    });

    const messageEvent = findEvent(events, "message");
    expect((messageEvent?.data as { text: string }).text).toContain("Suya Spot");
    expect((messageEvent?.data as { text: string }).text).toContain("12 item(s)");
    expect((messageEvent?.data as { text: string }).text).toContain("No opening hours found.");
    expect(findEvent(events, "done")).toBeDefined();
    expect(
      events.find(
        (e) =>
          e.event === "tool_status" &&
          (e.data as { status: string }).status === "finished",
      ),
    ).toBeDefined();

    const context = await aiContextStore.getContext(SESSION_KEY);
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]).toEqual({
      role: "user",
      content: "create a store from this",
    });
  });

  it("emits the tool's error message when extraction fails", async () => {
    mockedGetDocument.mockResolvedValue({ filename: "menu.pdf", text: "x", truncated: false, uploadedAt: "2026-01-01" });
    const tool = makeExtractionTool(
      jest.fn().mockResolvedValue({ error: "No menu content found in this document." }),
    );

    const { events, emit } = captureEmit();
    const handled = await storeCreationFlow.tryRunExtractionTurn({
      sessionKey: SESSION_KEY,
      message: "create a store from this",
      extractionTool: tool,
      emit,
    });

    expect(handled).toBe(true);
    const errorEvent = findEvent(events, "error");
    expect((errorEvent?.data as { message: string }).message).toBe(
      "No menu content found in this document.",
    );
    expect(findEvent(events, "done")).toBeUndefined();

    const context = await aiContextStore.getContext(SESSION_KEY);
    expect(context.messages).toHaveLength(0);
  });

  it("propagates a thrown tool error for the controller to describe", async () => {
    mockedGetDocument.mockResolvedValue({ filename: "menu.pdf", text: "x", truncated: false, uploadedAt: "2026-01-01" });
    const tool = makeExtractionTool(
      jest.fn().mockRejectedValue(new Error("provider down")),
    );

    const { emit } = captureEmit();
    await expect(
      storeCreationFlow.tryRunExtractionTurn({
        sessionKey: SESSION_KEY,
        message: "create a store from this",
        extractionTool: tool,
        emit,
      }),
    ).rejects.toThrow("provider down");
  });
});