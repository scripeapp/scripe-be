import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });
export const ownerParamsSchema = businessParamsSchema.extend({ ownerId: z.string().uuid() });
export const caseParamsSchema = businessParamsSchema.extend({ caseId: z.string().uuid() });
export const consentParamsSchema = z.object({ consentId: z.string().uuid() });

const nullableTrimmed = (max: number) => z.string().trim().max(max).nullable().optional();

export const upsertLegalProfileSchema = z.object({
  registeredName: z.string().trim().min(1).max(200),
  registrationNumber: z.string().trim().min(1).max(100),
  taxIdentificationNumber: nullableTrimmed(50),
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()).optional(),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: nullableTrimmed(200),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  postalCode: nullableTrimmed(20),
});

const beneficialOwnerBase = z.object({
  fullName: z.string().trim().min(1).max(200),
  relationship: z.enum(["director", "shareholder", "ultimate_beneficial_owner"]),
  ownershipPercentageBps: z.number().int().min(0).max(10000).nullable().optional(),
  idType: z.enum(["nin", "passport", "drivers_license", "voters_card"]),
  idNumber: z.string().trim().min(1).max(100),
  nationality: z.string().trim().length(2).transform((value) => value.toUpperCase()).optional(),
});

export const createBeneficialOwnerSchema = beneficialOwnerBase;
export const updateBeneficialOwnerSchema = beneficialOwnerBase
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const openCaseSchema = z.object({});

export const updateCaseSchema = z.object({
  status: z.enum(["draft", "in_review", "approved", "rejected", "requires_more_info"]),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const createDocumentSchema = z.object({
  type: z.enum(["certificate_of_incorporation", "tax_certificate", "proof_of_address", "identity_document", "other"]),
  objectKey: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(150),
  sizeBytes: z.string().regex(/^[1-9][0-9]*$/, "Must be a positive integer byte count"),
  expiresAt: z.string().datetime().nullable().optional(),
  retentionUntil: z.string().datetime().nullable().optional(),
});

export const createSubmissionSchema = z.object({
  provider: z.enum(["brails", "anchor"]),
  status: z.enum(["pending", "succeeded", "failed"]).optional(),
  externalReference: z.string().trim().max(200).nullable().optional(),
  responseSnapshot: z.record(z.string(), z.unknown()).optional(),
});

export const grantConsentSchema = z.object({
  consentType: z.enum(["terms", "privacy", "marketing"]),
  version: z.string().trim().min(1).max(40),
});

export const createPrivacyRequestSchema = z.object({
  type: z.enum(["access", "deletion", "portability", "rectification", "objection"]),
  description: z.string().trim().max(2000).optional(),
  businessId: z.string().uuid().nullable().optional(),
});
