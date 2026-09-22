export interface AuditEventRow {
  readonly id: string;
  readonly businessId: string | null;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly createdAt: Date;
}

export interface AuditEvent extends Omit<AuditEventRow, "createdAt"> {
  readonly createdAt: string;
}

export interface AuditOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface ListAuditEventsFilter {
  readonly action?: string;
  readonly limit?: number;
}

/**
 * Not exposed via any route — other domains' service code calls this
 * directly, within their own transaction, to record a privileged or
 * business-mutating action. businessId/actorUserId are data describing the
 * event, not the caller's own identity.
 */
export interface LogAuditEventInput {
  readonly businessId: string | null;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}
