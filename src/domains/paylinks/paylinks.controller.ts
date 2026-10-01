import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./paylinks.schemas.js";
import type { PaylinksService } from "./paylinks.service.js";
import type { AnonymousOperation, PaylinkOperation } from "./paylinks.types.js";

export class PaylinksController {
  constructor(private readonly service: PaylinksService) {}

  readonly list = this.handle(async (req) => {
    const { businessId } = schemas.businessParamsSchema.parse(req.params);
    const query = schemas.listPaylinksQuerySchema.parse(req.query);
    return this.service.listPaylinks(this.operation(req, businessId), query);
  });

  readonly create = this.handle(async (req) => {
    const { businessId } = schemas.businessParamsSchema.parse(req.params);
    const body = schemas.createPaylinkSchema.parse(req.body);
    const paylink = await this.service.createPaylink(this.operation(req, businessId), body);
    return { paylink };
  }, 201);

  readonly get = this.handle(async (req) => {
    const { businessId, paylinkId } = schemas.paylinkParamsSchema.parse(req.params);
    const paylink = await this.service.getPaylink(this.operation(req, businessId), paylinkId);
    return { paylink };
  });

  readonly update = this.handle(async (req) => {
    const { businessId, paylinkId } = schemas.paylinkParamsSchema.parse(req.params);
    const body = schemas.updatePaylinkSchema.parse(req.body);
    const paylink = await this.service.updatePaylink(this.operation(req, businessId), paylinkId, body);
    return { paylink };
  });

  readonly archive = this.handle(async (req) => {
    const { businessId, paylinkId } = schemas.paylinkParamsSchema.parse(req.params);
    await this.service.archivePaylink(this.operation(req, businessId), paylinkId);
    return { success: true };
  });

  readonly payments = this.handle(async (req) => {
    const { businessId, paylinkId } = schemas.paylinkParamsSchema.parse(req.params);
    const payments = await this.service.listPayments(this.operation(req, businessId), paylinkId);
    return { payments };
  });

  // Public Anonymous Endpoints
  readonly getPublic = this.handle(async (req) => {
    const { slug } = schemas.publicPaylinkParamsSchema.parse(req.params);
    const paylink = await this.service.getPublicPaylink(this.anonymousOp(req), slug);
    return { paylink };
  });

  readonly checkoutPublic = this.handle(async (req) => {
    const { slug } = schemas.publicPaylinkParamsSchema.parse(req.params);
    const body = schemas.publicCheckoutSchema.parse(req.body);
    const checkout = await this.service.checkoutPublic(this.anonymousOp(req), slug, body);
    return { checkout };
  }, 201);

  readonly getCheckoutStatus = this.handle(async (req) => {
    const { reference } = schemas.publicStatusParamsSchema.parse(req.params);
    const status = await this.service.getCheckoutStatus(this.anonymousOp(req), reference);
    return { status };
  });

  private operation(req: Request, businessId: string): PaylinkOperation {
    const auth = requireAuthContext(req);
    return {
      userId: auth.userId,
      businessId,
      requestId: req.requestId,
    };
  }

  private anonymousOp(req: Request): AnonymousOperation {
    return {
      requestId: req.requestId,
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
