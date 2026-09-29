import type { Database } from "../../db/database.types.js";
import { postCaptureJournal } from "../payments/payments.service.js";
import * as receiptsRepo from "../receipts/receipts.repository.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { asDevice, withIdentity } from "../../db/principal.js";
import { AppError, conflictError, notFoundError, validationError } from "../../shared/errors.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as bookingsRepo from "../bookings/bookings.repository.js";
import { toServiceBooking, type BookingRow, type BookingStatus, type ServiceBooking } from "../bookings/bookings.types.js";
import * as repo from "./pos.repository.js";
import type { PosLineInput, PosOrderPreview, PosOrderSummary, PricedPosLine } from "./pos.types.js";

interface ChargeInput {
  readonly storeId: string;
  readonly locationId: string;
  readonly paymentMethod: string;
  readonly registerShiftId: string | null;
  readonly bookingId: string | null;
  readonly items: PosLineInput[];
  readonly tip: { amountMinor: number; staffId: string | null } | null;
  /** Who rang the sale up at a device till, and which device. */
  readonly operatorStaffId?: string | null;
  readonly posDeviceId?: string | null;
  /** A retried sale with the same key replays the original order. */
  readonly idempotencyKey?: string | null;
  readonly customerPartyId?: string | null;
}

/** A paired till device acting as its register. */
export interface DeviceActor {
  readonly deviceId: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly registerId: string;
  readonly locationId: string;
  readonly requestId: string;
}

export class PosService {
  constructor(private readonly database: Database) {}

  /** Today's arrived + in-service bookings for the till panel. */
  async tillBookings(userId: string, requestId: string, storeId: string): Promise<ServiceBooking[]> {
    return this.withBusiness(userId, requestId, storeId, "booking.read", async (context, businessId) => {
      const rows = await repo.tillBookings(context, businessId, storeId);
      return rows.map(toServiceBooking);
    });
  }

  /** Price a ticket without touching the ledger — used to preview the till total. */
  async preview(
    userId: string,
    requestId: string,
    storeId: string,
    locationId: string,
    items: PosLineInput[],
  ): Promise<PosOrderPreview> {
    return this.withBusiness(userId, requestId, storeId, "order.create", (context, businessId) =>
      this.previewIn(context, businessId, storeId, locationId, items),
    );
  }

  /** Same pricing, as a paired device at its own branch. */
  async previewAsDevice(device: DeviceActor, items: PosLineInput[]): Promise<PosOrderPreview> {
    return this.withDevice(device, "order.create", (context) =>
      this.previewIn(context, device.businessId, device.storeId, device.locationId, items),
    );
  }

  /** Charge at a paired device: the device's own store and branch, attributed to the cashier. */
  async chargeAsDevice(device: DeviceActor, input: Omit<ChargeInput, "storeId" | "locationId" | "posDeviceId">): Promise<PosOrderSummary> {
    return this.withDevice(device, "order.create", (context) =>
      this.chargeIn(context, device.businessId, null, {
        ...input,
        storeId: device.storeId,
        locationId: device.locationId,
        posDeviceId: device.deviceId,
      }),
    );
  }

  private async previewIn(
    context: DatabaseContext,
    businessId: string,
    storeId: string,
    locationId: string,
    items: PosLineInput[],
  ): Promise<PosOrderPreview> {
    const [settings, currency] = await Promise.all([
      this.locationSettings(context, businessId, locationId),
      repo.storeCurrency(context, businessId, storeId),
    ]);
    const priced = await repo.pricePosLines(context, businessId, items, locationId, currency);
    const totals = this.computeTotals(priced, settings);
    return {
      subtotal: this.minorToNumber(totals.subtotalMinor),
      discount: 0,
      taxAmount: this.minorToNumber(totals.taxMinor),
      serviceChargeAmount: this.minorToNumber(totals.serviceChargeMinor),
      total: this.minorToNumber(totals.totalMinor),
    };
  }

  /** Charge a ticket at the till: prices lines, creates the order, captures payment, and completes the attached booking (idempotent per booking). */
  async charge(userId: string, requestId: string, input: ChargeInput): Promise<PosOrderSummary> {
    return this.withBusiness(userId, requestId, input.storeId, "order.create", (context, businessId) =>
      this.chargeIn(context, businessId, userId, input),
    );
  }

  private async chargeIn(
    context: DatabaseContext,
    businessId: string,
    userId: string | null,
    input: ChargeInput,
  ): Promise<PosOrderSummary> {
    if (input.idempotencyKey) {
      const replay = await repo.orderByIdempotencyKey(context, businessId, input.idempotencyKey);
      if (replay) return this.orderSummary(context, businessId, replay);
    }
    const existing = input.bookingId ? await repo.bookingChargeState(context, businessId, input.bookingId) : undefined;
    if (input.bookingId && !existing) throw notFoundError("Booking not found");
    if (input.bookingId && existing?.orderId) {
      return this.existingSummary(context, businessId, input.bookingId, existing.orderId, existing.status);
    }

    await authorization.requirePermission(context, businessId, "payment.manage");
    if (input.registerShiftId) {
      await repo.validateOpenShift(context, businessId, input.storeId, input.locationId, input.registerShiftId);
    }

    const [settings, currency, channelId] = await Promise.all([
      this.locationSettings(context, businessId, input.locationId),
      repo.storeCurrency(context, businessId, input.storeId),
      repo.ensurePosChannel(context, businessId, input.storeId),
    ]);

    let booking: BookingRow | undefined;
    let lines = input.items;
    if (input.bookingId) {
      await authorization.requirePermission(context, businessId, "booking.update");
      booking = await bookingsRepo.findById(context, businessId, input.bookingId);
      if (!booking) throw notFoundError("Booking not found");
      lines = [...booking.items.map((item): PosLineInput => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: 1,
        modifierOptionIds: item.modifierOptionIds,
      })), ...lines];
    }

    const priced = await repo.pricePosLines(context, businessId, lines, input.locationId, currency);
    const attributed = booking
      ? priced.map((line, index) =>
          index < booking.items.length ? { ...line, staffId: booking.items[index]!.staffId } : line,
        )
      : priced;

    const totals = this.computeTotals(attributed, settings);
    const order = await repo.createPosOrder(context, businessId, userId, {
      storeId: input.storeId,
      channelId,
      locationId: input.locationId,
      assetCode: currency,
      lines: attributed,
      taxMinor: totals.taxMinor,
      serviceChargeMinor: totals.serviceChargeMinor,
      totalMinor: totals.totalMinor,
      registerShiftId: input.registerShiftId,
      operatorStaffId: input.operatorStaffId ?? null,
      posDeviceId: input.posDeviceId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      customerPartyId: input.customerPartyId ?? null,
    });

    let tip: { amountMinor: bigint; staffId: string | null } | null = null;
    if (input.tip && input.tip.amountMinor > 0) {
      tip = {
        amountMinor: BigInt(input.tip.amountMinor),
        staffId: input.tip.staffId ?? bookedStaff(booking) ?? null,
      };
      if (input.bookingId) {
        await repo.upsertBookingTip(context, businessId, input.bookingId, order.id, tip.staffId, tip.amountMinor);
      } else {
        throw validationError("Tip requires a booking to attribute to");
      }
    }

    // Money tendered at the till covers the ticket plus the gratuity.
    const tenderedMinor = totals.totalMinor + (tip?.amountMinor ?? 0n);
    const paymentId = await repo.recordPayment(context, businessId, userId, order.id, tenderedMinor, input.paymentMethod, currency);
    // Same bookkeeping as any captured payment: the sale reaches the ledger
    // and the customer gets a receipt. The tip is left out of the journal
    // until there is a tips-payable account to credit.
    const snapshot = {
      currency,
      subtotalMinor: order.subtotalMinor,
      taxMinor: order.taxMinor,
      totalMinor: order.totalMinor,
    };
    await postCaptureJournal(context, businessId, userId, paymentId, input.paymentMethod, order.totalMinor, currency, snapshot);
    await receiptsRepo.issueReceipt(context, businessId, order.id, userId, snapshot);

    if (input.bookingId && booking) {
      await repo.completeBookingAtTill(
        context,
        businessId,
        input.bookingId,
        order.id,
        booking.items.map((item, index) => ({ bookingItemId: item.id, unitMinor: attributed[index]!.unitMinor })),
      );
      return this.composeSummary(context, businessId, order, attributed, booking, "completed", tenderedMinor);
    }
    return this.composeSummary(context, businessId, order, attributed, undefined, undefined, tenderedMinor);
  }

  private async orderSummary(context: DatabaseContext, businessId: string, order: repo.OrderRowSummary): Promise<PosOrderSummary> {
    const priced = (await repo.orderLines(context, businessId, order.id)).map((line) => ({
      productVariantId: line.productVariantId,
      description: line.description,
      sku: null,
      quantity: line.quantity,
      unitMinor: BigInt(line.unitPriceMinor),
      lineTotalMinor: BigInt(line.lineTotalMinor),
      staffId: null,
      selectedModifiers: {},
    }));
    return this.composeSummary(context, businessId, order, priced);
  }

  private async existingSummary(
    context: DatabaseContext,
    businessId: string,
    bookingId: string,
    orderId: string,
    status: string,
  ): Promise<PosOrderSummary> {
    const booking = await bookingsRepo.findById(context, businessId, bookingId);
    const order = await repo.orderById(context, businessId, orderId);
    if (!order) throw conflictError("Booking references a missing order");
    const priced = (await repo.orderLines(context, businessId, orderId)).map((line) => ({
      productVariantId: line.productVariantId,
      description: line.description,
      sku: null,
      quantity: line.quantity,
      unitMinor: BigInt(line.unitPriceMinor),
      lineTotalMinor: BigInt(line.lineTotalMinor),
      staffId: null,
      selectedModifiers: {},
    }));
    return this.composeSummary(context, businessId, order, priced, booking, status);
  }

  private async composeSummary(
    context: DatabaseContext,
    businessId: string,
    order: repo.OrderRowSummary,
    priced: PricedPosLine[],
    booking?: BookingRow,
    bookingStatusOverride?: string,
    paymentNowMinor?: bigint,
  ): Promise<PosOrderSummary> {
    const subtotalMinor = BigInt(order.subtotalMinor);
    const taxMinor = BigInt(order.taxMinor);
    const totalMinor = BigInt(order.totalMinor);
    const serviceChargeMinor = totalMinor - subtotalMinor - taxMinor;
    const [tips, capturedAll] = await Promise.all([
      repo.tipsForOrder(context, businessId, order.id),
      repo.capturedForOrder(context, businessId, order.id),
    ]);
    const tipMinor = tips.reduce((sum, tip) => sum + BigInt(tip.amountMinor), 0n);
    // Deposits are the money already on the order before this charge; the
    // balance falls out as whatever the ticket plus tip still exceeds captured.
    const depositPaid = capturedAll - (paymentNowMinor ?? 0n);
    const balanceDue = totalMinor + tipMinor - capturedAll;
    return {
      order_id: order.id,
      order_number: order.orderNumber,
      currency: order.currency,
      lines: priced.map((line) => ({
        product_variant_id: line.productVariantId,
        description: line.description,
        quantity: line.quantity,
        unit_price_minor: this.minorToNumber(line.unitMinor),
        line_total_minor: this.minorToNumber(line.lineTotalMinor),
        staff_id: line.staffId,
      })),
      subtotal_minor: this.minorToNumber(subtotalMinor),
      service_charge_minor: this.minorToNumber(serviceChargeMinor),
      tax_minor: this.minorToNumber(taxMinor),
      total_minor: this.minorToNumber(totalMinor),
      tip: tips.length ? { amount_minor: this.minorToNumber(tipMinor), staff_id: tips[0]!.staffId } : null,
      deposit_paid_minor: this.minorToNumber(depositPaid > 0n ? depositPaid : 0n),
      balance_due_minor: this.minorToNumber(balanceDue > 0n ? balanceDue : 0n),
      payment_status: "paid",
      booking_id: booking?.id ?? null,
      booking_status: (bookingStatusOverride ?? booking?.status ?? null) as BookingStatus | null,
    };
  }

  private computeTotals(
    priced: PricedPosLine[],
    settings: repo.LocationPricingRow,
  ): { subtotalMinor: bigint; taxMinor: bigint; serviceChargeMinor: bigint; totalMinor: bigint } {
    const subtotalMinor = priced.reduce((sum, line) => sum + line.lineTotalMinor, 0n);
    const taxMinor = BigInt(Math.round(Number(subtotalMinor) * (settings.taxRate / 100)));
    const rate = Math.max(0, ...Object.values(settings.serviceChargeRates).map(Number).filter(Number.isFinite));
    const serviceChargeMinor = BigInt(Math.round(Number(subtotalMinor) * (rate / 100)));
    return { subtotalMinor, taxMinor, serviceChargeMinor, totalMinor: subtotalMinor + taxMinor + serviceChargeMinor };
  }

  private async locationSettings(context: DatabaseContext, businessId: string, locationId: string): Promise<repo.LocationPricingRow> {
    const location = await repo.locationPricing(context, businessId, locationId);
    if (!location) throw notFoundError("Branch not found");
    return location;
  }

  private minorToNumber(minor: bigint): number {
    return Number.parseInt(minor.toString(), 10);
  }

  /** Authenticated store resolution + permission check, mirrored from the bookings service. */
  private async withBusiness<T>(
    userId: string,
    requestId: string,
    storeId: string,
    permission: string,
    work: (context: DatabaseContext, businessId: string) => Promise<T>,
  ): Promise<T> {
    let businessId: string | undefined;
    try {
      businessId = await withDatabaseContext(this.database, withIdentity(requestId, userId, null), (context) =>
        repo.businessIdForStore(context, storeId),
      );
    } catch (error) {
      throw this.normalize(error);
    }
    if (!businessId) throw notFoundError("Store not found");
    try {
      return await withDatabaseContext(this.database, withIdentity(requestId, userId, businessId), async (context) => {
        await authorization.requirePermission(context, businessId, permission);
        return work(context, businessId);
      });
    } catch (error) {
      throw this.normalize(error);
    }
  }

  /** Runs as the paired device; the device principal's permissions come from app.device_permissions(). */
  private async withDevice<T>(
    device: DeviceActor,
    permission: string,
    work: (context: DatabaseContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await withDatabaseContext(this.database, asDevice(device.requestId, device.deviceId, device.businessId), async (context) => {
        await authorization.requirePermission(context, device.businessId, permission);
        return work(context);
      });
    } catch (error) {
      throw this.normalize(error);
    }
  }

  private normalize(error: unknown): Error {
    if (error instanceof AppError || error instanceof DatabaseError) return error;
    return normalizeDatabaseError(error);
  }
}

function bookedStaff(booking: BookingRow | undefined): string | null {
  return booking?.items.find((item) => item.staffId)?.staffId ?? null;
}