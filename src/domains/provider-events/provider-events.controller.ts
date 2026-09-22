import type { NextFunction, Request, Response } from "express";
import { ApiResponse } from "../../shared/api-response.js";
import { authRequiredError } from "../../shared/errors.js";
import type { ProviderEventsService } from "./provider-events.service.js";

/**
 * Webhook endpoints have no authenticated caller — the provider itself is
 * the caller, proven only by its signature — so these routes are mounted
 * without requireAuth, and the body must arrive as a raw Buffer (not
 * express.json()'s parsed object) since signature verification needs the
 * exact bytes the provider signed. See provider-events.routes.ts.
 */
export class ProviderEventsController {
  constructor(private readonly service: ProviderEventsService) {}

  readonly paystack = this.handle((request) => this.service.handlePaystackWebhook(this.rawBody(request), header(request, "x-paystack-signature"), request.requestId));

  readonly flutterwave = this.handle((request) => this.service.handleFlutterwaveWebhook(this.rawBody(request), header(request, "verif-hash"), request.requestId));

  readonly anchor = this.handle((request) => this.service.handleAnchorWebhook(this.rawBody(request), header(request, "x-anchor-signature"), request.requestId));

  readonly brails = this.handle((request) => this.service.handleBrailsWebhook(this.rawBody(request), header(request, "x-brails-signature"), request.requestId));

  readonly shipbubble = this.handle((request) => this.service.handleShipbubbleWebhook(this.rawBody(request), header(request, "x-ship-signature"), request.requestId));

  private rawBody(request: Request): Buffer {
    return request.body as Buffer;
  }

  /**
   * Every webhook that parses and logs successfully gets 200 — including
   * ones we ignore — so the provider stops retrying something we've
   * already recorded. Only an invalid/missing signature gets 401, a
   * genuine "this wasn't really you" signal; anything thrown before that
   * (malformed JSON) falls through to the error handler.
   */
  private handle(work: (request: Request) => Promise<boolean>) {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      try {
        const signatureValid = await work(request);
        if (!signatureValid) throw authRequiredError("Invalid webhook signature");
        ApiResponse.success(response, { received: true }, 200);
      } catch (error) {
        next(error);
      }
    };
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
