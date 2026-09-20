import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { CreateTicketInput, TicketReplyRow, TicketRow } from "./helpdesk.types.js";

const TICKET_COLUMNS = [
  "id", "subject", "description", "category", "priority", "status",
  "businessId", "submitterId", "submitterEmail", "assignedTo", "resolvedAt", "createdAt", "updatedAt",
] as const;

const REPLY_COLUMNS = ["id", "ticketId", "body", "authorId", "authorEmail", "isInternal", "createdAt"] as const;

/** The generated columns type category/priority/status as plain `string`; the DB CHECK constraints guarantee the narrower unions at runtime. */
function asTicketRow(row: Record<string, unknown>): TicketRow {
  return row as unknown as TicketRow;
}

export async function findSubmitterEmail(context: DatabaseContext, userId: string): Promise<string | undefined> {
  const result = await sql<{ email: string }>`select "email" from auth.user where "id" = ${userId}::uuid`.execute(context.transaction);
  return result.rows[0]?.email;
}

export async function verifyBusinessMembership(context: DatabaseContext, userId: string, businessId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    select "id" from app.business_memberships
    where "businessId" = ${businessId}::uuid and "userId" = ${userId}::uuid and "status" = 'active'
    limit 1
  `.execute(context.transaction);
  return result.rows.length > 0;
}

export async function createTicket(context: DatabaseContext, userId: string, submitterEmail: string | undefined, input: CreateTicketInput): Promise<TicketRow> {
  return context.transaction
    .insertInto("support_tickets")
    .values({
      subject: input.subject,
      description: input.description,
      category: input.category,
      priority: input.priority ?? "medium",
      status: "open",
      businessId: input.businessId ?? null,
      submitterId: userId,
      submitterEmail: submitterEmail ?? null,
    })
    .returning(TICKET_COLUMNS)
    .executeTakeFirstOrThrow()
    .then(asTicketRow);
}

export async function listForSubmitter(context: DatabaseContext, userId: string, status?: string): Promise<TicketRow[]> {
  let query = context.transaction
    .selectFrom("support_tickets")
    .select(TICKET_COLUMNS)
    .where("submitterId", "=", userId);
  if (status) query = query.where("status", "=", status);
  const rows = await query.orderBy("createdAt", "desc").execute();
  return rows.map(asTicketRow);
}

export async function findForSubmitter(context: DatabaseContext, userId: string, ticketId: string): Promise<TicketRow | undefined> {
  const row = await context.transaction
    .selectFrom("support_tickets")
    .select(TICKET_COLUMNS)
    .where("submitterId", "=", userId)
    .where("id", "=", ticketId)
    .executeTakeFirst();
  return row ? asTicketRow(row) : undefined;
}

/** Excludes internal staff notes — this slice only ever creates non-internal replies, but this stays safe if a future staff-reply path adds any. */
export async function listPublicReplies(context: DatabaseContext, ticketId: string): Promise<TicketReplyRow[]> {
  return context.transaction
    .selectFrom("support_ticket_replies")
    .select(REPLY_COLUMNS)
    .where("ticketId", "=", ticketId)
    .where("isInternal", "=", false)
    .orderBy("createdAt", "asc")
    .execute();
}

export async function createReply(context: DatabaseContext, ticketId: string, userId: string, authorEmail: string | undefined, body: string): Promise<TicketReplyRow> {
  return context.transaction
    .insertInto("support_ticket_replies")
    .values({ ticketId, body, authorId: userId, authorEmail: authorEmail ?? null, isInternal: false })
    .returning(REPLY_COLUMNS)
    .executeTakeFirstOrThrow();
}

export async function reopenIfOpen(context: DatabaseContext, ticketId: string): Promise<void> {
  await context.transaction
    .updateTable("support_tickets")
    .set({ status: "in_progress" })
    .where("id", "=", ticketId)
    .where("status", "=", "open")
    .execute();
}
