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
      bankCode: val.bankCode ?? val.bank_code,
      accountNumber: val.accountNumber ?? val.account_number,
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
  bankCode,
  accountNumber,
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
}));

export const submitKybSchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    const rawAddress = val.address ?? val.businessAddress ?? {};
    return {
      businessType: val.businessType ?? val.business_type ?? "limited_liability",
      registeredBusinessName: val.registeredBusinessName ?? val.registered_business_name ?? val.businessName ?? val.business_name,
      registrationNumber: val.registrationNumber ?? val.registration_number ?? val.rcNumber ?? val.rc_number,
      taxIdentificationNumber: val.taxIdentificationNumber ?? val.tax_identification_number ?? val.tin,
      website: val.website ?? val.businessWebsite ?? val.business_website,
      description: val.description,
      businessCategory: val.businessCategory ?? val.business_category ?? val.category,
      annualRevenue: val.annualRevenue ?? val.annual_revenue ?? val.revenue,
      address: {
        streetAddress: rawAddress.streetAddress ?? rawAddress.street_address ?? rawAddress.addressLine1 ?? rawAddress.address_line_1 ?? "",
        apartment: rawAddress.apartment ?? rawAddress.addressLine2 ?? rawAddress.address_line_2,
        city: rawAddress.city ?? "",
        state: rawAddress.state ?? "",
        postalCode: rawAddress.postalCode ?? rawAddress.postal_code ?? rawAddress.postcode,
        countryCode: rawAddress.countryCode ?? rawAddress.country_code ?? rawAddress.country ?? "NG",
      },
      directorFullName: val.directorFullName ?? val.director_full_name ?? val.fullName ?? val.full_name ?? `${val.firstName ?? ""} ${val.lastName ?? ""}`.trim(),
      directorEmail: val.directorEmail ?? val.director_email ?? val.email,
      directorPhone: val.directorPhone ?? val.director_phone ?? val.phone,
      directorBvn: val.directorBvn ?? val.director_bvn ?? val.bvn,
      directorNin: val.directorNin ?? val.director_nin ?? val.nin,
      directorDob: val.directorDob ?? val.director_dob ?? val.dateOfBirth ?? val.date_of_birth,
      directorGender: val.directorGender ?? val.director_gender ?? val.gender,
      directorIdType: val.directorIdType ?? val.director_id_type ?? val.idType ?? val.id_type,
      directorIdDocumentUrl: val.directorIdDocumentUrl ?? val.director_id_document_url,
      certificateOfIncorporationUrl: val.certificateOfIncorporationUrl ?? val.certificate_of_incorporation_url,
      statusReportUrl: val.statusReportUrl ?? val.status_report_url,
      proofOfAddressUrl: val.proofOfAddressUrl ?? val.proof_of_address_url,
      settlementBankCode: val.settlementBankCode ?? val.settlement_bank_code ?? val.bankCode ?? val.bank_code,
      settlementAccountNumber: val.settlementAccountNumber ?? val.settlement_account_number ?? val.accountNumber ?? val.account_number,
      settlementAccountName: val.settlementAccountName ?? val.settlement_account_name ?? val.accountName ?? val.account_name,
    };
  }
  return val;
}, z.object({
  businessType: z.enum(["sole_proprietorship", "limited_liability", "ngo_cooperative"]).default("limited_liability"),
  registeredBusinessName: z.string().trim().min(1).max(255),
  registrationNumber: z.string().trim().min(2).max(50).optional(),
  taxIdentificationNumber: z.string().trim().max(50).optional(),
  website: z.string().trim().max(255).optional(),
  description: z.string().trim().max(1000).optional(),
  businessCategory: z.string().trim().max(100).optional(),
  annualRevenue: z.string().trim().max(100).optional(),
  address: z.object({
    streetAddress: z.string().trim().min(1).max(255),
    apartment: z.string().trim().max(255).optional().nullable(),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().max(20).optional().nullable(),
    countryCode: z.string().trim().max(10).default("NG"),
  }),
  directorFullName: z.string().trim().min(1).max(255),
  directorEmail: z.string().trim().email().max(255),
  directorPhone: z.string().trim().min(7).max(30),
  directorBvn: bvn,
  directorNin: z.string().regex(/^\d{11}$/, "Enter an 11 digit NIN").optional(),
  directorDob: z.string().optional(),
  directorGender: z.enum(["male", "female", "other"]).optional(),
  directorIdType: z.string().optional(),
  directorIdDocumentUrl: z.string().optional(),
  certificateOfIncorporationUrl: z.string().optional(),
  statusReportUrl: z.string().optional(),
  proofOfAddressUrl: z.string().optional(),
  settlementBankCode: bankCode,
  settlementAccountNumber: accountNumber,
  settlementAccountName: z.string().optional(),
}));

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

