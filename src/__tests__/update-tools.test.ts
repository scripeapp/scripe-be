import { buildUpdateEventTool } from "../services/ai/tools/update-event.tool";
import { buildUpdateEventTypeTool } from "../services/ai/tools/update-event-type.tool";
import { buildUpdateProductTool } from "../services/ai/tools/update-product.tool";
import { getAction } from "../services/ai/pending-action.store";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const SESSION_KEY = `agent:${BUSINESS_ID}:${USER_ID}`;

function captureEmit() {
  const events: Array<{ event: string; data: unknown }> = [];
  const emit = (event: string, data: unknown) => {
    events.push({ event, data });
  };
  return { events, emit: emit as (event: string, data: unknown) => void };
}

function eventsOf(events: Array<{ event: string; data: unknown }>) {
  const action = events.find((e) => e.event === "action");
  const questions = events.find((e) => e.event === "questions");
  return {
    action: action?.data as
      | {
          actionId: string;
          type: string;
          summary: { title: string; cta: string };
        }
      | undefined,
    questions: questions?.data as
      | {
          questionSetId: string;
          questions: Array<{ key: string }>;
        }
      | undefined,
  };
}

describe("update_event tool", () => {
  it("asks which event to change when no identity is given", async () => {
    const { events, emit } = captureEmit();
    const tool = buildUpdateEventTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    const result = await tool.execute({} as never);

    expect(result.ok).toBe(true);
    const { questions } = eventsOf(events);
    expect(questions?.questions.map((q) => q.key)).toEqual(["event_name"]);
    expect(events.some((e) => e.event === "action")).toBe(false);
  });

  it("asks what to change when only the identity is given", async () => {
    const { events, emit } = captureEmit();
    const tool = buildUpdateEventTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    const result = await tool.execute({ event_name: "Hilaq Fest" } as never);

    expect(result.ok).toBe(true);
    const { questions } = eventsOf(events);
    expect(questions?.questions.map((q) => q.key)).toEqual(["changes"]);
  });

  it("emits a pending action once a change is specified", async () => {
    const { events, emit } = captureEmit();
    const tool = buildUpdateEventTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    const result = await tool.execute({
      event_name: "Hilaq Fest",
      new_name: "Hilaq Fest 2",
      start_date: "2026-10-01",
    } as never);

    expect(result.ok).toBe(true);
    const { action } = eventsOf(events);
    expect(action?.type).toBe("event.update");
    expect(action?.summary.title).toBe("Update event: Hilaq Fest");
    expect(action?.summary.cta).toBe("Update event");

    const stored = await getAction(action!.actionId);
    expect(stored?.status).toBe("pending");
    expect((stored?.payload as { new_name: string }).new_name).toBe(
      "Hilaq Fest 2",
    );
  });

  it("rejects hallucinated fields at the model boundary", () => {
    const { emit } = captureEmit();
    const tool = buildUpdateEventTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    expect(
      tool.parameters.safeParse({
        event_name: "Hilaq Fest",
        event_url: "https://hilaq.com/fest",
        made_up_column: true,
      }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({
        event_name: "Hilaq Fest",
        venue: { placeDesc: "Eko Hotel" },
      }).success,
    ).toBe(true);
  });
});

describe("update_event_type tool", () => {
  it("emits a pending action for a duration change", async () => {
    const { events, emit } = captureEmit();
    const tool = buildUpdateEventTypeTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    const result = await tool.execute({
      title: "Consultation",
      duration_minutes: 60,
    } as never);

    expect(result.ok).toBe(true);
    const { action } = eventsOf(events);
    expect(action?.type).toBe("scheduling.event_type.update");
    expect(action?.summary.title).toBe("Update booking type: Consultation");
    expect(action?.summary.cta).toBe("Update booking type");
  });

  it("rejects unknown fields", () => {
    const { emit } = captureEmit();
    const tool = buildUpdateEventTypeTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    expect(
      tool.parameters.safeParse({
        title: "Consultation",
        fake_setting: "x",
      }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({
        title: "Consultation",
        location_type: "google_meet",
      }).success,
    ).toBe(true);
  });
});

describe("update_product tool", () => {
  it("emits a pending action for a price change", async () => {
    const { events, emit } = captureEmit();
    const tool = buildUpdateProductTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    const result = await tool.execute({
      name: "Hoodie",
      price: 4500,
      currency: "NGN",
    } as never);

    expect(result.ok).toBe(true);
    const { action } = eventsOf(events);
    expect(action?.type).toBe("product.update");
    expect(action?.summary.title).toBe("Update product: Hoodie");
    expect(action?.summary.cta).toBe("Update product");
  });

  it("rejects unknown fields", () => {
    const { emit } = captureEmit();
    const tool = buildUpdateProductTool({
      sessionKey: SESSION_KEY,
      businessId: BUSINESS_ID,
      userId: USER_ID,
      emit,
    });

    expect(
      tool.parameters.safeParse({ name: "Hoodie", category_id: "x" }).success,
    ).toBe(false);
    expect(
      tool.parameters.safeParse({ name: "Hoodie", status: "published" })
        .success,
    ).toBe(true);
  });
});