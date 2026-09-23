/**
 * HTTP adaptation for the bill, bill line, and bill payment allocation domain belongs
 * here. Controllers validate transport concerns and delegate workflows to services.
 */
import type { NextFunction, Request, Response } from "express"; import { requireAuthContext } from "../../middleware/auth.js"; import { ApiResponse } from "../../shared/api-response.js"; import * as schemas from "./payables.schemas.js"; import type { PayablesService } from "./payables.service.js";
export class PayablesController {
  constructor(private readonly service: PayablesService) {}

  readonly listBills = this.handle(async (req) => {
    const p = schemas.params.pick({ businessId: true }).parse(req.params);
    const query = schemas.listBillsQuery.parse(req.query);
    const result = await this.service.listBills(this.op(req, p.businessId), query);
    return { ...result, page: query.page, pageSize: query.pageSize };
  });

  readonly getMetrics = this.handle(async (req) => {
    const p = schemas.params.pick({ businessId: true }).parse(req.params);
    return { metrics: await this.service.getMetrics(this.op(req, p.businessId)) };
  });

  readonly getBill = this.handle(async (req) => {
    const p = schemas.params.required({ billId: true }).parse(req.params);
    return await this.service.getBill(this.op(req, p.businessId), p.billId);
  });

  readonly getBillLines = this.handle(async (req) => {
    const p = schemas.params.required({ billId: true }).parse(req.params);
    return { lines: await this.service.getBillLines(this.op(req, p.businessId), p.billId) };
  });

  readonly createBill = this.handle(async (req) => {
    const p = schemas.params.pick({ businessId: true }).parse(req.params);
    return { bill: await this.service.createBill(this.op(req, p.businessId), schemas.createBill.parse(req.body)) };
  }, 201);

  readonly updateBill = this.handle(async (req) => {
    const p = schemas.params.required({ billId: true }).parse(req.params);
    return { bill: await this.service.updateBill(this.op(req, p.businessId), p.billId, schemas.updateBill.parse(req.body)) };
  });

  readonly approveBill = this.handle(async (req) => {
    const p = schemas.params.required({ billId: true }).parse(req.params);
    return { bill: await this.service.updateBill(this.op(req, p.businessId), p.billId, { status: "approved" }) };
  });

  readonly rejectBill = this.handle(async (req) => {
    const p = schemas.params.required({ billId: true }).parse(req.params);
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    return { bill: await this.service.updateBill(this.op(req, p.businessId), p.billId, { status: "voided", notes: reason }) };
  });

  readonly deleteBill = this.handle(async (req) => {
    const p = schemas.params.required({ billId: true }).parse(req.params);
    return await this.service.deleteBill(this.op(req, p.businessId), p.billId);
  });

  readonly allocatePayment = this.handle(async (req) => {
    const p = schemas.params.required({ billId: true }).parse(req.params);
    return { allocation: await this.service.allocatePayment(this.op(req, p.businessId), p.billId, schemas.allocatePayment.parse(req.body)) };
  }, 201);

  private op(req: Request, businessId: string) {
    return { userId: requireAuthContext(req).userId, businessId, requestId: req.requestId };
  }

  private handle<T>(work: (req: Request) => Promise<T>, statusCode = 200) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        ApiResponse.success(res, await work(req), statusCode);
      } catch (error) {
        next(error);
      }
    };
  }
}
