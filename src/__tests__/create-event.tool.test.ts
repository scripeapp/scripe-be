import { buildCreateEventTool } from "../services/ai/tools/create-event.tool";
import { executePendingAction } from "../services/ai/action-executor.service";
import { getAction } from "../services/ai/pending-action.store";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_KEY = `agent:${BUSINESS_ID}:${USER_ID}`;

function captureEmit() {
  const events: Array<{ event: string; data: unknown }> = [];
  const emit = (event: string, data: unknown) => {
    events.push({ event, data });
  };
  return { events, emit: emit as (event: any, data: unknown) => void };
}

describe("create_event tool", () => {
  it("asks for missing timing/location via a questions event", async () => {
    const { events, emit } = captureEmit();
    const tool = buildCreateEventTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    const result = await tool.execute({
      event_name: "Hilaq Fest",
      event_description: "A music festival",
    });

    expect(result.ok).toBe(true);
    const questionsEvent = events.find((e) => e.event === "questions");
    expect(questionsEvent).toBeDefined();
    const data = questionsEvent?.data as {
      questionSetId: string;
      questions: Array<{ key: string; question: string; type: string }>;
    };
    expect(data.questionSetId).toBeTruthy();
    expect(data.questions.map((q) => q.key)).toEqual(
      expect.arrayContaining(["start_date", "start_time", "location"]),
    );
    expect(events.some((e) => e.event === "action")).toBe(false);
  });

  it("emits a pending action once the payload is complete", async () => {
    const { events, emit } = captureEmit();
    const tool = buildCreateEventTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    const result = await tool.execute({
      event_name: "Hilaq Fest",
      event_description: "A music festival",
      start_date: "2026-09-12",
      start_time: "16:00",
      end_date: "2026-09-12",
      end_time: "22:00",
      venue: { placeDesc: "Eko Hotel" },
      tickets: [
        {
          ticket_name: "General",
          ticket_price: 5000,
          available_quantity: 100,
        },
      ],
    } as never);

    expect(result.ok).toBe(true);
    const actionEvent = events.find((e) => e.event === "action");
    expect(actionEvent).toBeDefined();
    const data = actionEvent?.data as {
      actionId: string;
      type: string;
      summary: { title: string; cta: string };
      options: Array<{ actionId: string }>;
    };
    expect(data.type).toBe("event.create");
    expect(data.summary.title).toBe("Create event: Hilaq Fest");
    expect(data.summary.cta).toBe("Create event");

    const stored = await getAction(data.actionId);
    expect(stored?.status).toBe("pending");
    expect(stored?.businessId).toBe(BUSINESS_ID);
    expect((stored?.payload as { event_name: string }).event_name).toBe(
      "Hilaq Fest",
    );
  });

  it("fills the event_tickets NOT-NULL columns with sensible defaults", () => {
    const { emit } = captureEmit();
    const tool = buildCreateEventTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    const parsed = tool.parameters.safeParse({
      event_name: "X",
      start_date: "2026-09-12",
      start_time: "16:00",
      tickets: [
        {
          ticket_name: "General",
          ticket_price: 5000,
          available_quantity: 100,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const ticket = (parsed.data as { tickets?: unknown[] }).tickets?.[0] as
      | { ticket_is_limited_stock?: boolean; quantity_sold?: number }
      | undefined;
    expect(ticket?.ticket_is_limited_stock).toBe(true);
    expect(ticket?.quantity_sold).toBe(0);
  });

  it("rejects malformed dates and times", () => {
    const { emit } = captureEmit();
    const tool = buildCreateEventTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    expect(
      tool.parameters.safeParse({
        event_name: "X",
        start_date: "12/09/2026",
        start_time: "4pm",
      }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({
        event_name: "X",
        start_date: "2026-09-12",
        start_time: "16:00",
      }).success,
    ).toBe(true);
  });
});

describe("action executor", () => {
  it("creates the event through EventService and returns a summary", async () => {
    const single = jest
      .fn()
      .mockResolvedValue({
        data: { id: "event-123", event_name: "Hilaq Fest", status: "draft" },
        error: null,
      });
    const ticketsSelect = jest.fn().mockResolvedValue({
      data: [{ id: "ticket-1" }],
      error: null,
    });
    const auditInsert = jest.fn().mockResolvedValue({ error: null });
    const from = jest.fn((table: string) => {
      if (table === "events") {
        return { insert: jest.fn(() => ({ select: () => ({ single }) })) };
      }
      if (table === "event_tickets") {
        return {
          insert: jest.fn(() => ({ select: () => ticketsSelect })),
        };
      }
      if (table === "audit_logs") {
        return { insert: auditInsert };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const outcome = await executePendingAction(
      { from } as never,
      {
      actionId: "action-1",
      type: "event.create",
      businessId: BUSINESS_ID,
      userId: USER_ID,
      payload: {
        event_name: "Hilaq Fest",
        start_date: "2026-09-12",
        start_time: "16:00",
      },
      summary: { title: "Create event", body: "", label: "", cta: "", signal: 0 },
      status: "pending",
      createdAt: new Date().toISOString(),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      eventId: "event-123",
      eventName: "Hilaq Fest",
      status: "draft",
      ticketCount: 0,
      eventUrl: null,
      url: null,
      editUrl: expect.stringContaining("/events/edit/event-123"),
    });
    expect(auditInsert).toHaveBeenCalled();
  });

  it("rejects unknown action types", async () => {
    await expect(
      executePendingAction({} as never, {
        actionId: "action-2",
        type: "circle.create",
        businessId: BUSINESS_ID,
        userId: USER_ID,
        payload: {},
        summary: { title: "", body: "", label: "", cta: "", signal: 0 },
        status: "pending",
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("Unknown action type");
  });
});