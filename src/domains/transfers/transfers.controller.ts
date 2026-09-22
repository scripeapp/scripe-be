import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./transfers.schemas.js";
import type { TransfersService } from "./transfers.service.js";
import type { TransfersOperation } from "./transfers.types.js";

export class TransfersController {
  constructor(private readonly service: TransfersService) {}

  readonly listBeneficiaries = this.handle(async (request) => ({
    beneficiaries: await this.service.listBeneficiaries(this.operation(request)),
  }));

  readonly getBeneficiary = this.handle(async (request) => {
    const { beneficiaryId } = schemas.beneficiaryParamsSchema.parse(request.params);
    return { beneficiary: await this.service.getBeneficiary(this.operation(request), beneficiaryId) };
  });

  readonly createBeneficiary = this.handle(async (request) => {
    const body = schemas.createBeneficiarySchema.parse(request.body);
    return { beneficiary: await this.service.createBeneficiary(this.operation(request), body) };
  }, 201);

  readonly archiveBeneficiary = this.handle(async (request) => {
    const { beneficiaryId } = schemas.beneficiaryParamsSchema.parse(request.params);
    return { beneficiary: await this.service.archiveBeneficiary(this.operation(request), beneficiaryId) };
  });

  readonly listTransfers = this.handle(async (request) => {
    const { status, limit } = schemas.listTransfersQuerySchema.parse(request.query);
    return { transfers: await this.service.listTransfers(this.operation(request), status, limit) };
  });

  readonly getTransfer = this.handle(async (request) => {
    const { transferId } = schemas.transferParamsSchema.parse(request.params);
    return { transfer: await this.service.getTransfer(this.operation(request), transferId) };
  });

  readonly requestTransfer = this.handle(async (request) => {
    const body = schemas.requestTransferSchema.parse(request.body);
    return {
      transfer: await this.service.requestTransfer(this.operation(request), {
        beneficiaryId: body.beneficiaryId,
        amountMinor: BigInt(body.amountMinor),
        purpose: body.purpose,
        idempotencyKey: body.idempotencyKey,
        reason: body.reason,
      }),
    };
  }, 201);

  private operation(request: Request): TransfersOperation {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
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
