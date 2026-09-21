import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./subscriptions.schemas.js";
import type { SubscriptionsService } from "./subscriptions.service.js";
import type { PlansOperation, SubscriptionsOperation } from "./subscriptions.types.js";

export class SubscriptionsController {
  constructor(private readonly service: SubscriptionsService) {}

  readonly listPlans = this.handle((request) => this.service.listPlans(this.plansOperation(request)));

  readonly getSubscription = this.handle(async (request) => ({
    subscription: await this.service.getSubscription(this.operation(request, schemas.businessParamsSchema.parse(request.params).businessId)),
  }));

  readonly getUsage = this.handle(async (request) => ({
    usage: await this.service.getUsage(this.operation(request, schemas.businessParamsSchema.parse(request.params).businessId)),
  }));

  readonly getInvoices = this.handle(async (request) => ({
    invoices: await this.service.getInvoices(this.operation(request, schemas.businessParamsSchema.parse(request.params).businessId)),
  }));

  readonly initiateSubscription = this.handle(
    (request) => this.service.initiateSubscription(this.operation(request, schemas.businessParamsSchema.parse(request.params).businessId), schemas.initiateSubscriptionSchema.parse(request.body)),
    201,
  );

  readonly cancelSubscription = this.handle(async (request) => {
    await this.service.cancelSubscription(this.operation(request, schemas.businessParamsSchema.parse(request.params).businessId));
    return null;
  });

  private operation(request: Request, businessId: string): SubscriptionsOperation {
    return { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId };
  }

  private plansOperation(request: Request): PlansOperation {
    return { userId: requireAuthContext(request).userId, requestId: request.requestId };
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
