import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

jest.setTimeout(30_000);
let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());

async function authenticate(label: string): Promise<{ cookies: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return { cookies: verified.cookies };
}

async function createBusiness(cookies: string): Promise<string> {
  const response = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ displayName: `Compliance Co ${randomUUID().slice(0, 8)}` }),
  });
  return (response.body as { data: { business: { id: string } } }).data.business.id;
}

function legalProfileBody(overrides: Record<string, unknown> = {}) {
  return {
    registeredName: "North Star Retail Ltd",
    registrationNumber: `RC${randomUUID().slice(0, 8)}`,
    addressLine1: "1 Broad Street",
    city: "Lagos",
    state: "Lagos",
    ...overrides,
  };
}

describe("compliance domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/compliance/legal-profile`)).status).toBe(401);
    expect((await request(server.baseUrl, "/api/me/consents")).status).toBe(401);
    expect((await request(server.baseUrl, "/api/me/data-privacy-requests")).status).toBe(401);
  });

  it("blocks opening a case before the legal profile is set, then allows it after", async () => {
    const owner = await authenticate("Compliance Owner");
    const businessId = await createBusiness(owner.cookies);
    const base = `/api/businesses/${businessId}/compliance`;

    const tooEarly = await request(server.baseUrl, `${base}/cases`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({}) });
    expect(tooEarly.status).toBe(400);

    const profileSet = await request(server.baseUrl, `${base}/legal-profile`, { method: "PUT", cookie: owner.cookies, body: JSON.stringify(legalProfileBody()) });
    expect(profileSet.status).toBe(200);
    expect((profileSet.body as { data: { legalProfile: { registeredName: string } } }).data.legalProfile.registeredName).toBe("North Star Retail Ltd");

    const fetched = await request(server.baseUrl, `${base}/legal-profile`, { cookie: owner.cookies });
    expect(fetched.status).toBe(200);

    const opened = await request(server.baseUrl, `${base}/cases`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({}) });
    expect(opened.status).toBe(201);
    const complianceCase = (opened.body as { data: { case: { id: string; status: string } } }).data.case;
    expect(complianceCase.status).toBe("draft");

    const secondOpen = await request(server.baseUrl, `${base}/cases`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({}) });
    expect(secondOpen.status).toBe(409);
  });

  it("manages beneficial owners and moves a case to in_review when a submission is recorded", async () => {
    const owner = await authenticate("KYB Owner");
    const businessId = await createBusiness(owner.cookies);
    const base = `/api/businesses/${businessId}/compliance`;
    await request(server.baseUrl, `${base}/legal-profile`, { method: "PUT", cookie: owner.cookies, body: JSON.stringify(legalProfileBody()) });

    const ownerCreated = await request(server.baseUrl, `${base}/beneficial-owners`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ fullName: "Ada Lovelace", relationship: "ultimate_beneficial_owner", ownershipPercentageBps: 10000, idType: "nin", idNumber: "12345678901" }),
    });
    expect(ownerCreated.status).toBe(201);
    const beneficialOwner = (ownerCreated.body as { data: { beneficialOwner: { id: string } } }).data.beneficialOwner;

    const updated = await request(server.baseUrl, `${base}/beneficial-owners/${beneficialOwner.id}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ ownershipPercentageBps: 7500 }),
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { beneficialOwner: { ownershipPercentageBps: number } } }).data.beneficialOwner.ownershipPercentageBps).toBe(7500);

    const opened = await request(server.baseUrl, `${base}/cases`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({}) });
    const caseId = (opened.body as { data: { case: { id: string } } }).data.case.id;

    const submitted = await request(server.baseUrl, `${base}/cases/${caseId}/submissions`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ provider: "brails" }),
    });
    expect(submitted.status).toBe(201);
    expect((submitted.body as { data: { submission: { status: string } } }).data.submission.status).toBe("pending");

    const caseAfter = await request(server.baseUrl, `${base}/cases/${caseId}`, { cookie: owner.cookies });
    expect((caseAfter.body as { data: { case: { status: string } } }).data.case.status).toBe("in_review");

    const decided = await request(server.baseUrl, `${base}/cases/${caseId}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ status: "approved" }),
    });
    expect(decided.status).toBe(200);
    const decidedCase = (decided.body as { data: { case: { status: string; closedAt: string | null } } }).data.case;
    expect(decidedCase.status).toBe("approved");
    expect(decidedCase.closedAt).not.toBeNull();

    const archived = await request(server.baseUrl, `${base}/beneficial-owners/${beneficialOwner.id}`, { method: "DELETE", cookie: owner.cookies });
    expect(archived.status).toBe(200);
    const ownersAfter = await request(server.baseUrl, `${base}/beneficial-owners`, { cookie: owner.cookies });
    expect((ownersAfter.body as { data: { beneficialOwners: unknown[] } }).data.beneficialOwners).toHaveLength(0);
  });

  it("records document metadata against a case", async () => {
    const owner = await authenticate("Documents Owner");
    const businessId = await createBusiness(owner.cookies);
    const base = `/api/businesses/${businessId}/compliance`;
    await request(server.baseUrl, `${base}/legal-profile`, { method: "PUT", cookie: owner.cookies, body: JSON.stringify(legalProfileBody()) });
    const opened = await request(server.baseUrl, `${base}/cases`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({}) });
    const caseId = (opened.body as { data: { case: { id: string } } }).data.case.id;

    const document = await request(server.baseUrl, `${base}/cases/${caseId}/documents`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ type: "certificate_of_incorporation", objectKey: `compliance/${randomUUID()}.pdf`, mimeType: "application/pdf", sizeBytes: "204800" }),
    });
    expect(document.status).toBe(201);

    const listed = await request(server.baseUrl, `${base}/cases/${caseId}/documents`, { cookie: owner.cookies });
    expect((listed.body as { data: { documents: unknown[] } }).data.documents).toHaveLength(1);
  });

  it("grants, lists, and revokes a consent, and re-granting clears the revocation", async () => {
    const user = await authenticate("Consent User");

    const granted = await request(server.baseUrl, "/api/me/consents", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ consentType: "marketing", version: "2026-01" }),
    });
    expect(granted.status).toBe(201);
    const consent = (granted.body as { data: { consent: { id: string; revokedAt: string | null } } }).data.consent;
    expect(consent.revokedAt).toBeNull();

    const revoked = await request(server.baseUrl, `/api/me/consents/${consent.id}`, { method: "DELETE", cookie: user.cookies });
    expect(revoked.status).toBe(200);

    const listedAfterRevoke = await request(server.baseUrl, "/api/me/consents", { cookie: user.cookies });
    const afterRevoke = (listedAfterRevoke.body as { data: { consents: { id: string; revokedAt: string | null }[] } }).data.consents;
    expect(afterRevoke.find((c) => c.id === consent.id)?.revokedAt).not.toBeNull();

    const regranted = await request(server.baseUrl, "/api/me/consents", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ consentType: "marketing", version: "2026-01" }),
    });
    expect(regranted.status).toBe(201);
    expect((regranted.body as { data: { consent: { id: string; revokedAt: string | null } } }).data.consent.revokedAt).toBeNull();
  });

  it("accepts a data-privacy request tied to a business the user belongs to, and rejects one they don't", async () => {
    const owner = await authenticate("Privacy Owner");
    const businessId = await createBusiness(owner.cookies);

    const own = await request(server.baseUrl, "/api/me/data-privacy-requests", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ type: "access", businessId }),
    });
    expect(own.status).toBe(201);
    expect((own.body as { data: { request: { dueAt: string } } }).data.request.dueAt).toBeTruthy();

    const outsider = await authenticate("Privacy Outsider");
    const foreign = await request(server.baseUrl, "/api/me/data-privacy-requests", {
      method: "POST",
      cookie: outsider.cookies,
      body: JSON.stringify({ type: "deletion", businessId }),
    });
    expect(foreign.status).toBe(409);

    const list = await request(server.baseUrl, "/api/me/data-privacy-requests", { cookie: owner.cookies });
    expect((list.body as { data: { requests: unknown[] } }).data.requests).toHaveLength(1);
  });

  it("rejects cross-tenant compliance access", async () => {
    const owner = await authenticate("Isolated Compliance Owner");
    const outsider = await authenticate("Isolated Compliance Outsider");
    const businessId = await createBusiness(owner.cookies);

    const forbidden = await request(server.baseUrl, `/api/businesses/${businessId}/compliance/beneficial-owners`, { cookie: outsider.cookies });
    expect(forbidden.status).toBe(403);
  });
});
