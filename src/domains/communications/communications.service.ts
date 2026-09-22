import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { getCheckoutGateway } from "../../integrations/checkout-gateway.js";
import { getMessageProvider } from "../../integrations/message-provider.js";
import { emailSender } from "../../shared/email.js";
import { loadEnvironment } from "../../shared/environment.js";
import { AppError, conflictError, notFoundError, validationError } from "../../shared/errors.js";
import * as auditRepository from "../audit/audit.repository.js";
import { requirePermission } from "../authorization/authorization.service.js";
import { estimateCommunicationCost, appendSmsOptOutFooter } from "./communications.cost.js";
import * as repository from "./communications.repository.js";
import type {
  AudienceSegment,
  AudienceSegmentMember,
  AudienceSegmentRow,
  CommunicationChannel,
  CommunicationDelivery,
  CommunicationDeliveryRow,
  CommunicationDomain,
  CommunicationDomainRow,
  CommunicationMessage,
  CommunicationMessageRow,
  CommunicationSender,
  CommunicationSenderRow,
  CommunicationTemplate,
  CommunicationTemplateRow,
  CommunicationsOperation,
  CostEstimate,
  CreateMessageInput,
  CreateSegmentInput,
  CreateSenderInput,
  CreateTemplateInput,
  CreditAccount,
  CreditEntry,
  CreditEntryRow,
  CreditPackage,
  InitiateTopupInput,
  InitiatedTopup,
  MessageStatus,
  OptOut,
  OptOutRow,
  ResolvedSender,
  UpdateMessageInput,
  UpdateSegmentInput,
  UpdateSenderInput,
  UpdateTemplateInput,
} from "./communications.types.js";

const CREDIT_PACKAGES: CreditPackage[] = [
  { id: "credits_1000", credits: 1000, priceMinor: "100000000", assetCode: "NGN" },
  { id: "credits_5000", credits: 5000, priceMinor: "450000000", assetCode: "NGN" },
  { id: "credits_20000", credits: 20000, priceMinor: "1600000000", assetCode: "NGN" },
];

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

interface DispatchResult {
  readonly deliveryId: string;
  readonly status: "sent" | "failed";
  readonly providerMessageId: string | null;
  readonly errorMessage: string | null;
}

export class CommunicationsService {
  constructor(private readonly database: Database) {}

  // ---------------------------------------------------------------------
  // Sending domains
  // ---------------------------------------------------------------------

  async listDomains(operation: CommunicationsOperation): Promise<CommunicationDomain[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      return (await repository.listDomains(context, operation.businessId)).map(toDomain);
    });
  }

  async addDomain(operation: CommunicationsOperation, domain: string): Promise<CommunicationDomain> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const token = randomBytes(16).toString("hex");
      const created = await repository.createDomain(context, operation.businessId, domain, [
        { type: "TXT", name: `_surge-verify.${domain}`, value: `surge-domain-verification=${token}` },
      ]);
      return toDomain(created);
    });
  }

  async verifyDomain(operation: CommunicationsOperation, domainId: string): Promise<CommunicationDomain> {
    const domain = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const found = await repository.findDomain(context, operation.businessId, domainId);
      if (!found) throw notFoundError("Sending domain not found");
      return found;
    });

    const record = domain.dnsRecords[0];
    const verified = record ? await this.checkTxtRecord(record.name, record.value) : false;

    return this.run(operation, async (context) => {
      const updated = await repository.markDomainVerification(context, operation.businessId, domainId, verified);
      if (!updated) throw notFoundError("Sending domain not found");
      if (!verified) throw validationError("DNS verification record was not found. DNS changes can take time to propagate — try again shortly.");
      return toDomain(updated);
    });
  }

  private async checkTxtRecord(name: string, expectedValue: string): Promise<boolean> {
    try {
      const records = await resolveTxt(name);
      return records.some((chunks) => chunks.join("").includes(expectedValue));
    } catch {
      return false;
    }
  }

  async deleteDomain(operation: CommunicationsOperation, domainId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const deleted = await repository.deleteDomain(context, operation.businessId, domainId);
      if (!deleted) throw notFoundError("Sending domain not found");
    });
  }

  // ---------------------------------------------------------------------
  // Senders
  // ---------------------------------------------------------------------

  async listSenders(operation: CommunicationsOperation): Promise<CommunicationSender[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      return (await repository.listSenders(context, operation.businessId)).map(toSender);
    });
  }

  async createSender(operation: CommunicationsOperation, input: CreateSenderInput): Promise<CommunicationSender> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      if (input.domainId) {
        const domain = await repository.findDomain(context, operation.businessId, input.domainId);
        if (!domain || domain.status !== "verified") throw validationError("The sending domain must be verified before creating a sender on it");
        if (!input.email.toLowerCase().endsWith(`@${domain.domain.toLowerCase()}`)) throw validationError("Sender email must belong to the selected domain");
      }
      const created = await repository.createSender(context, operation.businessId, input);
      const isFirstSender = (await repository.listSenders(context, operation.businessId)).length === 1;
      if (isFirstSender) await repository.setDefaultSender(context, operation.businessId, created.id);
      const final = await repository.findSender(context, operation.businessId, created.id);
      return toSender(final!);
    });
  }

  async updateSender(operation: CommunicationsOperation, senderId: string, input: UpdateSenderInput): Promise<CommunicationSender> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const updated = await repository.updateSender(context, operation.businessId, senderId, input);
      if (!updated) throw notFoundError("Sender not found");
      return toSender(updated);
    });
  }

  async setDefaultSender(operation: CommunicationsOperation, senderId: string): Promise<CommunicationSender> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const existing = await repository.findSender(context, operation.businessId, senderId);
      if (!existing) throw notFoundError("Sender not found");
      const updated = await repository.setDefaultSender(context, operation.businessId, senderId);
      return toSender(updated!);
    });
  }

  async deleteSender(operation: CommunicationsOperation, senderId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const deleted = await repository.deleteSender(context, operation.businessId, senderId);
      if (!deleted) throw notFoundError("Sender not found");
    });
  }

  /** Explicit sender → business default → platform fallback. This is the fix for legacy's disconnect: both call sites here actually resolve and use it, instead of a hard-coded slug address. */
  private async resolveSender(context: DatabaseContext, businessId: string, senderId: string | null): Promise<ResolvedSender> {
    if (senderId) {
      const sender = await repository.findSender(context, businessId, senderId);
      if (!sender || !sender.isActive) throw validationError("Selected sender not found or inactive");
      return { name: sender.name, email: sender.email };
    }
    const defaultSender = await repository.findDefaultSender(context, businessId);
    if (defaultSender) return { name: defaultSender.name, email: defaultSender.email };
    const environment = loadEnvironment();
    return { name: "Surge", email: environment.PLUNK_FROM_EMAIL ?? "noreply@surge.app" };
  }

  // ---------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------

  async listTemplates(operation: CommunicationsOperation, channel: CommunicationChannel | undefined): Promise<CommunicationTemplate[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      return (await repository.listTemplates(context, operation.businessId, channel)).map(toTemplate);
    });
  }

  async createTemplate(operation: CommunicationsOperation, input: CreateTemplateInput): Promise<CommunicationTemplate> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const created = await repository.createTemplate(context, operation.businessId, operation.userId, input);
      return toTemplate(created);
    });
  }

  async updateTemplate(operation: CommunicationsOperation, templateId: string, input: UpdateTemplateInput): Promise<CommunicationTemplate> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const updated = await repository.updateTemplate(context, operation.businessId, templateId, input);
      if (!updated) throw notFoundError("Template not found");
      return toTemplate(updated);
    });
  }

  async deleteTemplate(operation: CommunicationsOperation, templateId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const deleted = await repository.deleteTemplate(context, operation.businessId, templateId);
      if (!deleted) throw notFoundError("Template not found");
    });
  }

  // ---------------------------------------------------------------------
  // Audience segments
  // ---------------------------------------------------------------------

  async listSegments(operation: CommunicationsOperation): Promise<AudienceSegment[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      return (await repository.listSegments(context, operation.businessId)).map(toSegment);
    });
  }

  async createSegment(operation: CommunicationsOperation, input: CreateSegmentInput): Promise<AudienceSegment> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const created = await repository.createSegment(context, operation.businessId, operation.userId, input);
      return toSegment(created);
    });
  }

  async updateSegment(operation: CommunicationsOperation, segmentId: string, input: UpdateSegmentInput): Promise<AudienceSegment> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const updated = await repository.updateSegment(context, operation.businessId, segmentId, input);
      if (!updated) throw notFoundError("Audience segment not found");
      return toSegment(updated);
    });
  }

  async deleteSegment(operation: CommunicationsOperation, segmentId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const deleted = await repository.deleteSegment(context, operation.businessId, segmentId);
      if (!deleted) throw notFoundError("Audience segment not found");
    });
  }

  async listSegmentMembers(operation: CommunicationsOperation, segmentId: string): Promise<AudienceSegmentMember[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      const segment = await repository.findSegment(context, operation.businessId, segmentId);
      if (!segment) throw notFoundError("Audience segment not found");
      return repository.listSegmentMembers(context, segmentId);
    });
  }

  async addSegmentMembers(operation: CommunicationsOperation, segmentId: string, partyIds: readonly string[]): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const segment = await repository.findSegment(context, operation.businessId, segmentId);
      if (!segment) throw notFoundError("Audience segment not found");
      await repository.addSegmentMembers(context, segmentId, partyIds);
    });
  }

  async removeSegmentMember(operation: CommunicationsOperation, segmentId: string, partyId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const segment = await repository.findSegment(context, operation.businessId, segmentId);
      if (!segment) throw notFoundError("Audience segment not found");
      await repository.removeSegmentMember(context, segmentId, partyId);
    });
  }

  // ---------------------------------------------------------------------
  // Opt-outs
  // ---------------------------------------------------------------------

  async listOptOuts(operation: CommunicationsOperation): Promise<OptOut[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      return (await repository.listOptOuts(context, operation.businessId)).map(toOptOut);
    });
  }

  async optOut(operation: CommunicationsOperation, partyId: string, channel: CommunicationChannel, reason: string | null): Promise<OptOut> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const created = await repository.createOptOut(context, operation.businessId, partyId, channel, reason);
      return toOptOut(created);
    });
  }

  async optIn(operation: CommunicationsOperation, partyId: string, channel: CommunicationChannel): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      await repository.deleteOptOut(context, operation.businessId, partyId, channel);
    });
  }

  // ---------------------------------------------------------------------
  // Credits
  // ---------------------------------------------------------------------

  listPackages(): CreditPackage[] {
    return CREDIT_PACKAGES;
  }

  async getAccount(operation: CommunicationsOperation): Promise<{ account: CreditAccount; recentEntries: CreditEntry[] }> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      const balance = await repository.getCreditBalance(context, operation.businessId);
      const recentEntries = (await repository.listCreditEntries(context, operation.businessId, 20)).map(toCreditEntry);
      return { account: { businessId: operation.businessId, balance }, recentEntries };
    });
  }

  async initiateTopup(operation: CommunicationsOperation, input: InitiateTopupInput): Promise<InitiatedTopup> {
    const creditPackage = CREDIT_PACKAGES.find((candidate) => candidate.id === input.packageId);
    if (!creditPackage) throw validationError("Unknown credit package");

    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const reference = `comm_credit_${randomUUID()}`;
      const gateway = getCheckoutGateway(input.gateway);
      const checkout = await gateway.initializeCheckout({
        amountMinor: creditPackage.priceMinor,
        assetCode: creditPackage.assetCode,
        email: `billing+${operation.businessId}@surge.app`,
        reference,
        callbackUrl: input.callbackUrl,
        metadata: { kind: "communication_credit_topup", businessId: operation.businessId, packageId: creditPackage.id },
      });
      const topup = await repository.createTopup(context, operation.businessId, operation.userId, {
        credits: creditPackage.credits,
        amountMinor: creditPackage.priceMinor,
        assetCode: creditPackage.assetCode,
        gateway: input.gateway,
        providerReference: checkout.reference,
      });
      return { topupId: topup.id, authorizationUrl: checkout.authorizationUrl, reference: checkout.reference };
    });
  }

  // ---------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------

  async listMessages(operation: CommunicationsOperation, filter: { channel?: CommunicationChannel; status?: MessageStatus }): Promise<CommunicationMessage[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      return (await repository.listMessages(context, operation.businessId, filter)).map(toMessage);
    });
  }

  async getMessage(operation: CommunicationsOperation, messageId: string): Promise<{ message: CommunicationMessage; deliveries: CommunicationDelivery[] }> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      const message = await repository.findMessage(context, operation.businessId, messageId);
      if (!message) throw notFoundError("Message not found");
      const deliveries = await repository.listDeliveriesForMessage(context, messageId);
      return { message: toMessage(message), deliveries: deliveries.map(toDelivery) };
    });
  }

  async createMessage(operation: CommunicationsOperation, input: CreateMessageInput): Promise<CommunicationMessage> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      if (input.templateId) {
        const template = await repository.findTemplate(context, operation.businessId, input.templateId);
        if (!template) throw validationError("Template not found");
      }
      if (input.audienceType === "segment") {
        const segment = await repository.findSegment(context, operation.businessId, input.audienceSegmentId!);
        if (!segment) throw validationError("Audience segment not found");
      }
      const created = await repository.createMessage(context, operation.businessId, operation.userId, input);
      return toMessage(created);
    });
  }

  async updateMessage(operation: CommunicationsOperation, messageId: string, input: UpdateMessageInput): Promise<CommunicationMessage> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const existing = await repository.findMessage(context, operation.businessId, messageId);
      if (!existing) throw notFoundError("Message not found");
      if (existing.status !== "draft") throw conflictError("Only a draft message can be edited");
      const updated = await repository.updateMessage(context, operation.businessId, messageId, input);
      return toMessage(updated!);
    });
  }

  async deleteMessage(operation: CommunicationsOperation, messageId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const existing = await repository.findMessage(context, operation.businessId, messageId);
      if (!existing) throw notFoundError("Message not found");
      if (existing.status !== "draft") throw conflictError("Only a draft message can be deleted");
      await repository.deleteMessage(context, operation.businessId, messageId);
    });
  }

  async estimateCost(
    operation: CommunicationsOperation,
    input: { channel: CommunicationChannel; audienceType: "all" | "segment"; audienceSegmentId?: string; body: string },
  ): Promise<CostEstimate> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.read");
      const recipients =
        input.audienceType === "all"
          ? await repository.resolveAllCustomerRecipients(context, operation.businessId, input.channel)
          : await repository.resolveSegmentRecipients(context, input.audienceSegmentId!, input.channel);
      const body = input.channel === "sms" ? appendSmsOptOutFooter(input.body) : input.body;
      return estimateCommunicationCost(input.channel, recipients.length, body);
    });
  }

  /**
   * Two phases: a transaction that resolves recipients, debits credits, and
   * creates delivery rows (no external calls while it's open); then, once
   * committed, dispatch to the provider outside any transaction and record
   * the outcome in a second, short transaction. There's no background
   * dispatcher (the jobs domain doesn't exist yet), so this blocks until
   * every recipient has been attempted — bounded by
   * COMMUNICATIONS_MAX_RECIPIENTS_PER_SEND for that reason.
   */
  async sendMessage(operation: CommunicationsOperation, messageId: string): Promise<{ message: CommunicationMessage; deliveries: CommunicationDelivery[] }> {
    const prepared = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "communications.manage");
      const message = await repository.lockMessage(context, operation.businessId, messageId);
      if (!message) throw notFoundError("Message not found");
      if (message.status !== "draft") throw conflictError("This message has already been sent or is being sent");

      const recipients =
        message.audienceType === "all"
          ? await repository.resolveAllCustomerRecipients(context, operation.businessId, message.channel)
          : await repository.resolveSegmentRecipients(context, message.audienceSegmentId!, message.channel);
      if (recipients.length === 0) throw validationError("No eligible recipients for this audience (check for opt-outs or missing contact info)");

      const maxRecipients = loadEnvironment().COMMUNICATIONS_MAX_RECIPIENTS_PER_SEND;
      if (recipients.length > maxRecipients) {
        throw validationError(`This send has ${recipients.length} recipients, above the ${maxRecipients}-per-send limit (no background dispatcher exists yet to process larger sends safely)`);
      }

      let body = message.body;
      let subject = message.subject;
      if (message.templateId) {
        const template = await repository.findTemplate(context, operation.businessId, message.templateId);
        if (!template || !template.isActive) throw validationError("Template not found or inactive");
        body = template.body;
        subject = template.subject;
      }
      if (!body) throw validationError("Message has no content");
      if (message.channel === "email" && !subject) throw validationError("An email message requires a subject");

      const finalBody = message.channel === "sms" ? appendSmsOptOutFooter(body) : body;
      const estimate = estimateCommunicationCost(message.channel, recipients.length, finalBody);

      const sender = message.channel === "email" ? await this.resolveSender(context, operation.businessId, message.senderId) : null;

      await repository.applyCreditDelta(context, operation.businessId, "debit", -BigInt(estimate.requiredCredits), { type: "message", id: messageId }, {
        channel: message.channel,
        recipientCount: recipients.length,
      });

      const deliveries = await repository.createDeliveries(
        context,
        messageId,
        recipients.map((recipient) => ({ partyId: recipient.partyId, destination: recipient.destination, creditCost: estimate.creditsPerRecipient })),
      );
      await repository.markMessageProcessing(context, messageId, recipients.length);

      await auditRepository.log(context, {
        businessId: operation.businessId,
        actorUserId: operation.userId,
        action: "communications.message.send",
        targetType: "communication_message",
        targetId: messageId,
        metadata: { channel: message.channel, recipientCount: recipients.length, requiredCredits: estimate.requiredCredits },
        requestId: operation.requestId,
      });

      return { channel: message.channel, finalBody, subject, sender, deliveries };
    });

    const provider = prepared.channel === "email" ? null : getMessageProvider(prepared.channel);
    const dispatchResults = await mapWithConcurrency<CommunicationDeliveryRow, DispatchResult>(prepared.deliveries, 10, async (delivery) => {
      try {
        if (prepared.channel === "email") {
          await emailSender.sendTransactional({
            to: delivery.destination,
            subject: prepared.subject!,
            html: prepared.finalBody,
            from: prepared.sender ? `${prepared.sender.name} <${prepared.sender.email}>` : undefined,
          });
          return { deliveryId: delivery.id, status: "sent", providerMessageId: null, errorMessage: null };
        }
        const result = await provider!.send({ to: delivery.destination, body: prepared.finalBody });
        return {
          deliveryId: delivery.id,
          status: result.accepted ? "sent" : "failed",
          providerMessageId: result.providerMessageId,
          errorMessage: result.errorMessage,
        };
      } catch (error) {
        return { deliveryId: delivery.id, status: "failed", providerMessageId: null, errorMessage: error instanceof Error ? error.message : "Send failed" };
      }
    });

    return this.run(operation, async (context) => {
      let sentCount = 0;
      let failedCount = 0;
      let refundCredits = 0n;
      const costByDeliveryId = new Map(prepared.deliveries.map((delivery) => [delivery.id, BigInt(delivery.creditCost)]));

      for (const result of dispatchResults) {
        await repository.updateDeliveryResult(context, result.deliveryId, {
          status: result.status,
          providerMessageId: result.providerMessageId,
          errorMessage: result.errorMessage,
        });
        if (result.status === "sent") {
          sentCount += 1;
        } else {
          failedCount += 1;
          refundCredits += costByDeliveryId.get(result.deliveryId) ?? 0n;
        }
      }

      if (refundCredits > 0n) {
        await repository.applyCreditDelta(context, operation.businessId, "refund", refundCredits, { type: "message", id: messageId }, { reason: "failed deliveries" });
      }

      const totalDebited = prepared.deliveries.reduce((sum, delivery) => sum + BigInt(delivery.creditCost), 0n);
      const finalStatus: MessageStatus = failedCount === 0 ? "sent" : sentCount === 0 ? "failed" : "partial";
      await repository.finalizeMessage(context, messageId, {
        status: finalStatus,
        sentCount,
        failedCount,
        creditsSpent: (totalDebited - refundCredits).toString(),
      });

      const message = await repository.findMessage(context, operation.businessId, messageId);
      const deliveries = await repository.listDeliveriesForMessage(context, messageId);
      return { message: toMessage(message!), deliveries: deliveries.map(toDelivery) };
    });
  }

  private async run<T>(operation: CommunicationsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      if (error instanceof Error && (error as { code?: string }).code === "INSUFFICIENT_CREDITS") throw validationError("Insufficient communication credits for this send");
      throw normalizeDatabaseError(error);
    }
  }
}

function toDomain(row: CommunicationDomainRow): CommunicationDomain {
  return { ...row, verifiedAt: row.verifiedAt?.toISOString() ?? null, lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toSender(row: CommunicationSenderRow): CommunicationSender {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toTemplate(row: CommunicationTemplateRow): CommunicationTemplate {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toSegment(row: AudienceSegmentRow): AudienceSegment {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toOptOut(row: OptOutRow): OptOut {
  return { ...row, optedOutAt: row.optedOutAt.toISOString() };
}

function toCreditEntry(row: CreditEntryRow): CreditEntry {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function toMessage(row: CommunicationMessageRow): CommunicationMessage {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toDelivery(row: CommunicationDeliveryRow): CommunicationDelivery {
  return { ...row, sentAt: row.sentAt?.toISOString() ?? null, failedAt: row.failedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}
