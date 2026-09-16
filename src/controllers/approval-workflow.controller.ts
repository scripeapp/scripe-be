import { Response } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { ApprovalWorkflowService, ApprovalSubjectType } from "../services/approval-workflow.service";
import { StoreService } from "../services/store.service";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";

/**
 * A decideApproval outcome only tracks the approval chain itself —
 * something has to actually update the underlying bill/transfer once a
 * request resolves. This dispatches on subject_type; a still-pending
 * outcome (mid-chain, more steps to go) is a no-op here.
 */
async function finalizeApprovalOutcome(
  supabase: SupabaseClient,
  outcome: { requestStatus: "pending" | "approved" | "rejected"; subjectType: ApprovalSubjectType; subjectId: string },
): Promise<void> {
  if (outcome.requestStatus === "pending") return;

  if (outcome.subjectType === "bill") {
    const { data: bill, error } = await supabase
      .from("supplier_bills")
      .select("store_id")
      .eq("id", outcome.subjectId)
      .maybeSingle();
    if (error) throw error;
    if (!bill) return; // bill was deleted mid-flight — nothing left to finalize

    const storeService = new StoreService(supabase);
    if (outcome.requestStatus === "approved") {
      await storeService.approveBill(bill.store_id, outcome.subjectId);
    } else {
      await storeService.rejectBill(bill.store_id, outcome.subjectId);
    }
    return;
  }

  if (outcome.subjectType === "bill_transfer") {
    const storeService = new StoreService(supabase);
    if (outcome.requestStatus === "approved") {
      await storeService.executeBillTransfer(outcome.subjectId);
    } else {
      await storeService.cancelBillTransfer(outcome.subjectId, "Rejected by approver");
    }
    return;
  }

  // 'withdrawal' finalization isn't wired yet — that subject type isn't
  // produced by gateSubmission anywhere yet either.
}

export class ApprovalWorkflowController {
  listWorkflows = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id, creator_name, creator_email } = req.query as {
        business_id: string;
        creator_name?: string;
        creator_email?: string;
      };
      const service = new ApprovalWorkflowService(req.supabase);
      const creator = creator_email && req.user_id
        ? { id: req.user_id, name: creator_name, email: creator_email }
        : undefined;
      const workflows = await service.listWorkflows(business_id, creator);
      return ApiResponse.success(res, "Approval workflows retrieved", workflows);
    } catch (error: any) {
      return this.handleError(res, "listWorkflows", error);
    }
  };

  getWorkflow = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id } = req.query as { business_id: string };
      const service = new ApprovalWorkflowService(req.supabase);
      const workflow = await service.getWorkflow(business_id, req.params.id);
      return ApiResponse.success(res, "Approval workflow retrieved", workflow);
    } catch (error: any) {
      return this.handleError(res, "getWorkflow", error);
    }
  };

  createWorkflow = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id, ...payload } = req.body;
      const service = new ApprovalWorkflowService(req.supabase);
      const workflow = await service.createWorkflow(business_id, req.user_id ?? null, payload);
      return ApiResponse.created(res, "Approval workflow created", workflow);
    } catch (error: any) {
      return this.handleError(res, "createWorkflow", error);
    }
  };

  updateWorkflow = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id, ...payload } = req.body;
      const service = new ApprovalWorkflowService(req.supabase);
      const workflow = await service.updateWorkflow(business_id, req.params.id, payload);
      return ApiResponse.success(res, "Approval workflow updated", workflow);
    } catch (error: any) {
      return this.handleError(res, "updateWorkflow", error);
    }
  };

  toggleWorkflowStatus = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id } = req.body;
      const service = new ApprovalWorkflowService(req.supabase);
      const workflow = await service.toggleWorkflowStatus(business_id, req.params.id);
      return ApiResponse.success(res, "Approval workflow status toggled", workflow);
    } catch (error: any) {
      return this.handleError(res, "toggleWorkflowStatus", error);
    }
  };

  duplicateWorkflow = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id } = req.body;
      const service = new ApprovalWorkflowService(req.supabase);
      const workflow = await service.duplicateWorkflow(business_id, req.params.id);
      return ApiResponse.created(res, "Approval workflow duplicated", workflow);
    } catch (error: any) {
      return this.handleError(res, "duplicateWorkflow", error);
    }
  };

  deleteWorkflow = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id } = req.query as { business_id: string };
      const service = new ApprovalWorkflowService(req.supabase);
      await service.deleteWorkflow(business_id, req.params.id);
      return ApiResponse.success(res, "Approval workflow deleted", null);
    } catch (error: any) {
      return this.handleError(res, "deleteWorkflow", error);
    }
  };

  listPendingApprovals = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id } = req.query as { business_id: string };
      const service = new ApprovalWorkflowService(req.supabase);
      const requests = await service.listPendingApprovalsForUser(business_id, req.user_id!);
      const enriched = await this.enrichPendingApprovals(req.supabase, requests);
      return ApiResponse.success(res, "Pending approvals retrieved", enriched);
    } catch (error: any) {
      return this.handleError(res, "listPendingApprovals", error);
    }
  };

  /**
   * The runtime approval_requests table is deliberately subject-agnostic
   * (just subject_type + subject_id, no FK) — an approver-facing list needs
   * to say WHAT each request actually is (which bill, which vendor) and WHO
   * submitted it, so this fills those in with a few batched lookups rather
   * than the service layer knowing about bills/suppliers/users at all.
   */
  private async enrichPendingApprovals(supabase: SupabaseClient, requests: any[]) {
    if (requests.length === 0) return requests;

    // 'bill_transfer' requests are keyed by a supplier_payments id, not a
    // bill id directly — resolve that hop first so both subject types can
    // be looked up by bill id afterward.
    const paymentIds = requests.filter((r) => r.subject_type === "bill_transfer").map((r) => r.subject_id);
    const paymentToBillId = new Map<string, string>();
    if (paymentIds.length > 0) {
      const { data: payments } = await supabase
        .from("supplier_payments")
        .select("id, bill_id")
        .in("id", paymentIds);
      for (const p of payments ?? []) paymentToBillId.set(p.id, p.bill_id);
    }

    const billIds = new Set<string>();
    for (const r of requests) {
      if (r.subject_type === "bill") billIds.add(r.subject_id);
      if (r.subject_type === "bill_transfer") {
        const billId = paymentToBillId.get(r.subject_id);
        if (billId) billIds.add(billId);
      }
    }

    const billById = new Map<string, { bill_number: string; supplier_id: string }>();
    if (billIds.size > 0) {
      const { data: bills } = await supabase
        .from("supplier_bills")
        .select("id, bill_number, supplier_id")
        .in("id", Array.from(billIds));
      for (const b of bills ?? []) billById.set(b.id, { bill_number: b.bill_number, supplier_id: b.supplier_id });
    }

    const supplierIds = Array.from(new Set(Array.from(billById.values()).map((b) => b.supplier_id)));
    const supplierNameById = new Map<string, string>();
    if (supplierIds.length > 0) {
      const { data: suppliers } = await supabase.from("suppliers").select("id, name").in("id", supplierIds);
      for (const s of suppliers ?? []) supplierNameById.set(s.id, s.name);
    }

    const requesterIds = Array.from(new Set(requests.map((r) => r.requested_by).filter(Boolean)));
    const requesterNameById = new Map<string, string>();
    if (requesterIds.length > 0) {
      const { data: users } = await supabase.from("users").select("id, name").in("id", requesterIds);
      for (const u of users ?? []) requesterNameById.set(u.id, u.name);
    }

    return requests.map((r) => {
      const billId = r.subject_type === "bill" ? r.subject_id : paymentToBillId.get(r.subject_id);
      const bill = billId ? billById.get(billId) : undefined;
      return {
        ...r,
        bill_number: bill?.bill_number ?? null,
        supplier_name: bill ? (supplierNameById.get(bill.supplier_id) ?? null) : null,
        requested_by_name: requesterNameById.get(r.requested_by) ?? null,
      };
    });
  }

  approveRequest = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id } = req.body;
      const service = new ApprovalWorkflowService(req.supabase);
      const outcome = await service.decideApproval(business_id, req.params.requestId, req.user_id!, "approved");
      await finalizeApprovalOutcome(req.supabase, outcome);
      return ApiResponse.success(res, "Approval recorded", outcome);
    } catch (error: any) {
      return this.handleError(res, "approveRequest", error);
    }
  };

  rejectRequest = async (req: SupabaseRequest, res: Response) => {
    try {
      const { business_id } = req.body;
      const service = new ApprovalWorkflowService(req.supabase);
      const outcome = await service.decideApproval(business_id, req.params.requestId, req.user_id!, "rejected");
      await finalizeApprovalOutcome(req.supabase, outcome);
      return ApiResponse.success(res, "Rejection recorded", outcome);
    } catch (error: any) {
      return this.handleError(res, "rejectRequest", error);
    }
  };

  private handleError(res: Response, action: string, error: any) {
    console.error(`[ApprovalWorkflowController.${action}] Error:`, error);
    return ApiResponse.error(
      res,
      error?.message || "Approval workflow request failed",
      error?.statusCode || 500,
      error?.details,
    );
  }
}
