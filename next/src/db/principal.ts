export interface Principal {
  readonly userId: string | null;
  readonly businessId: string | null;
  readonly requestId: string;
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