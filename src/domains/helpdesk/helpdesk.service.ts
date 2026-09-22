import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError, validationError } from "../../shared/errors.js";
import * as repository from "./helpdesk.repository.js";
import type {
  CreateReplyInput,
  CreateTicketInput,
  HelpdeskOperation,
  Ticket,
  TicketReply,
  TicketReplyRow,
  TicketRow,
  TicketWithReplies,
} from "./helpdesk.types.js";

export class HelpdeskService {
  constructor(private readonly database: Database) {}

  async createTicket(operation: HelpdeskOperation, input: CreateTicketInput): Promise<Ticket> {
    return this.run(operation, async (context) => {
      if (input.businessId && !(await repository.verifyBusinessMembership(context, operation.userId, input.businessId))) {
        throw validationError("You are not a member of this business");
      }
      const email = await repository.findSubmitterEmail(context, operation.userId);
      return toTicket(await repository.createTicket(context, operation.userId, email, input));
    });
  }

  async list(operation: HelpdeskOperation, status?: string): Promise<Ticket[]> {
    return this.run(operation, async (context) => (await repository.listForSubmitter(context, operation.userId, status)).map(toTicket));
  }

  async get(operation: HelpdeskOperation, ticketId: string): Promise<TicketWithReplies> {
    return this.run(operation, async (context) => {
      const ticket = await repository.findForSubmitter(context, operation.userId, ticketId);
      if (!ticket) throw notFoundError("Ticket not found");
      const replies = await repository.listPublicReplies(context, ticketId);
      return { ...toTicket(ticket), replies: replies.map(toReply) };
    });
  }

  async reply(operation: HelpdeskOperation, ticketId: string, input: CreateReplyInput): Promise<TicketReply> {
    return this.run(operation, async (context) => {
      const ticket = await repository.findForSubmitter(context, operation.userId, ticketId);
      if (!ticket) throw notFoundError("Ticket not found");
      const email = await repository.findSubmitterEmail(context, operation.userId);
      const reply = await repository.createReply(context, ticketId, operation.userId, email, input.body);
      if (ticket.status === "open") await repository.reopenIfOpen(context, ticketId);
      return toReply(reply);
    });
  }

  private async run<T>(operation: HelpdeskOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toTicket(row: TicketRow): Ticket {
  return {
    ...row,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toReply(row: TicketReplyRow): TicketReply {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
