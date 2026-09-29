import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { anonymousPrincipal, asDevice, withIdentity } from "../../db/principal.js";
import { AttemptLimiter } from "../../shared/attempt-limiter.js";
import { AppError, authRequiredError, conflictError, forbiddenError, notFoundError, rateLimitedError, validationError } from "../../shared/errors.js";
import { verifyPin } from "../../shared/pin.js";
import * as authorization from "../authorization/authorization.service.js";
import { PosService, type DeviceActor } from "../pos/pos.service.js";
import type { PosLineInput } from "../pos/pos.types.js";
import { getPublicProduct, listPublicCategories, listPublicModifierGroups, listPublicProducts } from "../products/products.service.js";
import * as staffRepository from "../staff/staff.repository.js";
import * as posRepository from "../pos/pos.repository.js";
import * as storesRepository from "../stores/stores.repository.js";
import type { RegisterShiftRow } from "../stores/stores.types.js";
import * as repo from "./pos-devices.repository.js";
import type { ResolvedDevice, TillStaff } from "./pos-devices.types.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// Pairing codes: 16 digits. Wrong guesses are limited per client address;
// PINs are limited per device.
const pairingAttempts = new AttemptLimiter(10, 15 * 60 * 1000);
const pinAttempts = new AttemptLimiter(5, 5 * 60 * 1000);

export interface UserOperation {
  readonly userId: string;
  readonly requestId: string;
  readonly businessId: string;
}

export class PosDevicesService {
  private readonly pos: PosService;

  constructor(private readonly database: Database) {
    this.pos = new PosService(database);
  }

  // ── dashboard (signed-in merchant) ─────────────────────────────────────────

  /** A one-time 16-digit code, valid for 15 minutes, shown once; only its hash is kept. */
  async createPairingCode(operation: UserOperation, storeId: string, registerId: string) {
    return this.asUser(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, "register.manage");
      const code = Array.from({ length: 16 }, () => randomInt(0, 10)).join("");
      const created = await repo.createPairing(context, operation.businessId, storeId, registerId, sha256(code));
      if (!created) throw notFoundError("Active register not found");
      // A device may sell but not create sales channels, so the store's POS
      // channel is set up now, by the merchant.
      await posRepository.ensurePosChannel(context, operation.businessId, storeId);
      return { code, expiresAt: created.expiresAt.toISOString() };
    });
  }

  async listDevices(operation: UserOperation, registerId: string) {
    return this.asUser(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, "store.read");
      return (await repo.listDevices(context, operation.businessId, registerId)).map((row) => ({
        ...row,
        pairedAt: row.pairedAt?.toISOString() ?? null,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  async unpair(operation: UserOperation, storeId: string, registerId: string) {
    return this.asUser(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, "register.manage");
      return { revoked: await repo.revokeDevices(context, operation.businessId, storeId, registerId) };
    });
  }

  // ── device ─────────────────────────────────────────────────────────────────

  /** Swaps a pairing code for a long-lived device token, returned exactly once. */
  async pair(requestId: string, clientKey: string, input: { code: string; label?: string; platform?: string }) {
    const wait = pairingAttempts.lockedFor(clientKey);
    if (wait > 0) throw rateLimitedError(`Too many wrong codes. Try again in ${Math.ceil(wait / 60000)} minutes.`);
    const token = randomBytes(32).toString("base64url");
    const paired = await this.anonymous(requestId, (context) =>
      repo.pair(context, sha256(input.code), sha256(token), input.label ?? null, input.platform ?? null),
    );
    if (!paired) {
      pairingAttempts.fail(clientKey);
      throw validationError("That code is wrong or has expired. Generate a new one from Registers.");
    }
    pairingAttempts.succeed(clientKey);
    const device = await this.resolve(requestId, token);
    if (!device) throw conflictError("The register was removed while pairing. Try again.");
    return { deviceToken: token, session: await this.session(this.actor(device, requestId)) };
  }

  /** The device behind a token, or undefined when it's unknown, unpaired or its register is gone. */
  async resolve(requestId: string, token: string): Promise<ResolvedDevice | undefined> {
    return this.anonymous(requestId, (context) => repo.resolve(context, sha256(token)));
  }

  actor(device: ResolvedDevice, requestId: string): DeviceActor {
    return { ...device, requestId };
  }

  async session(device: DeviceActor) {
    return this.asDevice(device, "store.read", async (context) => {
      const row = await repo.session(context, device);
      if (!row) throw authRequiredError("This device is no longer paired.");
      return {
        register: { id: row.registerId, name: row.registerName },
        branch: { id: row.locationId, name: row.locationName },
        store: { id: row.storeId, name: row.storeName, slug: row.storeSlug },
        // One PIN opens the till for a session; the app can also ask per sale.
        pinMode: "per_session" as const,
      };
    });
  }

  /** Identifies the cashier from their PIN (or re-confirms a specific one). */
  async unlock(device: DeviceActor, pin: string, expectedStaffId?: string): Promise<TillStaff> {
    const wait = pinAttempts.lockedFor(device.deviceId);
    if (wait > 0) throw rateLimitedError(`Too many wrong PINs. Try again in ${Math.ceil(wait / 60000)} minutes.`);
    const staff = await this.asDevice(device, "register.operate", async (context) => {
      const candidates = await staffRepository.tillPins(context, device.businessId, device.locationId);
      for (const candidate of candidates) {
        if (expectedStaffId && candidate.id !== expectedStaffId) continue;
        if (await verifyPin(pin, candidate.pinHash)) return { id: candidate.id, name: candidate.displayName };
      }
      return undefined;
    });
    if (!staff) {
      pinAttempts.fail(device.deviceId);
      throw forbiddenError("That PIN isn't right.");
    }
    pinAttempts.succeed(device.deviceId);
    return staff;
  }

  async catalog(device: DeviceActor) {
    return this.asDevice(device, "product.read", async (context) => {
      const [products, categories] = await Promise.all([
        listPublicProducts(context, device.businessId, device.storeId),
        listPublicCategories(context, device.businessId),
      ]);
      return { products, categories };
    });
  }

  async product(device: DeviceActor, productId: string) {
    return this.asDevice(device, "product.read", async (context) => {
      const product = await getPublicProduct(context, device.businessId, device.storeId, productId);
      if (!product) throw notFoundError("Product not found");
      return product;
    });
  }

  async modifierGroups(device: DeviceActor, productId: string) {
    return this.asDevice(device, "product.read", async (context) => {
      const groups = await listPublicModifierGroups(context, device.businessId, device.storeId, productId, device.locationId);
      if (!groups) throw notFoundError("Product not found");
      return groups;
    });
  }

  async currentShift(device: DeviceActor) {
    return this.asDevice(device, "register.operate", async (context) => {
      const shift = await storesRepository.findOpenShift(context, device.businessId, device.registerId);
      return shift ? toShift(shift) : null;
    });
  }

  async shiftSummary(device: DeviceActor) {
    return this.asDevice(device, "register.operate", async (context) => {
      const shift = await storesRepository.findOpenShift(context, device.businessId, device.registerId);
      if (!shift) throw notFoundError("No open shift on this register");
      const row = await storesRepository.shiftSummary(context, device.businessId, shift.id);
      if (!row) throw notFoundError("No open shift on this register");
      const expected = BigInt(row.openingCashMinor) + BigInt(row.cashSalesMinor) + BigInt(row.cashMovementsMinor);
      return { shiftId: shift.id, ...row, expectedCashMinor: expected.toString() };
    });
  }

  async openShift(device: DeviceActor, staffId: string, openingCashMinor: number) {
    return this.asDevice(device, "register.operate", async (context) => {
      await this.requireTillStaff(context, device, staffId);
      if (await storesRepository.findOpenShift(context, device.businessId, device.registerId)) {
        throw conflictError("This register already has an open shift.");
      }
      const row = await storesRepository.openShift(context, device.businessId, device.storeId, device.registerId, null, String(openingCashMinor), {
        staffId,
        deviceId: device.deviceId,
      });
      if (!row) throw notFoundError("Active register not found");
      return toShift(row);
    });
  }

  async closeShift(device: DeviceActor, staffId: string, countedCashMinor: number, notes?: string) {
    return this.asDevice(device, "register.operate", async (context) => {
      await this.requireTillStaff(context, device, staffId);
      const open = await storesRepository.findOpenShift(context, device.businessId, device.registerId);
      if (!open) throw conflictError("There's no open shift on this register.");
      const row = await storesRepository.closeShift(context, device.businessId, device.storeId, open.id, null, String(countedCashMinor), notes, staffId);
      if (!row) throw conflictError("There's no open shift on this register.");
      return toShift(row);
    });
  }

  async preview(device: DeviceActor, items: PosLineInput[]) {
    return this.pos.previewAsDevice(device, items);
  }

  /** A sale at the till, on the register's open shift, attributed to the cashier. */
  async charge(
    device: DeviceActor,
    input: { items: PosLineInput[]; paymentMethod: string; staffId: string; idempotencyKey: string; customerId: string | null },
  ) {
    const shiftId = await this.asDevice(device, "order.create", async (context) => {
      await this.requireTillStaff(context, device, input.staffId);
      if (input.customerId && !(await repo.isCustomer(context, device.businessId, input.customerId))) {
        throw validationError("That customer wasn't found.");
      }
      const shift = await storesRepository.findOpenShift(context, device.businessId, device.registerId);
      if (!shift) throw conflictError("Open the register before taking payment.");
      return shift.id;
    });
    return this.pos.chargeAsDevice(device, {
      items: input.items,
      paymentMethod: input.paymentMethod,
      registerShiftId: shiftId,
      bookingId: null,
      tip: null,
      operatorStaffId: input.staffId,
      idempotencyKey: input.idempotencyKey,
      customerPartyId: input.customerId,
    });
  }

  async orders(device: DeviceActor, status: "all" | "open" | "fulfilled", limit: number) {
    return this.asDevice(device, "order.read", async (context) =>
      (await repo.recentOrders(context, device.businessId, device.locationId, status === "all" ? null : status, limit)).map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  }

  async customers(device: DeviceActor, search: string | null, limit: number) {
    return this.asDevice(device, "party.read", (context) => repo.customers(context, device.businessId, search, limit));
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private async requireTillStaff(context: DatabaseContext, device: DeviceActor, staffId: string): Promise<void> {
    const allowed = await staffRepository.tillPins(context, device.businessId, device.locationId);
    if (!allowed.some((row) => row.id === staffId)) throw forbiddenError("That person can't use this till.");
  }

  private async asDevice<T>(device: DeviceActor, permission: string, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    return this.guard(() =>
      withDatabaseContext(this.database, asDevice(device.requestId, device.deviceId, device.businessId), async (context) => {
        await authorization.requirePermission(context, device.businessId, permission);
        return work(context);
      }),
    );
  }

  private async asUser<T>(operation: UserOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    return this.guard(() =>
      withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work),
    );
  }

  private async anonymous<T>(requestId: string, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    return this.guard(() => withDatabaseContext(this.database, anonymousPrincipal(requestId), work));
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toShift(row: RegisterShiftRow) {
  return {
    id: row.id,
    registerId: row.registerId,
    status: row.status,
    openingCashMinor: row.openingCashMinor,
    expectedCashMinor: row.expectedCashMinor,
    countedCashMinor: row.countedCashMinor,
    varianceMinor: row.varianceMinor,
    openedByStaffId: row.openedByStaffId ?? null,
    closedByStaffId: row.closedByStaffId ?? null,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}
