export interface IntegrationsOperation {
  readonly userId: string;
  readonly requestId: string;
}

export interface GoogleCalendarStatus {
  /** False when the server has no Google OAuth client configured. */
  readonly available: boolean;
  readonly connected: boolean;
  /** The linked Google address, when known. */
  readonly email: string | null;
  /** Add a Google Meet link to synced bookings. */
  readonly meetEnabled: boolean;
  /** Scopes the client asks for when linking Google (Better Auth linkSocial). */
  readonly scopes: readonly string[];
}
