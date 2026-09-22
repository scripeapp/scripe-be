export type TicketStatus = "open" | "in_progress" | "waiting_on_user" | "resolved" | "closed";
export type TicketPriority = "low" | "medium" | "high" | "urgent";
export type TicketCategory = "billing" | "technical" | "feature_request" | "account" | "other";

export interface TicketRow {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly category: TicketCategory;
  readonly priority: TicketPriority;
  readonly status: TicketStatus;
  readonly businessId: string | null;
  readonly submitterId: string | null;
  readonly submitterEmail: string | null;
  readonly assignedTo: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Ticket extends Omit<TicketRow, "resolvedAt" | "createdAt" | "updatedAt"> {
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TicketWithReplies extends Ticket {
  readonly replies: TicketReply[];
}

export interface TicketReplyRow {
  readonly id: string;
  readonly ticketId: string;
  readonly body: string;
  readonly authorId: string | null;
  readonly authorEmail: string | null;
  readonly isInternal: boolean;
  readonly createdAt: Date;
}

export interface TicketReply extends Omit<TicketReplyRow, "createdAt"> {
  readonly createdAt: string;
}

export interface HelpdeskOperation {
  readonly userId: string;
  readonly requestId: string;
}

export interface CreateTicketInput {
  readonly subject: string;
  readonly description: string;
  readonly category: TicketCategory;
  readonly priority?: TicketPriority;
  readonly businessId?: string | null;
}

export interface CreateReplyInput {
  readonly body: string;
}
