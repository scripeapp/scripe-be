/// <reference types="jest" />

import { scryptSync } from "node:crypto";
import { PinService } from "../services/pin.service";
import {
  createMockQueryBuilder,
  createMockSupabaseClient,
} from "./test-utils";

const businessId = "2d0acabc-2b37-4ca7-99b2-1d34e3512ec1";

const PEPPER = "hilaq-pin-pepper-v1";

function storedPinHash(pin: string): string {
  const salt = "a".repeat(32);
  const hash = scryptSync(`${pin}:${PEPPER}`, salt, 32).toString("hex");
  return `${salt}.${hash}`;
}

interface PinRow {
  id: string;
  has_pin: boolean;
  pin_hash: string | null;
  pin_attempts: number | null;
  pin_locked_until: string | null;
}

function createPinRow(overrides: Partial<PinRow> = {}): PinRow {
  return {
    id: "va-1",
    has_pin: true,
    pin_hash: storedPinHash("1234"),
    pin_attempts: 0,
    pin_locked_until: null,
    ...overrides,
  };
}

describe("PinService", () => {
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;
  let service: PinService;

  beforeEach(() => {
    process.env.PIN_PEPPER = PEPPER;
    mockSupabase = createMockSupabaseClient();
    service = new PinService(mockSupabase as any);
  });

  afterEach(() => jest.clearAllMocks());

  describe("verify", () => {
    it("rejects when no PIN has been set", async () => {
      mockSupabase.from.mockReturnValueOnce(createMockQueryBuilder(null));

      await expect(service.verify(businessId, "1234")).rejects.toMatchObject({
        statusCode: 400,
        details: { code: "PIN_NOT_SET" },
      });
    });

    it("rejects when the PIN is locked and reports the lock expiry", async () => {
      const lockedUntil = new Date(Date.now() + 60_000).toISOString();
      mockSupabase.from.mockReturnValueOnce(
        createMockQueryBuilder(
          createPinRow({ pin_locked_until: lockedUntil }),
        ),
      );

      await expect(service.verify(businessId, "1234")).rejects.toMatchObject({
        statusCode: 423,
        details: { code: "PIN_LOCKED", locked_until: lockedUntil },
      });
    });

    it("accepts the correct PIN and resets the attempt counter", async () => {
      const row = createPinRow({ pin_attempts: 2 });
      const builder = createMockQueryBuilder(row);
      mockSupabase.from.mockReturnValue(builder);

      await expect(service.verify(businessId, "1234")).resolves.toBeUndefined();

      expect(builder.update).toHaveBeenCalledWith({
        pin_attempts: 0,
        pin_locked_until: null,
      });
    });

    it("counts down remaining attempts and locks after three failures", async () => {
      const row = createPinRow();
      const builder = createMockQueryBuilder(row);
      mockSupabase.from.mockReturnValue(builder);

      await expect(service.verify(businessId, "0000")).rejects.toMatchObject({
        statusCode: 401,
        details: { code: "PIN_INCORRECT", remaining_attempts: 2 },
      });

      row.pin_attempts = 1;
      await expect(service.verify(businessId, "0000")).rejects.toMatchObject({
        statusCode: 401,
        details: { code: "PIN_INCORRECT", remaining_attempts: 1 },
      });

      row.pin_attempts = 2;
      await expect(service.verify(businessId, "0000")).rejects.toMatchObject({
        statusCode: 401,
        details: { code: "PIN_INCORRECT", remaining_attempts: 0 },
      });

      expect(builder.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pin_attempts: 3,
          pin_locked_until: expect.any(String),
        }),
      );

      const lockedUntil = new Date(Date.now() + 60_000).toISOString();
      row.pin_locked_until = lockedUntil;
      await expect(service.verify(businessId, "0000")).rejects.toMatchObject({
        statusCode: 423,
        details: { code: "PIN_LOCKED" },
      });
    });
  });

  describe("resetLockedPinWithBvn", () => {
    it("unlocks the PIN when the BVN last 4 match the approved KYC record", async () => {
      const builder = createMockQueryBuilder(null);
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(createPinRow()))
        .mockReturnValueOnce(
          createMockQueryBuilder({ document_number: "*******8901" }),
        )
        .mockReturnValueOnce(builder);

      await expect(
        service.resetLockedPinWithBvn(businessId, "8901"),
      ).resolves.toBeUndefined();

      expect(builder.update).toHaveBeenCalledWith({
        pin_attempts: 0,
        pin_locked_until: null,
      });
    });

    it("rejects a BVN last 4 that does not match the approved KYC record", async () => {
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(createPinRow()))
        .mockReturnValueOnce(
          createMockQueryBuilder({ document_number: "*******8901" }),
        );

      await expect(
        service.resetLockedPinWithBvn(businessId, "0000"),
      ).rejects.toMatchObject({
        statusCode: 400,
        details: { code: "BVN_MISMATCH" },
      });
    });

    it("rejects when no approved BVN KYC record exists", async () => {
      mockSupabase.from
        .mockReturnValueOnce(createMockQueryBuilder(createPinRow()))
        .mockReturnValueOnce(createMockQueryBuilder(null));

      await expect(
        service.resetLockedPinWithBvn(businessId, "8901"),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});