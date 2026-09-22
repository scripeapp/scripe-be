export type ProviderName = "paystack" | "flutterwave" | "anchor" | "brails" | "shipbubble";
export type ProviderEventStatus = "received" | "processed" | "ignored" | "failed";

export interface ProviderEventRow {
  readonly id: string;
  readonly provider: ProviderName;
  readonly eventType: string;
  readonly providerReference: string | null;
  readonly signatureValid: boolean;
  readonly status: ProviderEventStatus;
  readonly payload: Record<string, unknown>;
  readonly errorMessage: string | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

export interface RecordEventInput {
  readonly provider: ProviderName;
  readonly eventType: string;
  readonly providerReference: string | null;
  readonly signatureValid: boolean;
  readonly payload: Record<string, unknown>;
}
