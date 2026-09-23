import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import type { BankingService } from "../banking/banking.service.js";
import type { PayablesService } from "../payables/payables.service.js";
import * as schemas from "./approvals.schemas.js";
import type { ApprovalsService } from "./approvals.service.js";
import type { ApprovalsOperation } from "./approvals.types.js";

/**
 * Dispatches a decided approval to the domain that owns its subject.
 * Lives here (not in approvals.service.ts) so approvals never imports
 * banking/payables service code — those two import approvals (to gate),
 * so approvals importing them back would be circular.
 */
export class ApprovalsController {
  constructor(
    private readonly service: ApprovalsService,
    private readonly banking: BankingService,
    private readonly payables: PayablesService,
  ) {}

  readonly listWorkflows = this.handle(async (request) => ({ workflows: await this.service.listWorkflows(this.operation(request)) }));

  readonly getWorkflow = this.handle(async (request) => {
    const { workflowId } = schemas.workflowParamsSchema.parse(request.params);
    return { workflow: await this.service.getWorkflow(this.operation(request), workflowId) };
  });

  readonly createWorkflow = this.handle(async (request) => ({ workflow: await this.service.createWorkflow(this.operation(request), schemas.createWorkflowSchema.parse(request.body)) }), 201);

  readonly updateWorkflow = this.handle(async (request) => {
    const { workflowId } = schemas.workflowParamsSchema.parse(request.params);
    return { workflow: await this.service.updateWorkflow(this.operation(request), workflowId, schemas.updateWorkflowSchema.parse(request.body)) };
  });

  readonly setWorkflowStatus = this.handle(async (request) => {
    const { workflowId } = schemas.workflowParamsSchema.parse(request.params);
    const { status } = schemas.setWorkflowStatusSchema.parse(request.body);
    return { workflow: await this.service.setWorkflowStatus(this.operation(request), workflowId, status) };
  });

  readonly toggleWorkflowStatus = this.handle(async (request) => {
    const { workflowId } = schemas.workflowParamsSchema.parse(request.params);
    const wf = await this.service.getWorkflow(this.operation(request), workflowId);
    const nextStatus = wf.status === "active" ? "inactive" : "active";
    return { workflow: await this.service.setWorkflowStatus(this.operation(request), workflowId, nextStatus) };
  });

  readonly duplicateWorkflow = this.handle(async (request) => {
    const { workflowId } = schemas.workflowParamsSchema.parse(request.params);
    return { workflow: await this.service.duplicateWorkflow(this.operation(request), workflowId) };
  }, 201);

  readonly deleteWorkflow = this.handle(async (request) => {
    const { workflowId } = schemas.workflowParamsSchema.parse(request.params);
    await this.service.deleteWorkflow(this.operation(request), workflowId);
    return { deleted: true };
  });

  readonly listPending = this.handle(async (request) => ({ requests: await this.service.listPendingForUser(this.operation(request)) }));

  readonly approve = this.handle(async (request) => {
    const { requestId } = schemas.requestParamsSchema.parse(request.params);
    return { request: await this.decide(this.operation(request), requestId, "approved") };
  });

  readonly reject = this.handle(async (request) => {
    const { requestId } = schemas.requestParamsSchema.parse(request.params);
    return { request: await this.decide(this.operation(request), requestId, "rejected") };
  });

  private async decide(operation: ApprovalsOperation, requestId: string, decision: "approved" | "rejected") {
    const outcome = await this.service.decideApproval(operation, requestId, decision);
    if (outcome.requestStatus !== "pending") {
      if (outcome.subjectType === "withdrawal") {
        await this.banking.finalizeGatedWithdrawal(operation, outcome.subjectId, outcome.requestStatus === "approved" ? "approved" : "rejected");
      } else if (outcome.subjectType === "bill_payment") {
        await this.payables.finalizeGatedPayment(operation, outcome.requestStatus === "approved" ? "approved" : "rejected", outcome.requestedBy, outcome.pendingPayload);
      }
    }
    return outcome;
  }

  private operation(request: Request): ApprovalsOperation {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId };
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
