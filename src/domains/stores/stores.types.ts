import type { BusinessBranding } from "../businesses/businesses.branding.js";
export type StoreStatus = "draft" | "active" | "archived";
export type LocationStatus = "active" | "inactive" | "archived";
export type RegisterStatus = "active" | "inactive" | "archived";
export type ChannelStatus = "active" | "paused" | "archived";
export type ProductBrowsingMode = "full_page" | "quick_view";
export type StoreWeekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface StoreSocialLinks {
  readonly facebook?: string;
  readonly instagram?: string;
  readonly twitter?: string;
  readonly whatsapp?: string;
}

/** Storefront opening hours by weekday ("HH:MM", store time); null or missing means closed. */
export type StoreBusinessHours = Partial<Record<StoreWeekday, { readonly open: string; readonly close: string } | null>>;

export interface StoreRow {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly status: StoreStatus;
  readonly isDefault: boolean;
  readonly sellsOnline: boolean;
  readonly sellsInPerson: boolean;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly location: string | null;
  readonly websiteUrl: string | null;
  readonly socialLinks: StoreSocialLinks;
  readonly businessHours: StoreBusinessHours;
  readonly privacyPolicy: string | null;
  readonly refundPolicy: string | null;
  readonly productBrowsingMode: ProductBrowsingMode;
  readonly timezone: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

/** What an anonymous storefront visitor may see — no createdBy/timezone/isDefault, and only ever an "active" row (migration 0046's RLS policy is what actually enforces that). */
export interface PublicStore {
  /** The business's logo, icon and colours (absolute image URLs). */
  readonly branding: BusinessBranding;
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly sellsOnline: boolean;
  readonly sellsInPerson: boolean;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly location: string | null;
  readonly websiteUrl: string | null;
  readonly socialLinks: StoreSocialLinks;
  readonly businessHours: StoreBusinessHours;
  readonly privacyPolicy: string | null;
  readonly refundPolicy: string | null;
  readonly productBrowsingMode: ProductBrowsingMode;
}

export interface Store {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly status: StoreStatus;
  readonly isDefault: boolean;
  readonly sellsOnline: boolean;
  readonly sellsInPerson: boolean;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly location: string | null;
  readonly websiteUrl: string | null;
  readonly socialLinks: StoreSocialLinks;
  readonly businessHours: StoreBusinessHours;
  readonly privacyPolicy: string | null;
  readonly refundPolicy: string | null;
  readonly productBrowsingMode: ProductBrowsingMode;
  readonly timezone: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export type LocationOperationType = "dine_in" | "pickup" | "delivery" | "curbside";

export interface LocationRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly name: string;
  readonly kind: "branch" | "warehouse" | "kitchen" | "pharmacy" | "stockroom";
  readonly status: LocationStatus;
  readonly isDefault: boolean;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly phone: string | null;
  readonly timezone: string;
  readonly businessHours: unknown;
  readonly prepTimeMinutes: number | null;
  readonly operationTypes: LocationOperationType[];
  readonly acceptingOrders: boolean;
  readonly taxRate: string;
  readonly serviceChargeRates: unknown;
  readonly manager: string | null;
  readonly format: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface Location extends Omit<LocationRow, "createdAt" | "updatedAt" | "archivedAt" | "businessHours" | "serviceChargeRates"> {
  readonly businessHours: Record<string, unknown>;
  readonly serviceChargeRates: Partial<Record<LocationOperationType, number>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface SalesChannelRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: "storefront" | "pos" | "manual_invoice" | "qr" | "other";
  readonly status: ChannelStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RegisterRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly name: string;
  readonly status: RegisterStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface RegisterShiftRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly registerId: string;
  readonly openedByMembershipId: string | null;
  readonly openedByStaffId?: string | null;
  readonly closedByStaffId?: string | null;
  readonly posDeviceId?: string | null;
  readonly closedByMembershipId: string | null;
  readonly openingCashMinor: string;
  readonly expectedCashMinor: string | null;
  readonly countedCashMinor: string | null;
  readonly varianceMinor: string | null;
  readonly status: "open" | "closed";
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CashMovementRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly registerId: string;
  readonly shiftId: string;
  readonly type: "cash_in" | "cash_out" | "safe_drop" | "adjustment";
  readonly amountMinor: string;
  readonly reason: string;
  readonly actorMembershipId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export interface OperationContext {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface StoreCreateInput {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly isDefault: boolean;
  readonly sellsOnline: boolean;
  readonly sellsInPerson: boolean;
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
  readonly timezone: string;
}

/** The storefront profile fields a store update may set (create leaves them at their defaults). */
export interface StoreProfileInput {
  readonly location?: string | null;
  readonly websiteUrl?: string | null;
  readonly socialLinks?: StoreSocialLinks;
  readonly businessHours?: StoreBusinessHours;
  readonly privacyPolicy?: string | null;
  readonly refundPolicy?: string | null;
  readonly productBrowsingMode?: ProductBrowsingMode;
}

export type StoreUpdateInput = Partial<Omit<StoreCreateInput, "slug">> & StoreProfileInput & {
  readonly slug?: string;
  readonly status?: Exclude<StoreStatus, "archived">;
};

export interface LocationInput {
  readonly name: string;
  readonly kind: LocationRow["kind"];
  readonly status: Exclude<LocationStatus, "archived">;
  readonly isDefault: boolean;
  readonly addressLine1?: string | null;
  readonly addressLine2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly countryCode: string;
  readonly latitude?: string | null;
  readonly longitude?: string | null;
  readonly phone?: string | null;
  readonly timezone: string;
  readonly businessHours: Record<string, unknown>;
  readonly prepTimeMinutes?: number | null;
  readonly operationTypes?: LocationOperationType[];
  readonly acceptingOrders?: boolean;
  readonly taxRate?: number;
  readonly serviceChargeRates?: Partial<Record<LocationOperationType, number>>;
  readonly manager?: string | null;
  readonly format?: string | null;
}

export interface ChannelInput {
  readonly code: string;
  readonly name: string;
  readonly kind: SalesChannelRow["kind"];
  readonly status: Exclude<ChannelStatus, "archived">;
}

export interface RegisterInput {
  readonly locationId: string;
  readonly name: string;
  readonly status: Exclude<RegisterStatus, "archived">;
}

export interface CashMovementInput {
  readonly type: Exclude<CashMovementRow["type"], "adjustment">;
  readonly amountMinor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}
