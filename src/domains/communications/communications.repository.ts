import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  AudienceSegmentMember,
  AudienceSegmentRow,
  CommunicationChannel,
  CommunicationDeliveryRow,
  CommunicationDomainRow,
  CommunicationMessageRow,
  CommunicationSenderRow,
  CommunicationTemplateRow,
  CreateMessageInput,
  CreateSegmentInput,
  CreateSenderInput,
  CreateTemplateInput,
  CreditEntryKind,
  CreditEntryRow,
  CreditTopupRow,
  DeliveryStatus,
  DnsRecord,
  MessageStatus,
  OptOutRow,
  RecipientCandidate,
  TopupGateway,
  UpdateMessageInput,
  UpdateSegmentInput,
  UpdateSenderInput,
  UpdateTemplateInput,
} from "./communications.types.js";

// ============================================================================
// Sending domains
// ============================================================================

const DOMAIN_COLUMNS = sql`"id", "businessId", "domain", "status", "dnsRecords", "verifiedAt", "lastVerifiedAt", "createdAt", "updatedAt"`;

export async function listDomains(context: DatabaseContext, businessId: string): Promise<CommunicationDomainRow[]> {
  const result = await sql<CommunicationDomainRow>`
    select ${DOMAIN_COLUMNS} from app.communication_domains where "businessId" = ${businessId}::uuid order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findDomain(context: DatabaseContext, businessId: string, domainId: string): Promise<CommunicationDomainRow | undefined> {
  const result = await sql<CommunicationDomainRow>`
    select ${DOMAIN_COLUMNS} from app.communication_domains where "businessId" = ${businessId}::uuid and "id" = ${domainId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createDomain(context: DatabaseContext, businessId: string, domain: string, dnsRecords: DnsRecord[]): Promise<CommunicationDomainRow> {
  const result = await sql<CommunicationDomainRow>`
    insert into app.communication_domains ("businessId", "domain", "dnsRecords")
    values (${businessId}::uuid, ${domain}, ${JSON.stringify(dnsRecords)}::jsonb)
    returning ${DOMAIN_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function markDomainVerification(context: DatabaseContext, businessId: string, domainId: string, verified: boolean): Promise<CommunicationDomainRow | undefined> {
  const result = await sql<CommunicationDomainRow>`
    update app.communication_domains set
      "status" = ${verified ? "verified" : "failed"},
      "verifiedAt" = case when ${verified} then coalesce("verifiedAt", now()) else "verifiedAt" end,
      "lastVerifiedAt" = now()
    where "businessId" = ${businessId}::uuid and "id" = ${domainId}::uuid
    returning ${DOMAIN_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteDomain(context: DatabaseContext, businessId: string, domainId: string): Promise<boolean> {
  const result = await sql`delete from app.communication_domains where "businessId" = ${businessId}::uuid and "id" = ${domainId}::uuid`.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

// ============================================================================
// Senders
// ============================================================================

const SENDER_COLUMNS = sql`"id", "businessId", "domainId", "name", "email", "isDefault", "isActive", "createdAt", "updatedAt"`;

export async function listSenders(context: DatabaseContext, businessId: string): Promise<CommunicationSenderRow[]> {
  const result = await sql<CommunicationSenderRow>`
    select ${SENDER_COLUMNS} from app.communication_senders where "businessId" = ${businessId}::uuid order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findSender(context: DatabaseContext, businessId: string, senderId: string): Promise<CommunicationSenderRow | undefined> {
  const result = await sql<CommunicationSenderRow>`
    select ${SENDER_COLUMNS} from app.communication_senders where "businessId" = ${businessId}::uuid and "id" = ${senderId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findDefaultSender(context: DatabaseContext, businessId: string): Promise<CommunicationSenderRow | undefined> {
  const result = await sql<CommunicationSenderRow>`
    select ${SENDER_COLUMNS} from app.communication_senders where "businessId" = ${businessId}::uuid and "isDefault" and "isActive"
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createSender(context: DatabaseContext, businessId: string, input: CreateSenderInput): Promise<CommunicationSenderRow> {
  const result = await sql<CommunicationSenderRow>`
    insert into app.communication_senders ("businessId", "name", "email", "domainId")
    values (${businessId}::uuid, ${input.name}, ${input.email}, ${input.domainId ?? null}::uuid)
    returning ${SENDER_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateSender(context: DatabaseContext, businessId: string, senderId: string, input: UpdateSenderInput): Promise<CommunicationSenderRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name" = ${input.name}`);
  if (input.isActive !== undefined) fields.push(sql`"isActive" = ${input.isActive}`);
  if (fields.length === 0) return findSender(context, businessId, senderId);

  const result = await sql<CommunicationSenderRow>`
    update app.communication_senders set ${sql.join(fields, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${senderId}::uuid
    returning ${SENDER_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

/** Two statements, not one: the partial unique index on isDefault is checked per-statement, so clearing every default first (zero rows true) then setting the new one (exactly one row true) never collides. */
export async function setDefaultSender(context: DatabaseContext, businessId: string, senderId: string): Promise<CommunicationSenderRow | undefined> {
  await sql`update app.communication_senders set "isDefault" = false where "businessId" = ${businessId}::uuid and "isDefault"`.execute(context.transaction);
  const result = await sql<CommunicationSenderRow>`
    update app.communication_senders set "isDefault" = true
    where "businessId" = ${businessId}::uuid and "id" = ${senderId}::uuid
    returning ${SENDER_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteSender(context: DatabaseContext, businessId: string, senderId: string): Promise<boolean> {
  const result = await sql`delete from app.communication_senders where "businessId" = ${businessId}::uuid and "id" = ${senderId}::uuid`.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

// ============================================================================
// Templates
// ============================================================================

const TEMPLATE_COLUMNS = sql`"id", "businessId", "channel", "name", "subject", "body", "isActive", "createdBy", "createdAt", "updatedAt"`;

export async function listTemplates(context: DatabaseContext, businessId: string, channel: CommunicationChannel | undefined): Promise<CommunicationTemplateRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`"businessId" = ${businessId}::uuid`];
  if (channel) clauses.push(sql`"channel" = ${channel}`);
  const result = await sql<CommunicationTemplateRow>`
    select ${TEMPLATE_COLUMNS} from app.communication_templates where ${sql.join(clauses, sql` and `)} order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findTemplate(context: DatabaseContext, businessId: string, templateId: string): Promise<CommunicationTemplateRow | undefined> {
  const result = await sql<CommunicationTemplateRow>`
    select ${TEMPLATE_COLUMNS} from app.communication_templates where "businessId" = ${businessId}::uuid and "id" = ${templateId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createTemplate(context: DatabaseContext, businessId: string, createdBy: string, input: CreateTemplateInput): Promise<CommunicationTemplateRow> {
  const result = await sql<CommunicationTemplateRow>`
    insert into app.communication_templates ("businessId", "channel", "name", "subject", "body", "createdBy")
    values (${businessId}::uuid, ${input.channel}, ${input.name}, ${input.subject ?? null}, ${input.body}, ${createdBy}::uuid)
    returning ${TEMPLATE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateTemplate(context: DatabaseContext, businessId: string, templateId: string, input: UpdateTemplateInput): Promise<CommunicationTemplateRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name" = ${input.name}`);
  if (input.subject !== undefined) fields.push(sql`"subject" = ${input.subject}`);
  if (input.body !== undefined) fields.push(sql`"body" = ${input.body}`);
  if (input.isActive !== undefined) fields.push(sql`"isActive" = ${input.isActive}`);
  if (fields.length === 0) return findTemplate(context, businessId, templateId);

  const result = await sql<CommunicationTemplateRow>`
    update app.communication_templates set ${sql.join(fields, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${templateId}::uuid
    returning ${TEMPLATE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteTemplate(context: DatabaseContext, businessId: string, templateId: string): Promise<boolean> {
  const result = await sql`delete from app.communication_templates where "businessId" = ${businessId}::uuid and "id" = ${templateId}::uuid`.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

// ============================================================================
// Audience segments
// ============================================================================

const SEGMENT_COLUMNS = sql`"id", "businessId", "name", "description", "createdBy", "createdAt", "updatedAt"`;

export async function listSegments(context: DatabaseContext, businessId: string): Promise<AudienceSegmentRow[]> {
  const result = await sql<AudienceSegmentRow>`
    select ${SEGMENT_COLUMNS} from app.communication_audience_segments where "businessId" = ${businessId}::uuid order by "name"
  `.execute(context.transaction);
  return result.rows;
}

export async function findSegment(context: DatabaseContext, businessId: string, segmentId: string): Promise<AudienceSegmentRow | undefined> {
  const result = await sql<AudienceSegmentRow>`
    select ${SEGMENT_COLUMNS} from app.communication_audience_segments where "businessId" = ${businessId}::uuid and "id" = ${segmentId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createSegment(context: DatabaseContext, businessId: string, createdBy: string, input: CreateSegmentInput): Promise<AudienceSegmentRow> {
  const result = await sql<AudienceSegmentRow>`
    insert into app.communication_audience_segments ("businessId", "name", "description", "createdBy")
    values (${businessId}::uuid, ${input.name}, ${input.description ?? null}, ${createdBy}::uuid)
    returning ${SEGMENT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateSegment(context: DatabaseContext, businessId: string, segmentId: string, input: UpdateSegmentInput): Promise<AudienceSegmentRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name" = ${input.name}`);
  if (input.description !== undefined) fields.push(sql`"description" = ${input.description}`);
  if (fields.length === 0) return findSegment(context, businessId, segmentId);

  const result = await sql<AudienceSegmentRow>`
    update app.communication_audience_segments set ${sql.join(fields, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${segmentId}::uuid
    returning ${SEGMENT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteSegment(context: DatabaseContext, businessId: string, segmentId: string): Promise<boolean> {
  const result = await sql`delete from app.communication_audience_segments where "businessId" = ${businessId}::uuid and "id" = ${segmentId}::uuid`.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

export async function addSegmentMembers(context: DatabaseContext, segmentId: string, partyIds: readonly string[]): Promise<void> {
  if (partyIds.length === 0) return;
  await sql`
    insert into app.communication_audience_segment_members ("segmentId", "partyId")
    select ${segmentId}::uuid, value::uuid from jsonb_array_elements_text(${JSON.stringify(partyIds)}::jsonb) value
    on conflict do nothing
  `.execute(context.transaction);
}

export async function removeSegmentMember(context: DatabaseContext, segmentId: string, partyId: string): Promise<boolean> {
  const result = await sql`
    delete from app.communication_audience_segment_members where "segmentId" = ${segmentId}::uuid and "partyId" = ${partyId}::uuid
  `.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

export async function listSegmentMembers(context: DatabaseContext, segmentId: string): Promise<AudienceSegmentMember[]> {
  const result = await sql<AudienceSegmentMember>`
    select member."partyId", party."displayName", member."addedAt"
    from app.communication_audience_segment_members member
    join app.parties party on party."id" = member."partyId"
    where member."segmentId" = ${segmentId}::uuid
    order by member."addedAt" desc
  `.execute(context.transaction);
  return result.rows;
}

// ============================================================================
// Opt-outs
// ============================================================================

const OPT_OUT_COLUMNS = sql`"id", "businessId", "partyId", "channel", "reason", "optedOutAt"`;

export async function listOptOuts(context: DatabaseContext, businessId: string): Promise<OptOutRow[]> {
  const result = await sql<OptOutRow>`
    select ${OPT_OUT_COLUMNS} from app.communication_opt_outs where "businessId" = ${businessId}::uuid order by "optedOutAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function createOptOut(context: DatabaseContext, businessId: string, partyId: string, channel: CommunicationChannel, reason: string | null): Promise<OptOutRow> {
  const result = await sql<OptOutRow>`
    insert into app.communication_opt_outs ("businessId", "partyId", "channel", "reason")
    values (${businessId}::uuid, ${partyId}::uuid, ${channel}, ${reason})
    on conflict ("businessId", "partyId", "channel") do update set "reason" = excluded."reason"
    returning ${OPT_OUT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function deleteOptOut(context: DatabaseContext, businessId: string, partyId: string, channel: CommunicationChannel): Promise<boolean> {
  const result = await sql`
    delete from app.communication_opt_outs where "businessId" = ${businessId}::uuid and "partyId" = ${partyId}::uuid and "channel" = ${channel}
  `.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

// ============================================================================
// Recipient resolution
// ============================================================================

function contactKindFor(channel: CommunicationChannel): "email" | "phone" {
  return channel === "email" ? "email" : "phone";
}

export async function resolveAllCustomerRecipients(context: DatabaseContext, businessId: string, channel: CommunicationChannel): Promise<RecipientCandidate[]> {
  const result = await sql<RecipientCandidate>`
    select distinct on (party."id") party."id" as "partyId", contact."value" as "destination"
    from app.parties party
    join app.customer_accounts account on account."partyId" = party."id" and account."businessId" = party."businessId"
    join app.party_contacts contact on contact."partyId" = party."id" and contact."businessId" = party."businessId"
      and contact."kind" = ${contactKindFor(channel)} and contact."status" = 'active' and contact."isPrimary"
    where party."businessId" = ${businessId}::uuid and party."status" = 'active' and account."lifecycleState" in ('lead', 'active')
      and not exists (
        select 1 from app.communication_opt_outs opt_out
        where opt_out."businessId" = party."businessId" and opt_out."partyId" = party."id" and opt_out."channel" = ${channel}
      )
    order by party."id"
  `.execute(context.transaction);
  return result.rows;
}

export async function resolveSegmentRecipients(context: DatabaseContext, segmentId: string, channel: CommunicationChannel): Promise<RecipientCandidate[]> {
  const result = await sql<RecipientCandidate>`
    select distinct on (party."id") party."id" as "partyId", contact."value" as "destination"
    from app.communication_audience_segment_members member
    join app.parties party on party."id" = member."partyId"
    join app.party_contacts contact on contact."partyId" = party."id" and contact."businessId" = party."businessId"
      and contact."kind" = ${contactKindFor(channel)} and contact."status" = 'active' and contact."isPrimary"
    where member."segmentId" = ${segmentId}::uuid and party."status" = 'active'
      and not exists (
        select 1 from app.communication_opt_outs opt_out
        where opt_out."businessId" = party."businessId" and opt_out."partyId" = party."id" and opt_out."channel" = ${channel}
      )
    order by party."id"
  `.execute(context.transaction);
  return result.rows;
}

// ============================================================================
// Credits
// ============================================================================

export async function ensureCreditAccount(context: DatabaseContext, businessId: string): Promise<void> {
  await sql`
    insert into app.communication_credit_accounts ("businessId") values (${businessId}::uuid) on conflict do nothing
  `.execute(context.transaction);
}

export async function getCreditBalance(context: DatabaseContext, businessId: string): Promise<string> {
  await ensureCreditAccount(context, businessId);
  const result = await sql<{ balance: string }>`
    select "balance"::text as "balance" from app.communication_credit_accounts where "businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  return result.rows[0]?.balance ?? "0";
}

export async function listCreditEntries(context: DatabaseContext, businessId: string, limit: number): Promise<CreditEntryRow[]> {
  const result = await sql<CreditEntryRow>`
    select "id", "businessId", "kind", "credits"::text as "credits", "balanceAfter"::text as "balanceAfter", "referenceType", "referenceId", "metadata", "createdAt"
    from app.communication_credit_entries where "businessId" = ${businessId}::uuid
    order by "createdAt" desc limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}

/** Locks the account row, applies a signed credit delta, and appends the immutable ledger entry - all within the caller's transaction. Throws (via the check constraint) if a debit would take the balance negative. */
export async function applyCreditDelta(
  context: DatabaseContext,
  businessId: string,
  kind: CreditEntryKind,
  signedCredits: bigint,
  reference: { type: "topup" | "message"; id: string } | null,
  metadata: Record<string, unknown>,
): Promise<string> {
  await ensureCreditAccount(context, businessId);
  const locked = await sql<{ balance: string }>`
    select "balance"::text as "balance" from app.communication_credit_accounts where "businessId" = ${businessId}::uuid for update
  `.execute(context.transaction);
  const currentBalance = BigInt(locked.rows[0]?.balance ?? "0");
  const nextBalance = currentBalance + signedCredits;
  if (nextBalance < 0n) throw Object.assign(new Error("Insufficient communication credits"), { code: "INSUFFICIENT_CREDITS" });

  await sql`
    update app.communication_credit_accounts set "balance" = ${nextBalance.toString()}::bigint where "businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  await sql`
    insert into app.communication_credit_entries ("businessId", "kind", "credits", "balanceAfter", "referenceType", "referenceId", "metadata")
    values (${businessId}::uuid, ${kind}, ${signedCredits.toString()}::bigint, ${nextBalance.toString()}::bigint, ${reference?.type ?? null}, ${reference?.id ?? null}::uuid, ${JSON.stringify(metadata)}::jsonb)
  `.execute(context.transaction);
  return nextBalance.toString();
}

export async function createTopup(
  context: DatabaseContext,
  businessId: string,
  createdBy: string,
  input: { credits: number; amountMinor: string; assetCode: string; gateway: TopupGateway; providerReference: string },
): Promise<CreditTopupRow> {
  const result = await sql<CreditTopupRow>`
    insert into app.communication_credit_topups ("businessId", "credits", "amountMinor", "assetCode", "gateway", "providerReference", "createdBy")
    values (${businessId}::uuid, ${input.credits}::bigint, ${input.amountMinor}::bigint, ${input.assetCode}, ${input.gateway}, ${input.providerReference}, ${createdBy}::uuid)
    returning "id", "businessId", "credits"::text as "credits", "amountMinor"::text as "amountMinor", "assetCode", "gateway", "providerReference", "status", "createdBy", "createdAt", "completedAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export interface CompletedTopup {
  readonly found: boolean;
  readonly alreadyCompleted: boolean;
  readonly businessId: string | null;
  readonly credits: string | null;
}

/**
 * Called from the provider-events webhook context (an anonymous principal,
 * not a business-authorized one - webhooks run as scripe_app with no caller
 * business context, and there is no separate scripe_worker-authenticated
 * connection in this codebase). Goes through a security-definer function
 * rather than a direct UPDATE, the same escape hatch
 * capture_checkout_payment_from_webhook already established for the
 * payments domain's identical problem. Idempotent: only a still-pending
 * topup transitions, so a duplicate webhook delivery is a no-op.
 */
export async function completeTopupByReference(context: DatabaseContext, providerReference: string): Promise<CompletedTopup> {
  const result = await sql<CompletedTopup>`
    select * from app.complete_communication_credit_topup(${providerReference})
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function failTopupByReference(context: DatabaseContext, providerReference: string): Promise<boolean> {
  const result = await sql<{ fail_communication_credit_topup: boolean }>`
    select app.fail_communication_credit_topup(${providerReference})
  `.execute(context.transaction);
  return result.rows[0]?.fail_communication_credit_topup ?? false;
}

// ============================================================================
// Messages
// ============================================================================

const MESSAGE_COLUMNS = sql`
  "id", "businessId", "channel", "name", "status", "templateId", "senderId", "subject", "body",
  "audienceType", "audienceSegmentId", "recipientCount", "sentCount", "failedCount", "creditsSpent"::text as "creditsSpent",
  "createdBy", "createdAt", "updatedAt"
`;

export async function listMessages(context: DatabaseContext, businessId: string, filter: { channel?: CommunicationChannel; status?: MessageStatus }): Promise<CommunicationMessageRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`"businessId" = ${businessId}::uuid`];
  if (filter.channel) clauses.push(sql`"channel" = ${filter.channel}`);
  if (filter.status) clauses.push(sql`"status" = ${filter.status}`);
  const result = await sql<CommunicationMessageRow>`
    select ${MESSAGE_COLUMNS} from app.communication_messages where ${sql.join(clauses, sql` and `)} order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findMessage(context: DatabaseContext, businessId: string, messageId: string): Promise<CommunicationMessageRow | undefined> {
  const result = await sql<CommunicationMessageRow>`
    select ${MESSAGE_COLUMNS} from app.communication_messages where "businessId" = ${businessId}::uuid and "id" = ${messageId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

/** Locks the message row so a concurrent second send attempt can't both pass the draft-status check. */
export async function lockMessage(context: DatabaseContext, businessId: string, messageId: string): Promise<CommunicationMessageRow | undefined> {
  const result = await sql<CommunicationMessageRow>`
    select ${MESSAGE_COLUMNS} from app.communication_messages where "businessId" = ${businessId}::uuid and "id" = ${messageId}::uuid for update
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createMessage(context: DatabaseContext, businessId: string, createdBy: string, input: CreateMessageInput): Promise<CommunicationMessageRow> {
  const result = await sql<CommunicationMessageRow>`
    insert into app.communication_messages (
      "businessId", "channel", "name", "templateId", "senderId", "subject", "body", "audienceType", "audienceSegmentId", "createdBy"
    ) values (
      ${businessId}::uuid, ${input.channel}, ${input.name}, ${input.templateId ?? null}::uuid, ${input.senderId ?? null}::uuid,
      ${input.subject ?? null}, ${input.body ?? null}, ${input.audienceType}, ${input.audienceSegmentId ?? null}::uuid, ${createdBy}::uuid
    )
    returning ${MESSAGE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateMessage(context: DatabaseContext, businessId: string, messageId: string, input: UpdateMessageInput): Promise<CommunicationMessageRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name" = ${input.name}`);
  if (input.templateId !== undefined) fields.push(sql`"templateId" = ${input.templateId}::uuid`);
  if (input.senderId !== undefined) fields.push(sql`"senderId" = ${input.senderId}::uuid`);
  if (input.subject !== undefined) fields.push(sql`"subject" = ${input.subject}`);
  if (input.body !== undefined) fields.push(sql`"body" = ${input.body}`);
  if (input.audienceType !== undefined) fields.push(sql`"audienceType" = ${input.audienceType}`);
  if (input.audienceSegmentId !== undefined) fields.push(sql`"audienceSegmentId" = ${input.audienceSegmentId}::uuid`);
  if (fields.length === 0) return findMessage(context, businessId, messageId);

  const result = await sql<CommunicationMessageRow>`
    update app.communication_messages set ${sql.join(fields, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${messageId}::uuid and "status" = 'draft'
    returning ${MESSAGE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteMessage(context: DatabaseContext, businessId: string, messageId: string): Promise<boolean> {
  const result = await sql`
    delete from app.communication_messages where "businessId" = ${businessId}::uuid and "id" = ${messageId}::uuid and "status" = 'draft'
  `.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

export async function markMessageProcessing(context: DatabaseContext, messageId: string, recipientCount: number): Promise<void> {
  await sql`
    update app.communication_messages set "status" = 'processing', "recipientCount" = ${recipientCount} where "id" = ${messageId}::uuid
  `.execute(context.transaction);
}

export async function finalizeMessage(
  context: DatabaseContext,
  messageId: string,
  fields: { status: MessageStatus; sentCount: number; failedCount: number; creditsSpent: string },
): Promise<void> {
  await sql`
    update app.communication_messages set
      "status" = ${fields.status}, "sentCount" = ${fields.sentCount}, "failedCount" = ${fields.failedCount}, "creditsSpent" = ${fields.creditsSpent}::bigint
    where "id" = ${messageId}::uuid
  `.execute(context.transaction);
}

// ============================================================================
// Deliveries
// ============================================================================

const DELIVERY_COLUMNS = sql`"id", "messageId", "partyId", "destination", "status", "providerMessageId", "errorMessage", "creditCost"::text as "creditCost", "sentAt", "failedAt", "createdAt"`;

export async function createDeliveries(
  context: DatabaseContext,
  messageId: string,
  rows: readonly { partyId: string; destination: string; creditCost: number }[],
): Promise<CommunicationDeliveryRow[]> {
  if (rows.length === 0) return [];
  const values = rows.map((row) => sql`(${messageId}::uuid, ${row.partyId}::uuid, ${row.destination}, ${row.creditCost}::bigint)`);
  const result = await sql<CommunicationDeliveryRow>`
    insert into app.communication_deliveries ("messageId", "partyId", "destination", "creditCost")
    values ${sql.join(values, sql`, `)}
    returning ${DELIVERY_COLUMNS}
  `.execute(context.transaction);
  return result.rows;
}

export async function listDeliveriesForMessage(context: DatabaseContext, messageId: string): Promise<CommunicationDeliveryRow[]> {
  const result = await sql<CommunicationDeliveryRow>`
    select ${DELIVERY_COLUMNS} from app.communication_deliveries where "messageId" = ${messageId}::uuid order by "createdAt"
  `.execute(context.transaction);
  return result.rows;
}

export async function updateDeliveryResult(
  context: DatabaseContext,
  deliveryId: string,
  fields: { status: DeliveryStatus; providerMessageId: string | null; errorMessage: string | null },
): Promise<void> {
  await sql`
    update app.communication_deliveries set
      "status" = ${fields.status},
      "providerMessageId" = ${fields.providerMessageId},
      "errorMessage" = ${fields.errorMessage},
      "sentAt" = case when ${fields.status} = 'sent' then now() else "sentAt" end,
      "failedAt" = case when ${fields.status} = 'failed' then now() else "failedAt" end
    where "id" = ${deliveryId}::uuid
  `.execute(context.transaction);
}
