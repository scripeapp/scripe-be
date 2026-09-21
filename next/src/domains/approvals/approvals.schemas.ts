import { z } from "zod";

const uuid = z.string().uuid();

export const businessParamsSchema = z.object({ businessId: uuid });
export const workflowParamsSchema = z.object({ businessId: uuid, workflowId: uuid });
export const requestParamsSchema = z.object({ businessId: uuid, requestId: uuid });

const approverSchema = z.object({
  userId: uuid.nullable().optional(),
  email: z.string().email().nullable().optional(),
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().max(80).nullable().optional(),
});

const ruleApproverSchema = approverSchema.extend({ position: z.number().int().nonnegative().optional() });

const ruleSchema = z.object({
  rangeLabel: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  minAmountMinor: z.number().int().nonnegative().nullable().optional(),
  maxAmountMinor: z.number().int().nonnegative().nullable().optional(),
  requireAll: z.boolean().optional(),
  sequential: z.boolean().optional(),
  approvers: z.array(ruleApproverSchema).optional(),
});

const groupSchema = z.object({
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(300).nullable().optional(),
  approvers: z.array(approverSchema).optional(),
  rules: z.array(ruleSchema).optional(),
});

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(["withdrawal", "bill_payment", "all"]),
  triggerTitle: z.string().trim().max(160).nullable().optional(),
  triggerSubtitle: z.string().trim().max(300).nullable().optional(),
  noSelfApproval: z.boolean().optional(),
  submitters: z.array(approverSchema).optional(),
  groups: z.array(groupSchema).optional(),
});

export const updateWorkflowSchema = createWorkflowSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const setWorkflowStatusSchema = z.object({ status: z.enum(["active", "inactive"]) });

export const decideSchema = z.object({}).optional();
