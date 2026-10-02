import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import type { InvoicesService } from "./invoices.service.js";
import * as schemas from "./invoices.schemas.js";
import type { InvoiceOperation } from "./invoices.types.js";

export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  readonly list = this.handle(async (req) => {
    const p = schemas.businessParams.parse(req.params);
    const q = schemas.listInvoicesQuery.parse(req.query);
    const invoices = await this.service.list(this.operation(req, p.businessId), q);
    return { invoices };
  });

  readonly getMetrics = this.handle(async (req) => {
    const p = schemas.businessParams.parse(req.params);
    const metrics = await this.service.getMetrics(this.operation(req, p.businessId));
    return { metrics };
  });

  readonly getNextNumber = this.handle(async (req) => {
    const p = schemas.businessParams.parse(req.params);
    const nextNumber = await this.service.getNextNumber(this.operation(req, p.businessId));
    return { nextNumber };
  });

  readonly createDraft = this.handle(async (req) => {
    const p = schemas.businessParams.parse(req.params);
    const body = schemas.createInvoiceSchema.parse(req.body);
    const invoice = await this.service.createDraft(this.operation(req, p.businessId), body);
    return { invoice };
  }, 201);

  readonly get = this.handle(async (req) => {
    const p = schemas.params.parse(req.params);
    const invoice = await this.service.get(this.operation(req, p.businessId), p.invoiceId);
    return { invoice };
  });

  readonly updateDraft = this.handle(async (req) => {
    const p = schemas.params.parse(req.params);
    const body = schemas.updateInvoiceSchema.parse(req.body);
    const invoice = await this.service.updateDraft(this.operation(req, p.businessId), p.invoiceId, body);
    return { invoice };
  });

  readonly deleteDraft = this.handle(async (req) => {
    const p = schemas.params.parse(req.params);
    await this.service.deleteDraft(this.operation(req, p.businessId), p.invoiceId);
    return { success: true };
  });

  readonly send = this.handle(async (req) => {
    const p = schemas.params.parse(req.params);
    schemas.sendInvoiceSchema.parse(req.body ?? {});
    const invoice = await this.service.send(this.operation(req, p.businessId), p.invoiceId);
    return { invoice };
  });

  readonly recordPayment = this.handle(async (req) => {
    const p = schemas.params.parse(req.params);
    const body = schemas.recordPaymentSchema.parse(req.body);
    const invoice = await this.service.recordPayment(this.operation(req, p.businessId), p.invoiceId, body);
    return { invoice };
  });

  readonly void = this.handle(async (req) => {
    const p = schemas.params.parse(req.params);
    const invoice = await this.service.void(this.operation(req, p.businessId), p.invoiceId);
    return { invoice };
  });

  readonly sendReminder = this.handle(async (req) => {
    const p = schemas.params.parse(req.params);
    const res = await this.service.sendReminder(this.operation(req, p.businessId), p.invoiceId);
    return res;
  });

  readonly getPublic = this.handle(async (req) => {
    const p = schemas.publicTokenParams.parse(req.params);
    const invoice = await this.service.getPublicInvoice(req.requestId, p.token);
    return { invoice };
  });

  readonly payPublic = this.handle(async (req) => {
    const p = schemas.publicTokenParams.parse(req.params);
    // The amount and the return URL are decided server-side; any body is ignored.
    const checkout = await this.service.initiatePublicPayment(req.requestId, p.token);
    return checkout;
  });

  readonly reportTransferPublic = this.handle(async (req) => {
    const p = schemas.publicTokenParams.parse(req.params);
    return this.service.reportPublicTransfer(req.requestId, p.token);
  });

  readonly duplicate = this.handle(async (req) => {
    const p = schemas.params.parse(req.params);
    const invoice = await this.service.duplicate(this.operation(req, p.businessId), p.invoiceId);
    return { invoice };
  }, 201);

  private operation(request: Request, businessId: string): InvoiceOperation {
    return {
      userId: requireAuthContext(request).userId,
      businessId,
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
