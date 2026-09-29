export interface Principal {
  readonly userId: string | null;
  readonly businessId: string | null;
  readonly requestId: string;
  /** A paired /pos device acting as its register; never set together with a user. */
  readonly deviceId?: string | null;
}

export function anonymousPrincipal(requestId: string): Principal {
  return { userId: null, businessId: null, requestId };
}

export function withIdentity(
  requestId: string,
  userId: string,
  businessId: string | null = null,
): Principal {
  return { userId, businessId, requestId };
}

/** A paired cashier device: no user, permissions come from app.device_permissions(). */
export function asDevice(requestId: string, deviceId: string, businessId: string): Principal {
  return { userId: null, businessId, requestId, deviceId };
}
