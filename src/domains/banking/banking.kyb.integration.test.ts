import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const verificationMessages: { to: string; code: string }[] = [];
const mockSentEmails: { kind: string; to: string; params: Record<string, unknown> }[] = [];
jest.mock("@/shared/email.js", () => {
  const record = (kind: string) => (to: string, params: Record<string, unknown>) => {
    mockSentEmails.push({ kind, to, params });
    return Promise.resolve();
  };
  return {
    emailSender: {
      sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
      sendPasswordResetEmail: () => Promise.resolve(),
      sendBankingKybSubmitted: record("kyb_submitted"),
      sendBankingKybApproved: record("kyb_approved"),
      sendBankingKybFailed: record("kyb_failed"),
      sendVirtualAccountIssued: record("virtual_account_issued"),
      sendVirtualAccountDeposit: record("virtual_account_deposit"),
    },
  };
});

const mockHeadResults = new Map<string, { exists: boolean; sizeBytes?: number }>();
jest.mock("@/integrations/r2.js", () => ({
  objectStorage: {
    createPresignedUploadUrl: (key: string) => Promise.resolve({ uploadUrl: `https://mock-r2.test/${key}`, expiresAt: new Date(Date.now() + 600_000) }),
    createPresignedDownloadUrl: (key: string) => Promise.resolve(`https://mock-r2.test/${key}?download`),
    headObject: (key: string) => Promise.resolve(mockHeadResults.get(key) ?? { exists: false }),
    deleteObject: () => Promise.resolve(),
    getObjectBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  },
}));

// Behaves like Brails: no provider-side KYB, so a business is only verified
// by a platform administrator.
const mockResolvedAccountName = { value: "ACME VENTURES NIG LTD" };
const mockProvider = {
  name: "brails" as const,
  verifiesBusinesses: false,
  resolveBankAccount: jest.fn(() => Promise.resolve({ accountName: mockResolvedAccountName.value })),
  createCustomer: jest.fn(() => Promise.resolve({ customerCode: `ind_${Math.random().toString(36).slice(2)}` })),
  validateCustomerBvn: jest.fn(() => Promise.resolve({ status: "pending" as const })),
  createBusinessCustomer: jest.fn(() => Promise.resolve({ customerCode: `biz_${Math.random().toString(36).slice(2)}` })),
  submitBusinessVerification: jest.fn(() => Promise.resolve({ status: "pending" as const })),
  submitBusinessDocuments: jest.fn(() => Promise.resolve({ submitted: [], missing: [] })),
  createDedicatedAccount: jest.fn(() =>
    Promise.resolve({
      providerAccountId: `acct_${Math.random().toString(36).slice(2)}`,
      accountNumber: "9900112233",
      accountName: "ACME VENTURES LTD",
      bankName: "Safe Haven MFB",
      bankSlug: "safehaven",
      assignmentReference: null,
      status: "active" as const,
    }),
  ),
  requeryDedicatedAccount: jest.fn(),
  createTransferRecipient: jest.fn(),
  initiateTransfer: jest.fn(),
  finalizeTransfer: jest.fn(),
};
jest.mock("@/integrations/payment-provider.js", () => ({ paymentProvider: mockProvider }));

import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

let server: TestServer;
let migratorPool: Pool;

beforeAll(async () => {
  server = await startTestServer();
  const environment = loadEnvironment();
  migratorPool = new Pool({ connectionString: environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL });
});
afterAll(async () => {
  await migratorPool.end();
  await server.close();
});
beforeEach(() => {
  jest.clearAllMocks();
  mockResolvedAccountName.value = "ACME VENTURES NIG LTD";
});

interface TestUser {
  readonly cookies: string;
  readonly userId: string;
  readonly email: string;
}

async function authenticate(label: string): Promise<TestUser> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = body.user?.id ?? body.data?.user?.id;
  if (!userId) throw new Error("Sign-up response missing user");
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { cookies: verified.cookies, userId, email };
}

async function createBusiness(cookies: string, displayName: string): Promise<string> {
  const created = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName }) });
  return (created.body as { data: { business: { id: string } } }).data.business.id;
}

async function grantPlatformAdmin(user: TestUser, role: string): Promise<void> {
  await migratorPool.query(`insert into app.platform_administrators ("userId", "role", "name", "email") values ($1, $2, $3, $4)`, [user.userId, role, "Admin", user.email]);
}

async function confirmedUpload(cookies: string, businessId: string): Promise<string> {
  const created = await request(server.baseUrl, "/api/uploads", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ businessId, purpose: "compliance_document", mimeType: "application/pdf", sizeBytes: "2048" }),
  });
  const upload = (created.body as { data: { upload: { id: string; objectKey: string } } }).data.upload;
  mockHeadResults.set(upload.objectKey, { exists: true, sizeBytes: 2048 });
  const confirmed = await request(server.baseUrl, `/api/uploads/${upload.id}/confirm`, { method: "POST", cookie: cookies });
  if (confirmed.status !== 200) throw new Error(`Upload confirm failed: ${JSON.stringify(confirmed.body)}`);
  return upload.id;
}

async function kybPayload(cookies: string, businessId: string): Promise<Record<string, unknown>> {
  return {
    businessType: "limited_liability",
    registeredBusinessName: "Acme Ventures Nigeria Limited",
    registrationNumber: "1234567",
    dateOfRegistration: "2019-04-12",
    businessCategory: "Retail",
    address: { streetAddress: "1 Marina Road", city: "Lagos Island", state: "Lagos", postalCode: "101001", countryCode: "NG" },
    directorFullName: "Adaeze Grace Okafor",
    directorEmail: "someone-else@unverified.example",
    directorPhone: "+2348031234567",
    directorBvn: "22222222226",
    directorDob: "1988-02-01",
    directorIdType: "nin",
    directorIdNumber: "12345678901",
    certificateOfIncorporationUploadId: await confirmedUpload(cookies, businessId),
    statusReportUploadId: await confirmedUpload(cookies, businessId),
    proofOfAddressUploadId: await confirmedUpload(cookies, businessId),
    directorIdDocumentUploadId: await confirmedUpload(cookies, businessId),
    settlementBankCode: "058",
    settlementAccountNumber: "0123456789",
  };
}

function submitKyb(cookies: string, businessId: string, payload: Record<string, unknown>) {
  return request(server.baseUrl, `/api/businesses/${businessId}/banking/kyb`, { method: "POST", cookie: cookies, body: JSON.stringify(payload) });
}

describe("corporate KYB", () => {
  it("requires real document uploads, a CAC number and a registration date", async () => {
    const owner = await authenticate("KYB Docs Owner");
    const businessId = await createBusiness(owner.cookies, "KYB Docs Co");
    const payload = await kybPayload(owner.cookies, businessId);

    const withFileNames = await submitKyb(owner.cookies, businessId, { ...payload, certificateOfIncorporationUploadId: "certificate.pdf" });
    expect(withFileNames.status).toBe(400);

    const { registrationNumber: _rc, dateOfRegistration: _date, ...missing } = payload;
    expect((await submitKyb(owner.cookies, businessId, missing)).status).toBe(400);
    expect(mockProvider.resolveBankAccount).not.toHaveBeenCalled();
    expect(mockProvider.createBusinessCustomer).not.toHaveBeenCalled();
  });

  it("rejects a document uploaded to another business, and the same file used twice", async () => {
    const owner = await authenticate("KYB Cross Owner");
    const businessId = await createBusiness(owner.cookies, "KYB Cross Co");
    const otherBusinessId = await createBusiness(owner.cookies, "KYB Other Co");
    const payload = await kybPayload(owner.cookies, businessId);

    const foreign = await submitKyb(owner.cookies, businessId, { ...payload, proofOfAddressUploadId: await confirmedUpload(owner.cookies, otherBusinessId) });
    expect(foreign.status).toBe(400);

    const reused = await submitKyb(owner.cookies, businessId, { ...payload, proofOfAddressUploadId: payload.certificateOfIncorporationUploadId });
    expect(reused.status).toBe(400);
    expect(mockProvider.createBusinessCustomer).not.toHaveBeenCalled();
  });

  it("rejects a settlement account that isn't held in the business's name", async () => {
    const owner = await authenticate("KYB Mismatch Owner");
    const businessId = await createBusiness(owner.cookies, "KYB Mismatch Co");
    mockResolvedAccountName.value = "JOHN DOE";

    const response = await submitKyb(owner.cookies, businessId, await kybPayload(owner.cookies, businessId));
    expect(response.status).toBe(400);
    expect(mockProvider.createBusinessCustomer).not.toHaveBeenCalled();
  });

  it("stays pending, stores identity numbers encrypted, and emails only the verified submitter", async () => {
    const owner = await authenticate("KYB Happy Owner");
    const businessId = await createBusiness(owner.cookies, "KYB Happy Co");

    const response = await submitKyb(owner.cookies, businessId, await kybPayload(owner.cookies, businessId));
    expect(response.status).toBe(200);
    expect((response.body as { data: { kyc: { status: string } } }).data.kyc.status).toBe("pending");

    const createInput = mockProvider.createBusinessCustomer.mock.calls[0] as unknown as [{ registrationNumber: string; director: { lastName: string; middleName: string } }];
    expect(createInput[0].registrationNumber).toBe("RC1234567");
    expect(createInput[0].director).toMatchObject({ lastName: "Okafor", middleName: "Grace" });

    const stored = await migratorPool.query<{ bvn: string; directorIdNumber: string; settlementAccountName: string; providerCustomerType: string; notificationEmail: string }>(
      `select "bvn", "directorIdNumber", "settlementAccountName", "providerCustomerType", "notificationEmail" from app.banking_profiles where "businessId" = $1`,
      [businessId],
    );
    expect(stored.rows[0]!.bvn).toMatch(/^enc:v1:/);
    expect(stored.rows[0]!.directorIdNumber).toMatch(/^enc:v1:/);
    expect(stored.rows[0]!.settlementAccountName).toBe("ACME VENTURES NIG LTD");
    expect(stored.rows[0]!.providerCustomerType).toBe("business");
    expect(stored.rows[0]!.notificationEmail).toBe(owner.email);

    const owners = await migratorPool.query<{ nationality: string; idNumber: string; ownershipPercentageBps: number | null }>(
      `select "nationality", "idNumber", "ownershipPercentageBps" from app.beneficial_owners where "businessId" = $1`,
      [businessId],
    );
    expect(owners.rows).toHaveLength(1);
    expect(owners.rows[0]).toMatchObject({ nationality: "NG", ownershipPercentageBps: null });
    expect(owners.rows[0]!.idNumber).toMatch(/^enc:v1:/);

    expect(mockSentEmails.filter((email) => email.to === "someone-else@unverified.example")).toHaveLength(0);
    expect(mockSentEmails.some((email) => email.kind === "kyb_submitted" && email.to === owner.email)).toBe(true);

    const account = await request(server.baseUrl, `/api/businesses/${businessId}/banking/virtual-account`, { method: "POST", cookie: owner.cookies, body: "{}" });
    expect(account.status).toBe(403);
    expect(mockProvider.createDedicatedAccount).not.toHaveBeenCalled();
  });

  it("only a finance-level platform administrator can approve, and approval unlocks a corporate account", async () => {
    const owner = await authenticate("KYB Review Owner");
    const businessId = await createBusiness(owner.cookies, "KYB Review Co");
    expect((await submitKyb(owner.cookies, businessId, await kybPayload(owner.cookies, businessId))).status).toBe(200);

    const reviewPath = `/api/platform/banking/kyb-reviews/${businessId}`;
    expect((await request(server.baseUrl, reviewPath, { cookie: owner.cookies })).status).toBe(403);

    const moderator = await authenticate("KYB Moderator");
    await grantPlatformAdmin(moderator, "moderator");
    const detail = await request(server.baseUrl, reviewPath, { cookie: moderator.cookies });
    expect(detail.status).toBe(200);
    const review = (detail.body as { data: { review: { directorBvnMasked: string; documents: { downloadUrl: string | null }[] } } }).data.review;
    expect(review.directorBvnMasked).toBe("*******2226");
    expect(review.documents).toHaveLength(4);
    expect(review.documents.every((document) => document.downloadUrl)).toBe(true);
    expect(
      (await request(server.baseUrl, `${reviewPath}/decision`, { method: "POST", cookie: moderator.cookies, body: JSON.stringify({ decision: "approve" }) })).status,
    ).toBe(403);

    const finance = await authenticate("KYB Finance");
    await grantPlatformAdmin(finance, "finance");
    const approved = await request(server.baseUrl, `${reviewPath}/decision`, { method: "POST", cookie: finance.cookies, body: JSON.stringify({ decision: "approve" }) });
    expect(approved.status).toBe(200);
    expect(mockSentEmails.some((email) => email.kind === "kyb_approved" && email.to === owner.email)).toBe(true);

    const again = await request(server.baseUrl, `${reviewPath}/decision`, { method: "POST", cookie: finance.cookies, body: JSON.stringify({ decision: "reject", notes: "Too late" }) });
    expect(again.status).toBe(409);

    const account = await request(server.baseUrl, `/api/businesses/${businessId}/banking/virtual-account`, { method: "POST", cookie: owner.cookies, body: "{}" });
    expect(account.status).toBe(201);
    expect(mockProvider.createDedicatedAccount).toHaveBeenCalledWith(expect.objectContaining({ accountType: "CORPORATE", rcNumber: "RC1234567" }));
    expect((account.body as { data: { virtualAccount: { accountName: string } } }).data.virtualAccount.accountName).toBe("ACME VENTURES LTD");
  });

  it("a rejected business can resubmit, and nothing from the earlier attempt is reused", async () => {
    const owner = await authenticate("KYB Retry Owner");
    const businessId = await createBusiness(owner.cookies, "KYB Retry Co");
    expect((await submitKyb(owner.cookies, businessId, await kybPayload(owner.cookies, businessId))).status).toBe(200);

    const finance = await authenticate("KYB Retry Finance");
    await grantPlatformAdmin(finance, "finance");
    const rejected = await request(server.baseUrl, `/api/platform/banking/kyb-reviews/${businessId}/decision`, {
      method: "POST",
      cookie: finance.cookies,
      body: JSON.stringify({ decision: "reject", notes: "Certificate is illegible" }),
    });
    expect(rejected.status).toBe(200);
    expect(mockSentEmails.some((email) => email.kind === "kyb_failed" && email.to === owner.email && email.params.reason === "Certificate is illegible")).toBe(true);

    mockResolvedAccountName.value = "BRIGHT FUTURES LIMITED";
    const retry = { ...(await kybPayload(owner.cookies, businessId)), registeredBusinessName: "Bright Futures Limited", registrationNumber: "RC7654321" };
    expect((await submitKyb(owner.cookies, businessId, retry)).status).toBe(200);
    // A different business identity gets a fresh provider customer.
    expect(mockProvider.createBusinessCustomer).toHaveBeenCalledTimes(2);

    const stored = await migratorPool.query<{ registeredBusinessName: string; kybReviewNotes: string | null; kycStatus: string }>(
      `select "registeredBusinessName", "kybReviewNotes", "kycStatus" from app.banking_profiles where "businessId" = $1`,
      [businessId],
    );
    expect(stored.rows[0]).toMatchObject({ registeredBusinessName: "Bright Futures Limited", kybReviewNotes: null, kycStatus: "pending" });
  });

  it("limits verification attempts per business", async () => {
    const owner = await authenticate("KYB Limit Owner");
    const businessId = await createBusiness(owner.cookies, "KYB Limit Co");
    const payload = await kybPayload(owner.cookies, businessId);
    mockResolvedAccountName.value = "SOMEONE ELSE ENTIRELY";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await submitKyb(owner.cookies, businessId, payload)).status).toBe(400);
    }
    const blocked = await submitKyb(owner.cookies, businessId, payload);
    expect(blocked.status).toBe(429);
    expect(mockProvider.resolveBankAccount).toHaveBeenCalledTimes(5);
  });
});
