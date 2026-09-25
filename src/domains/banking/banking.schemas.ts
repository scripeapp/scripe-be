import { z } from "zod";

const accountNumber = z.string().regex(/^\d{10}$/, "Enter a 10 digit account number");
const bankCode = z.string().min(2).max(20);
const bvn = z.string().regex(/^\d{11}$/, "Enter an 11 digit BVN");

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const submitKycSchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    return {
      email: val.email,
      firstName: val.firstName ?? val.first_name,
      lastName: val.lastName ?? val.last_name,
      phone: val.phone,
      bvn: val.bvn,
      dateOfBirth: val.dateOfBirth ?? val.date_of_birth,
      gender: val.gender,
    };
  }
  return val;
}, z.object({
  email: z.string().trim().email().max(255),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(7).max(30),
  bvn,
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
}));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date");
const pastIsoDate = isoDate.refine((value) => Date.parse(value) <= Date.now(), "Date cannot be in the future");
const uploadId = z.string().uuid("Upload the document before submitting");

/**
 * CAC numbers: RC (companies), BN (business names), IT (incorporated
 * trustees). Normalised to "RC1234567" so later lookups and provider calls
 * see one format.
 */
const REGISTRATION_PREFIX = { limited_liability: "RC", sole_proprietorship: "BN", ngo_cooperative: "IT" } as const;

const MAX_DIRECTORS = 10;

const directorSchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    return {
      fullName: val.fullName ?? val.full_name,
      email: val.email,
      phone: val.phone,
      bvn: val.bvn,
      dateOfBirth: val.dateOfBirth ?? val.date_of_birth,
      idType: val.idType ?? val.id_type,
      idNumber: val.idNumber ?? val.id_number,
      idDocumentUploadId: val.idDocumentUploadId ?? val.id_document_upload_id,
      isPrimary: val.isPrimary ?? val.is_primary ?? false,
    };
  }
  return val;
}, z.object({
  fullName: z.string().trim().min(3).max(255).refine((value) => value.split(/\s+/).length >= 2, "Enter the director's first and last name"),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^\+?[0-9]{10,14}$/, "Enter a valid phone number"),
  bvn,
  dateOfBirth: pastIsoDate,
  idType: z.enum(["nin", "passport", "drivers_license", "voters_card"]),
  idNumber: z.string().trim().min(5).max(30),
  idDocumentUploadId: uploadId,
  isPrimary: z.boolean(),
}).superRefine((director, context) => {
  if (director.idType === "nin" && !/^\d{11}$/.test(director.idNumber)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["idNumber"], message: "Enter an 11 digit NIN" });
  }
}).transform((director) => {
  const [firstName, ...rest] = director.fullName.split(/\s+/);
  const lastName = rest.pop()!;
  return { ...director, firstName: firstName!, lastName, middleName: rest.length > 0 ? rest.join(" ") : null };
}));

export const submitKybSchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    const rawAddress = val.address ?? val.businessAddress ?? {};
    return {
      businessType: val.businessType ?? val.business_type,
      registeredBusinessName: val.registeredBusinessName ?? val.registered_business_name ?? val.businessName ?? val.business_name,
      registrationNumber: val.registrationNumber ?? val.registration_number ?? val.rcNumber ?? val.rc_number,
      taxIdentificationNumber: val.taxIdentificationNumber ?? val.tax_identification_number ?? val.tin,
      dateOfRegistration: val.dateOfRegistration ?? val.date_of_registration ?? val.incorporationDate ?? val.incorporation_date,
      website: val.website ?? val.businessWebsite ?? val.business_website,
      description: val.description,
      businessCategory: val.businessCategory ?? val.business_category ?? val.category ?? val.industry,
      annualRevenue: val.annualRevenue ?? val.annual_revenue ?? val.revenue,
      address: {
        streetAddress: rawAddress.streetAddress ?? rawAddress.street_address ?? rawAddress.addressLine1 ?? rawAddress.address_line_1,
        apartment: rawAddress.apartment ?? rawAddress.addressLine2 ?? rawAddress.address_line_2,
        city: rawAddress.city,
        state: rawAddress.state,
        postalCode: rawAddress.postalCode ?? rawAddress.postal_code ?? rawAddress.postcode,
        countryCode: rawAddress.countryCode ?? rawAddress.country_code ?? rawAddress.country ?? "NG",
      },
      directors: val.directors,
      certificateOfIncorporationUploadId: val.certificateOfIncorporationUploadId ?? val.certificate_of_incorporation_upload_id,
      statusReportUploadId: val.statusReportUploadId ?? val.status_report_upload_id,
      proofOfAddressUploadId: val.proofOfAddressUploadId ?? val.proof_of_address_upload_id,
    };
  }
  return val;
}, z.object({
  businessType: z.enum(["sole_proprietorship", "limited_liability", "ngo_cooperative"]),
  registeredBusinessName: z.string().trim().min(2).max(255),
  registrationNumber: z.string().trim().min(2).max(20),
  taxIdentificationNumber: z.string().trim().regex(/^[0-9-]{8,15}$/, "Enter a valid TIN").optional(),
  dateOfRegistration: pastIsoDate,
  website: z.string().trim().url("Enter a full URL, e.g. https://example.com").max(255).optional(),
  description: z.string().trim().max(1000).optional(),
  businessCategory: z.string().trim().min(1, "Select a business category").max(100),
  annualRevenue: z.string().trim().max(100).optional(),
  address: z.object({
    streetAddress: z.string().trim().min(1).max(255),
    apartment: z.string().trim().max(255).optional().nullable(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(4, "Enter the postal code").max(20),
    countryCode: z.literal("NG", { errorMap: () => ({ message: "Only Nigerian businesses can be verified" }) }),
  }),
  directors: z.array(directorSchema).min(1, "Add at least one director").max(MAX_DIRECTORS, `Add at most ${MAX_DIRECTORS} directors`),
  certificateOfIncorporationUploadId: uploadId,
  statusReportUploadId: uploadId.optional(),
  proofOfAddressUploadId: uploadId,
}).superRefine((input, context) => {
  if (input.businessType === "limited_liability" && !input.statusReportUploadId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["statusReportUploadId"], message: "Upload the CAC status report" });
  }
  const digits = input.registrationNumber.replace(/^(RC|BN|IT)[\s-]*/i, "");
  if (!/^\d{4,10}$/.test(digits)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["registrationNumber"], message: "Enter the CAC registration number, e.g. RC1234567" });
  }
  // An unmarked list defaults to the first director as primary (see
  // transform); more than one marked primary is ambiguous.
  if (input.directors.filter((director) => director.isPrimary).length > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["directors"], message: "Mark only one director as the primary signatory" });
  }
  if (new Set(input.directors.map((director) => director.bvn)).size !== input.directors.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["directors"], message: "Each director must have their own BVN" });
  }
}).transform((input) => {
  const hasPrimary = input.directors.some((director) => director.isPrimary);
  return {
    ...input,
    registrationNumber: `${REGISTRATION_PREFIX[input.businessType]}${input.registrationNumber.replace(/^(RC|BN|IT)[\s-]*/i, "")}`,
    directors: input.directors.map((director, index) => ({ ...director, isPrimary: hasPrimary ? director.isPrimary : index === 0 })),
  };
}));

export const reviewKybParamsSchema = z.object({ businessId: z.string().uuid() });

export const reviewKybSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), notes: z.string().trim().max(2000).optional() }),
  z.object({ decision: z.literal("reject"), notes: z.string().trim().min(5, "Tell the business what to fix").max(2000) }),
]);

export const listKybReviewsQuerySchema = z.object({
  status: z.enum(["pending", "verified", "failed"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const requestVirtualAccountSchema = z.object({
  preferredBank: z.string().trim().min(2).max(80).optional(),
});

export const requestWithdrawalSchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    const rawAmount = val.amountMinor ?? (val.amount !== undefined ? Math.round(Number(val.amount) * 100) : undefined);
    return {
      amountMinor: rawAmount,
      bankCode: val.bankCode ?? val.bank_code ?? val.bank,
      accountNumber: val.accountNumber ?? val.account_number,
      accountName: val.accountName ?? val.account_name ?? "Withdrawal Beneficiary",
      idempotencyKey: val.idempotencyKey ?? val.idempotency_key ?? `wd_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    };
  }
  return val;
}, z.object({
  amountMinor: z.number().int().positive(),
  bankCode,
  accountNumber,
  accountName: z.string().trim().min(2).max(255),
  idempotencyKey: z.string().trim().min(8).max(80),
}));

export const finalizeWithdrawalSchema = z.object({
  transferCode: z.string().trim().min(4).max(120),
  otp: z.string().trim().min(4).max(20),
});

export const resolveBankAccountQuerySchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    return {
      accountNumber: val.accountNumber ?? val.account_number,
      bankCode: val.bankCode ?? val.bank_code,
    };
  }
  return val;
}, z.object({
  accountNumber,
  bankCode,
}));

export const listWalletTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

