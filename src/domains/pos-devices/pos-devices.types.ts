/** A paired device as resolved from its token, before any principal exists. */
export interface ResolvedDevice {
  readonly deviceId: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly registerId: string;
  readonly locationId: string;
}

export interface PosDeviceRow {
  readonly id: string;
  readonly registerId: string;
  readonly label: string;
  readonly platform: string;
  readonly status: "pending" | "active" | "revoked";
  readonly pairedAt: Date | null;
  readonly lastSeenAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface DeviceSessionRow {
  readonly registerId: string;
  readonly registerName: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly storeSlug: string;
}

export interface TillCustomerRow {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface TillOrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly fulfillmentStatus: string;
  readonly totalMinor: string;
  readonly currency: string;
  readonly createdAt: Date;
  readonly customerName: string | null;
  readonly operatorName: string | null;
  readonly lineCount: number;
}

/** Who is operating the till right now. */
export interface TillStaff {
  readonly id: string;
  readonly name: string;
}
