import type { DepositRule } from "./service-settings.schemas.js";

export interface ServiceSettingsRow {
  readonly productId: string;
  readonly businessId: string;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly minNoticeMinutes: number;
  readonly maxAdvanceDays: number;
  readonly slotIntervalMinutes: number;
  readonly locationType: string;
  readonly requiresApproval: boolean;
  readonly depositRule: DepositRule;
  readonly cancellationWindowMin: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ServiceSettings extends Omit<ServiceSettingsRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceSettingsOperation {
  readonly userId: string;
  readonly requestId: string;
  readonly businessId: string;
}
