/**
 * API and domain types for the fraud signal, investigation, and
 * transaction hold domain. Database row types remain generated and
 * separate. Platform-staff-facing (same authority as the platform domain),
 * not business-scoped.
 */

export type RiskEntityType = "order" | "payment" | "refund" | "transfer" | "register_shift" | "user" | "business" | "stock_adjustment";
export type RiskSeverity = "critical" | "high" | "medium" | "low";
export type RiskSignalStatus = "open" | "investigating" | "confirmed" | "cleared";

export interface RiskSignalRow {
  readonly id: string;
  readonly entityType: RiskEntityType;
  readonly entityId: string;
  readonly signalType: string;
  readonly description: string;
  readonly severity: RiskSeverity;
  readonly status: RiskSignalStatus;
  readonly metadata: Record<string, unknown>;
  readonly riskCaseId: string | null;
  readonly reviewedBy: string | null;
  readonly reviewNotes: string | null;
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
}

export interface RiskSignal extends Omit<RiskSignalRow, "reviewedAt" | "createdAt"> {
  readonly reviewedAt: string | null;
  readonly createdAt: string;
}

export interface ListSignalsFilter {
  readonly status?: RiskSignalStatus;
  readonly severity?: RiskSeverity;
  readonly entityType?: RiskEntityType;
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
  readonly limit?: number;
}

export interface SignalsPage {
  readonly data: RiskSignal[];
  readonly total: number;
}

export interface ReviewSignalInput {
  readonly status: RiskSignalStatus;
  readonly notes?: string;
}

export interface RiskStats {
  readonly open: number;
  readonly investigating: number;
  readonly confirmed: number;
  readonly criticalOpen: number;
  readonly highOpen: number;
}

/**
 * Not exposed via any route - other domains' service code calls this
 * directly, within their own transaction, to raise a fraud/anomaly signal
 * about an event. Mirrors audit/admin_alerts' server-only creation shape;
 * fire-and-forget like legacy's recordSignal (a failure here must never
 * fail the transaction it's describing).
 */
export interface RecordSignalInput {
  readonly entityType: RiskEntityType;
  readonly entityId: string;
  readonly signalType: string;
  readonly description: string;
  readonly severity: RiskSeverity;
  readonly metadata?: Record<string, unknown>;
}

export type RiskCaseStatus = "open" | "investigating" | "resolved" | "dismissed";

export interface RiskCaseRow {
  readonly id: string;
  readonly title: string;
  readonly status: RiskCaseStatus;
  readonly assignedTo: string | null;
  readonly resolutionNotes: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
}

export interface RiskCase extends Omit<RiskCaseRow, "createdAt" | "updatedAt" | "resolvedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
}

export interface CreateCaseInput {
  readonly title: string;
  readonly signalIds?: string[];
}

export interface UpdateCaseInput {
  readonly status?: RiskCaseStatus;
  readonly assignedTo?: string | null;
  readonly resolutionNotes?: string | null;
}

export type HoldEntityType = "business" | "user";
export type HoldStatus = "active" | "released";

export interface TransactionHoldRow {
  readonly id: string;
  readonly entityType: HoldEntityType;
  readonly entityId: string;
  readonly reason: string;
  readonly status: HoldStatus;
  readonly createdBy: string;
  readonly releasedBy: string | null;
  readonly releasedAt: Date | null;
  readonly createdAt: Date;
}

export interface TransactionHold extends Omit<TransactionHoldRow, "releasedAt" | "createdAt"> {
  readonly releasedAt: string | null;
  readonly createdAt: string;
}

export interface CreateHoldInput {
  readonly entityType: HoldEntityType;
  readonly entityId: string;
  readonly reason: string;
}

export interface RiskOperation {
  readonly userId: string;
  readonly requestId: string;
}
