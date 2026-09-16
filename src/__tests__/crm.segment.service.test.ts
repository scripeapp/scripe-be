jest.mock("../services/segment-evaluator", () => ({
  evaluateSegmentConditions: jest.fn(),
}));

import CRMService from "../services/crm.service";
import { evaluateSegmentConditions } from "../services/segment-evaluator";
import { createMockSupabaseClient } from "./test-utils";

const mockEvaluateSegmentConditions = evaluateSegmentConditions as jest.MockedFunction<
  typeof evaluateSegmentConditions
>;

function makeBuilder(result: { data?: any; error?: any }) {
  const chain: any = {};
  const methods = [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "neq",
    "order",
    "limit",
    "range",
  ];

  methods.forEach((method) => {
    chain[method] = jest.fn().mockReturnValue(chain);
  });

  chain.single = jest.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });

  chain.then = jest.fn((resolve: (value: any) => void) =>
    resolve({
      data: result.data ?? null,
      error: result.error ?? null,
    }),
  );

  return chain;
}

describe("CRMService segment mutations", () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let service: CRMService;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    service = new CRMService(mockSupabase as any);
    jest.clearAllMocks();
  });

  it("stores the evaluated contact count when creating a dynamic segment", async () => {
    const segmentsBuilder = makeBuilder({
      data: {
        id: "segment-1",
        contact_count: 2,
      },
    });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "segments") {
        return segmentsBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockEvaluateSegmentConditions.mockResolvedValue({
      count: 2,
      sample: [{ id: "contact-1" }, { id: "contact-2" }],
    });

    (service as any).addContactsToSegment = jest.fn().mockResolvedValue(undefined);

    await service.createSegment("business-1", "user-1", {
      name: "Dynamic segment",
      type: "dynamic",
      logic: "AND",
      groups: [{ id: "group-1", logic: "AND", conditions: [], groups: [] }],
    });

    expect(mockEvaluateSegmentConditions).toHaveBeenCalledWith(
      mockSupabase,
      "business-1",
      "AND",
      [{ id: "group-1", logic: "AND", conditions: [], groups: [] }],
      { countOnly: false },
    );
    expect(segmentsBuilder.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        contact_count: 2,
      }),
    ]);
  });

  it("fails dynamic segment creation instead of silently saving an empty segment when evaluation fails", async () => {
    const segmentsBuilder = makeBuilder({ data: { id: "segment-1" } });

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "segments") {
        return segmentsBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockEvaluateSegmentConditions.mockRejectedValue(new Error("Evaluator exploded"));

    await expect(
      service.createSegment("business-1", "user-1", {
        name: "Dynamic segment",
        type: "dynamic",
        logic: "AND",
        groups: [{ id: "group-1", logic: "AND", conditions: [], groups: [] }],
      }),
    ).rejects.toThrow("Evaluator exploded");

    expect(segmentsBuilder.insert).not.toHaveBeenCalled();
  });

  it("fails dynamic segment updates before saving when membership recalculation fails", async () => {
    const existingSegmentBuilder = makeBuilder({
      data: {
        id: "segment-1",
        user_id: "user-1",
        type: "dynamic",
        logic: "AND",
        groups: [{ id: "group-1", logic: "AND", conditions: [], groups: [] }],
        contact_count: 3,
      },
    });
    const updateBuilder = makeBuilder({
      data: {
        id: "segment-1",
      },
    });

    let segmentsCalls = 0;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === "segments") {
        segmentsCalls += 1;
        return segmentsCalls === 1 ? existingSegmentBuilder : updateBuilder;
      }

      if (table === "contact_segments") {
        return makeBuilder({ data: null });
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockEvaluateSegmentConditions.mockRejectedValue(
      new Error("Membership recalculation failed"),
    );

    await expect(
      service.updateSegment("business-1", "segment-1", {
        groups: [{ id: "group-2", logic: "AND", conditions: [], groups: [] }],
      }),
    ).rejects.toThrow("Membership recalculation failed");

    expect(updateBuilder.update).not.toHaveBeenCalled();
  });
});
