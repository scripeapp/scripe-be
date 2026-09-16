/**
 * Tests for StoreEngagementService — monthly store-owner re-engagement nudges.
 */

/// <reference types="jest" />

import { StoreEngagementService } from "../services/store-engagement.service";
import {
  createMockSupabaseClient,
  createMockQueryBuilder,
} from "./test-utils";

jest.mock("../config/supabase", () => ({ supabaseAdmin: {}, supabase: {} }));
jest.mock("../services/email.service", () => ({
  emailService: { send: jest.fn().mockResolvedValue(undefined) },
}));

import { emailService } from "../services/email.service";

const owner = {
  id: "user-1",
  email: "owner@example.com",
  name: "Aisha",
  preferences: {},
};

const liveStore = {
  id: "store-1",
  name: "My Store",
  is_live: true,
  user_id: "user-1",
  moderation_status: "approved",
};

const sendMock = emailService.send as jest.Mock;
const currentMonth = new Date().toISOString().slice(0, 7);

describe("StoreEngagementService", () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let service: StoreEngagementService;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    service = new StoreEngagementService(mockSupabase as any);
  });

  afterEach(() => jest.clearAllMocks());

  it("emails a live store that has never made a sale", async () => {
    mockSupabase.from
      .mockReturnValueOnce(createMockQueryBuilder([liveStore])) // loadStores
      .mockReturnValueOnce(createMockQueryBuilder(owner)) // loadOwner
      .mockReturnValueOnce(createMockQueryBuilder([])) // storeHasSales -> none
      .mockReturnValueOnce(createMockQueryBuilder(null)); // recordNudgeSent

    await service.processMonthlyStoreNudges();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: owner.email, type: "platform" }),
    );
  });

  it("skips a live store that already has sales", async () => {
    mockSupabase.from
      .mockReturnValueOnce(createMockQueryBuilder([liveStore]))
      .mockReturnValueOnce(createMockQueryBuilder(owner))
      .mockReturnValueOnce(createMockQueryBuilder([{ id: "order-1" }]));

    await service.processMonthlyStoreNudges();

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("emails the activation steps for an inactive store", async () => {
    const inactiveStore = { ...liveStore, is_live: false };
    mockSupabase.from
      .mockReturnValueOnce(createMockQueryBuilder([inactiveStore]))
      .mockReturnValueOnce(createMockQueryBuilder(owner))
      .mockReturnValueOnce(createMockQueryBuilder(null)); // recordNudgeSent

    await service.processMonthlyStoreNudges();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("3 quick steps"),
      }),
    );
  });

  it("does not nudge a moderation-rejected store", async () => {
    const rejectedStore = { ...liveStore, moderation_status: "rejected" };
    mockSupabase.from.mockReturnValueOnce(
      createMockQueryBuilder([rejectedStore]),
    );

    await service.processMonthlyStoreNudges();

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not send twice in the same month", async () => {
    const ownerNudgedThisMonth = {
      ...owner,
      preferences: { store_nudges: { "store-1": { no_sales: currentMonth } } },
    };
    mockSupabase.from
      .mockReturnValueOnce(createMockQueryBuilder([liveStore]))
      .mockReturnValueOnce(createMockQueryBuilder(ownerNudgedThisMonth))
      .mockReturnValueOnce(createMockQueryBuilder([])); // storeHasSales -> none

    await service.processMonthlyStoreNudges();

    expect(sendMock).not.toHaveBeenCalled();
  });
});
