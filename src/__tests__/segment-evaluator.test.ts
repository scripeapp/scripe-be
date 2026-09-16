import { evaluateSegmentConditions } from "../services/segment-evaluator";
import { createMockSupabaseClient } from "./test-utils";

function makeBuilder(result: { data?: any; error?: any }) {
  const chain: any = {};
  const methods = ["select", "eq", "neq", "order", "range"];

  methods.forEach((method) => {
    chain[method] = jest.fn().mockReturnValue(chain);
  });

  chain.then = jest.fn((resolve: (value: any) => void) =>
    resolve({
      data: result.data ?? null,
      error: result.error ?? null,
    }),
  );

  return chain;
}

describe("segment-evaluator", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("supports nested groups and mixed AND/OR logic correctly", async () => {
    const mockSupabase = createMockSupabaseClient();
    const page1 = makeBuilder({
      data: [
        {
          id: "1",
          name: "Alice Walker",
          email: "alice@example.com",
          phone: null,
          source: "manual",
          status: "marketing",
          created_at: "2026-01-05T00:00:00.000Z",
          updated_at: "2026-01-05T00:00:00.000Z",
        },
        {
          id: "2",
          name: "Bob Stone",
          email: "bob@vip.com",
          phone: null,
          source: "manual",
          status: "marketing",
          created_at: "2026-01-05T00:00:00.000Z",
          updated_at: "2026-01-05T00:00:00.000Z",
        },
        {
          id: "3",
          name: "Carol North",
          email: "carol@vip.com",
          phone: null,
          source: "manual",
          status: "unsubscribed",
          created_at: "2026-01-05T00:00:00.000Z",
          updated_at: "2026-01-05T00:00:00.000Z",
        },
      ],
    });
    const page2 = makeBuilder({ data: [] });

    let unifiedCalls = 0;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table !== "crm_contacts_unified") {
        throw new Error(`Unexpected table ${table}`);
      }

      unifiedCalls += 1;
      return unifiedCalls === 1 ? page1 : page2;
    });

    const result = await evaluateSegmentConditions(
      mockSupabase as any,
      "business-1",
      "AND",
      [
        {
          id: "group-1",
          logic: "AND",
          conditions: [
            { id: "c-1", field: "status", operator: "equals", value: "marketing" },
          ],
          groups: [
            {
              id: "group-2",
              logic: "OR",
              conditions: [
                { id: "c-2", field: "name", operator: "contains", value: "alice" },
                { id: "c-3", field: "email", operator: "contains", value: "vip.com" },
              ],
              groups: [],
            },
          ],
        },
      ],
      { limit: 10 },
    );

    expect(result.count).toBe(2);
    expect(result.sample.map((contact) => contact.id)).toEqual(["1", "2"]);
    expect(page1.eq).toHaveBeenCalledWith("business_id", "business-1");
    expect(page1.neq).toHaveBeenCalledWith("status", "blocked");
  });

  it("falls back to contacts table when the unified view is unavailable", async () => {
    const mockSupabase = createMockSupabaseClient();
    const unifiedBuilder = makeBuilder({
      error: { message: 'relation "crm_contacts_unified" does not exist' },
    });
    const fallbackPage1 = makeBuilder({
      data: [
        {
          id: "9",
          name: "Fallback User",
          email: "fallback@example.com",
          phone: null,
          status: "marketing",
          created_at: "2026-01-05T00:00:00.000Z",
          updated_at: "2026-01-05T00:00:00.000Z",
        },
      ],
    });
    const fallbackPage2 = makeBuilder({ data: [] });

    let fallbackCalls = 0;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "crm_contacts_unified") {
        return unifiedBuilder;
      }

      if (table === "contacts") {
        fallbackCalls += 1;
        return fallbackCalls === 1 ? fallbackPage1 : fallbackPage2;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const result = await evaluateSegmentConditions(
      mockSupabase as any,
      "business-1",
      "AND",
      [
        {
          id: "group-1",
          logic: "AND",
          conditions: [
            { id: "c-1", field: "email", operator: "contains", value: "fallback" },
          ],
          groups: [],
        },
      ],
      { limit: 10 },
    );

    expect(result.count).toBe(1);
    expect(result.sample[0]).toMatchObject({
      id: "9",
      email: "fallback@example.com",
      source: null,
    });
  });
});
