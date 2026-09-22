/**
 * API and domain types for the message template, delivery, and
 * communication credit domain. Database row types remain generated and
 * separate.
 */

export type CommunicationChannel = "email" | "sms" | "whatsapp";

// ---------------------------------------------------------------------------
// Sending domains and senders
// ---------------------------------------------------------------------------

export type CommunicationDomainStatus = "pending" | "verified" | "failed";

export interface DnsRecord {
  readonly type: "TXT";
  readonly name: string;
  readonly value: string;
}

export interface CommunicationDomainRow {
  readonly id: string;
  readonly businessId: string;
  readonly domain: string;
  readonly status: CommunicationDomainStatus;
  readonly dnsRecords: DnsRecord[];
  readonly verifiedAt: Date | null;
  readonly lastVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CommunicationDomain extends Omit<CommunicationDomainRow, "verifiedAt" | "lastVerifiedAt" | "createdAt" | "updatedAt"> {
  readonly verifiedAt: string | null;
  readonly lastVerifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommunicationSenderRow {
  readonly id: string;
  readonly businessId: string;
  readonly domainId: string | null;
  readonly name: string;
  readonly email: string;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CommunicationSender extends Omit<CommunicationSenderRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSenderInput {
  readonly name: string;
  readonly email: string;
  readonly domainId?: string | null;
}

export interface UpdateSenderInput {
  readonly name?: string;
  readonly isActive?: boolean;
}

export interface ResolvedSender {
  readonly name: string;
  readonly email: string;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface CommunicationTemplateRow {
  readonly id: string;
  readonly businessId: string;
  readonly channel: CommunicationChannel;
  readonly name: string;
  readonly subject: string | null;
  readonly body: string;
  readonly isActive: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CommunicationTemplate extends Omit<CommunicationTemplateRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTemplateInput {
  readonly channel: CommunicationChannel;
  readonly name: string;
  readonly subject?: string | null;
  readonly body: string;
}

export interface UpdateTemplateInput {
  readonly name?: string;
  readonly subject?: string | null;
  readonly body?: string;
  readonly isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Audience segments
// ---------------------------------------------------------------------------

export interface AudienceSegmentRow {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AudienceSegment extends Omit<AudienceSegmentRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSegmentInput {
  readonly name: string;
  readonly description?: string | null;
}

export interface UpdateSegmentInput {
  readonly name?: string;
  readonly description?: string | null;
}

export interface AudienceSegmentMember {
  readonly partyId: string;
  readonly displayName: string;
  readonly addedAt: string;
}

// ---------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------

export interface OptOutRow {
  readonly id: string;
  readonly businessId: string;
  readonly partyId: string;
  readonly channel: CommunicationChannel;
  readonly reason: string | null;
  readonly optedOutAt: Date;
}

export interface OptOut extends Omit<OptOutRow, "optedOutAt"> {
  readonly optedOutAt: string;
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export type CreditEntryKind = "purchase" | "debit" | "refund";

export interface CreditEntryRow {
  readonly id: string;
  readonly businessId: string;
  readonly kind: CreditEntryKind;
  readonly credits: string;
  readonly balanceAfter: string;
  readonly referenceType: "topup" | "message" | null;
  readonly referenceId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface CreditEntry extends Omit<CreditEntryRow, "createdAt"> {
  readonly createdAt: string;
}

export interface CreditAccount {
  readonly businessId: string;
  readonly balance: string;
}

export interface CreditPackage {
  readonly id: string;
  readonly credits: number;
  readonly priceMinor: string;
  readonly assetCode: string;
}

export interface CreditRates {
  readonly email: number;
  readonly smsPerPart: number;
  readonly whatsapp: number;
}

export type TopupGateway = "paystack" | "flutterwave";

export interface CreditTopupRow {
  readonly id: string;
  readonly businessId: string;
  readonly credits: string;
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly gateway: TopupGateway;
  readonly providerReference: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface InitiateTopupInput {
  readonly packageId: string;
  readonly gateway: TopupGateway;
  readonly callbackUrl?: string;
}

export interface InitiatedTopup {
  readonly topupId: string;
  readonly authorizationUrl: string;
  readonly reference: string;
}

// ---------------------------------------------------------------------------
// Messages and deliveries
// ---------------------------------------------------------------------------

export type MessageStatus = "draft" | "processing" | "sent" | "partial" | "failed" | "cancelled";
export type AudienceType = "all" | "segment";

export interface CommunicationMessageRow {
  readonly id: string;
  readonly businessId: string;
  readonly channel: CommunicationChannel;
  readonly name: string;
  readonly status: MessageStatus;
  readonly templateId: string | null;
  readonly senderId: string | null;
  readonly subject: string | null;
  readonly body: string | null;
  readonly audienceType: AudienceType;
  readonly audienceSegmentId: string | null;
  readonly recipientCount: number | null;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly creditsSpent: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CommunicationMessage extends Omit<CommunicationMessageRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMessageInput {
  readonly channel: CommunicationChannel;
  readonly name: string;
  readonly templateId?: string | null;
  readonly senderId?: string | null;
  readonly subject?: string | null;
  readonly body?: string | null;
  readonly audienceType: AudienceType;
  readonly audienceSegmentId?: string | null;
}

export interface UpdateMessageInput {
  readonly name?: string;
  readonly templateId?: string | null;
  readonly senderId?: string | null;
  readonly subject?: string | null;
  readonly body?: string | null;
  readonly audienceType?: AudienceType;
  readonly audienceSegmentId?: string | null;
}

export type DeliveryStatus = "pending" | "sent" | "failed";

export interface CommunicationDeliveryRow {
  readonly id: string;
  readonly messageId: string;
  readonly partyId: string;
  readonly destination: string;
  readonly status: DeliveryStatus;
  readonly providerMessageId: string | null;
  readonly errorMessage: string | null;
  readonly creditCost: string;
  readonly sentAt: Date | null;
  readonly failedAt: Date | null;
  readonly createdAt: Date;
}

export interface CommunicationDelivery extends Omit<CommunicationDeliveryRow, "sentAt" | "failedAt" | "createdAt"> {
  readonly sentAt: string | null;
  readonly failedAt: string | null;
  readonly createdAt: string;
}

export interface CostEstimate {
  readonly channel: CommunicationChannel;
  readonly recipientCount: number;
  readonly creditsPerRecipient: number;
  readonly messageParts: number;
  readonly requiredCredits: number;
}

export interface RecipientCandidate {
  readonly partyId: string;
  readonly destination: string;
}

// ---------------------------------------------------------------------------
// Operation context
// ---------------------------------------------------------------------------

export interface CommunicationsOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}
