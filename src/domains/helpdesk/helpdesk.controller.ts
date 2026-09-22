import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./helpdesk.schemas.js";
import type { HelpdeskService } from "./helpdesk.service.js";
import type { HelpdeskOperation } from "./helpdesk.types.js";

export class HelpdeskController {
  constructor(private readonly service: HelpdeskService) {}

  readonly list = this.handle(async (request) => {
    const { status } = schemas.listQuerySchema.parse(request.query);
    return { tickets: await this.service.list(this.operation(request), status) };
  });

  readonly create = this.handle(async (request) => ({
    ticket: await this.service.createTicket(this.operation(request), schemas.createTicketSchema.parse(request.body)),
  }), 201);

  readonly get = this.handle(async (request) => {
    const { ticketId } = schemas.ticketParamsSchema.parse(request.params);
    return { ticket: await this.service.get(this.operation(request), ticketId) };
  });

  readonly reply = this.handle(async (request) => {
    const { ticketId } = schemas.ticketParamsSchema.parse(request.params);
    return { reply: await this.service.reply(this.operation(request), ticketId, schemas.createReplySchema.parse(request.body)) };
  }, 201);

  private operation(request: Request): HelpdeskOperation {
    return {
      userId: requireAuthContext(request).userId,
      requestId: request.requestId,
    };
  }

  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      try {
        ApiResponse.success(response, await work(request), statusCode);
      } catch (error) {
        next(error);
      }
    };
  }
}
