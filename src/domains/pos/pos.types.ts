import type { BookingStatus } from "../bookings/bookings.types.js";

export type PosPaymentMethod = "cash" | "card" | "bank_transfer" | "online";

/** A single purchasable line on a till ticket before it is priced. */
export interface PosLineInput {
  readonly productId: string;
  readonly variantId: string | null;
  readonly quantity: number;
  readonly modifierOptionIds: string[];
  readonly note?: string;
}

/** The pricing formula's answer for one line, resolved server-side. */
export interface PricedPosLine {
  readonly productVariantId: string;
  readonly description: string;
  readonly sku: string | null;
  readonly quantity: number;
  readonly unitMinor: bigint;
  readonly lineTotalMinor: bigint;
  /** Attributed staff member (the performer for a booking service line). */
  readonly staffId: string | null;
  readonly selectedModifiers: Record<string, unknown>;
}

export interface PosTotals {
  readonly subtotalMinor: bigint;
  readonly taxMinor: bigint;
  readonly serviceChargeMinor: bigint;
  readonly totalMinor: bigint;
}

/** camelCase summary the till screen renders — numbers are minor units. */
export interface PosOrderPreview {
  readonly subtotal: number;
  readonly discount: number;
  readonly taxAmount: number;
  readonly serviceChargeAmount: number;
  readonly total: number;
}

export interface PosOrderLine {
  readonly product_variant_id: string;
  readonly description: string;
  readonly quantity: number;
  readonly unit_price_minor: number;
  readonly line_total_minor: number;
  readonly staff_id: string | null;
}

export interface PosTipSummary {
  readonly amount_minor: number;
  readonly staff_id: string | null;
}

/** snake_case summary returned to the till once a charge lands. */
export interface PosOrderSummary {
  readonly order_id: string;
  readonly order_number: string;
  readonly currency: string;
  readonly lines: PosOrderLine[];
  readonly subtotal_minor: number;
  readonly service_charge_minor: number;
  readonly tax_minor: number;
  readonly total_minor: number;
  readonly tip: PosTipSummary | null;
  readonly deposit_paid_minor: number;
  readonly balance_due_minor: number;
  readonly payment_status: OrderPaymentStatus;
  readonly booking_id: string | null;
  readonly booking_status: BookingStatus | null;
}

export type OrderPaymentStatus = "unpaid" | "partially_paid" | "paid" | "refunded";