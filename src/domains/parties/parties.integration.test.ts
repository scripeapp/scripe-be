import { randomUUID } from "node:crypto";
const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({ emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} } }));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
jest.setTimeout(30_000);
let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());
async function actor(label: string) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { userId: body.user?.id ?? body.data?.user?.id, cookies: verified.cookies };
}
describe("parties domain", () => {
  it("requires authentication", async () => expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/parties`)).status).toBe(401));
  it("manages a merged party with customer and supplier roles, contacts, and addresses", async () => {
    const owner = await actor("Party Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: "Party Test Co" }) });
    const business = (businessResponse.body as { data: { business: { id: string } } }).data.business;
    const base = `/api/businesses/${business.id}`;
    const created = await request(server.baseUrl, `${base}/parties`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "organization", displayName: "Acme Trading" }) });
    expect(created.status).toBe(201);
    const party = (created.body as { data: { party: { id: string } } }).data.party;
    expect((await request(server.baseUrl, `${base}/parties/${party.id}/contacts`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "email", value: "Sales@Acme.test", isPrimary: true }) })).status).toBe(201);
    expect((await request(server.baseUrl, `${base}/parties/${party.id}/addresses`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "office", line1: "1 Marina Road", city: "Lagos", isDefault: true }) })).status).toBe(201);
    const customer = await request(server.baseUrl, `${base}/customers`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "organization", displayName: "Customer Co", customer: { acquisitionChannel: "referral" } }) });
    expect(customer.status).toBe(201);
    const supplier = await request(server.baseUrl, `${base}/suppliers`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "organization", displayName: "Supplier Co", supplier: { code: "SUP-1", paymentTerms: "NET30" } }) });
    expect(supplier.status).toBe(201);
    const listed = await request(server.baseUrl, `${base}/parties`, { cookie: owner.cookies });
    expect(listed.status).toBe(200);
    expect((listed.body as { data: { parties: unknown[] } }).data.parties.length).toBe(3);
  });

  it("stores supplier bank details and reports spend/payable rollups from bills", async () => {
    const owner = await actor("Vendor Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: "Vendor Test Co" }) });
    const business = (businessResponse.body as { data: { business: { id: string } } }).data.business;
    const base = `/api/businesses/${business.id}`;

    const created = await request(server.baseUrl, `${base}/suppliers`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({
      kind: "organization", displayName: "Acme Supplies",
      supplier: { code: "SUP-2", contactPerson: "Jane Doe", category: "Packaging", bankName: "GTBank", bankCode: "058", accountNumber: "0123456789", accountName: "Acme Supplies Ltd", notes: "Reliable" },
    }) });
    expect(created.status).toBe(201);
    const partyId = (created.body as { data: { supplier: { id: string } } }).data.supplier.id;
    const withoutBills = (created.body as { data: { supplier: { supplierAccount: { contactPerson: string; bankName: string; totalSpendMinor: string; outstandingPayableMinor: string; id: string } } } }).data.supplier.supplierAccount;
    expect(withoutBills).toMatchObject({ contactPerson: "Jane Doe", bankName: "GTBank", totalSpendMinor: "0", outstandingPayableMinor: "0" });

    const bill = await request(server.baseUrl, `${base}/payables/bills`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({
      supplierAccountId: withoutBills.id, billNumber: "BILL-1", subtotalMinor: 10_000, totalMinor: 10_000,
      lines: [{ description: "Boxes", quantity: 100, unitAmountMinor: 100, lineTotalMinor: 10_000, accountCategory: "supplies" }],
    }) });
    expect(bill.status).toBe(201);

    const fetched = await request(server.baseUrl, `${base}/suppliers/${partyId}`, { cookie: owner.cookies });
    expect(fetched.status).toBe(200);
    const supplierAccount = (fetched.body as { data: { supplier: { supplierAccount: { totalSpendMinor: string; outstandingPayableMinor: string } } } }).data.supplier.supplierAccount;
    expect(supplierAccount.totalSpendMinor).toBe("10000");
    expect(supplierAccount.outstandingPayableMinor).toBe("10000");

    const updated = await request(server.baseUrl, `${base}/suppliers/${partyId}`, { method: "PATCH", cookie: owner.cookies, body: JSON.stringify({ supplier: { accountName: "Acme Supplies Nigeria Ltd" } }) });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { supplier: { supplierAccount: { accountName: string } } } }).data.supplier.supplierAccount.accountName).toBe("Acme Supplies Nigeria Ltd");
  });
});
