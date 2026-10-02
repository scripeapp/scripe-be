import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];

let sentInvoiceEmails: { to: string; params: any }[] = [];
let sentReminderEmails: { to: string; params: any }[] = [];

jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendInvoiceIssued: (to: string, params: any) => sentInvoiceEmails.push({ to, params }),
    sendInvoiceReminder: (to: string, params: any) => sentReminderEmails.push({ to, params }),
  },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";
import { getDatabase } from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { anonymousPrincipal } from "@/db/principal.js";
import { runInvoiceOverdueSweep } from "./invoices.service.js";

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;

beforeAll(async () => {
  verificationMessages = [];
  server = await startTestServer();
});

afterAll(async () => server.close());

async function authenticate(label: string): Promise<{ cookies: string; userId: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: PASSWORD }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  const signupBody = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = signupBody.user?.id ?? signupBody.data?.user?.id;
  if (!userId) throw new Error(`Sign-up response missing user: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  if (!code) throw new Error(`Verification code missing for ${email}`);
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return { cookies: verified.cookies, userId };
}

describe("invoices domain", () => {
  it("requires authentication for business endpoints", async () => {
    const fakeBusinessId = randomUUID();
    const res = await request(server.baseUrl, `/api/businesses/${fakeBusinessId}/invoices`);
    expect(res.status).toBe(401);
  });

  it("handles complete invoice lifecycle: draft -> send -> payments -> receipt", async () => {
    const owner = await authenticate("Invoice Owner");
    const bizRes = await request(server.baseUrl, "/api/businesses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ displayName: "Invoice Corp" }),
    });
    expect(bizRes.status).toBe(201);
    const businessId = (bizRes.body as { data: { business: { id: string } } }).data.business.id;
    const base = `/api/businesses/${businessId}/invoices`;

    // 1. Create Draft
    const createRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        customer: {
          name: "Alice Wonderland",
          email: "alice@example.com",
          phone: "+2348011223344",
        },
        dueDate: "2026-10-31",
        notes: "Thank you for your business",
        terms: "Net 30",
        lines: [
          {
            description: "Consulting Service",
            quantity: 2,
            unitPriceMinor: "500000", // 5,000 NGN
            taxRateBps: 750, // 7.5% VAT = 75,000 minor
            discountMinor: "0",
          },
          {
            description: "Setup Fee",
            quantity: 1,
            unitPriceMinor: "200000", // 2,000 NGN
            taxRateBps: 0,
            discountMinor: "20000", // 200 NGN discount
          },
        ],
      }),
    });

    expect(createRes.status).toBe(201);
    const invoice = (createRes.body as { data: { invoice: { id: string; status: string; publicToken: string; totalMinor: string; subtotalMinor: string; taxMinor: string; customer: { name: string; email: string } } } }).data.invoice;
    expect(invoice.status).toBe("draft");
    expect(invoice.customer.name).toBe("Alice Wonderland");
    expect(invoice.customer.email).toBe("alice@example.com");
    // Subtotal: (2 * 500000) + (1 * 200000) = 1,200,000
    expect(invoice.subtotalMinor).toBe("1200000");
    // Tax: 1000000 * 0.075 = 75,000
    expect(invoice.taxMinor).toBe("75000");
    // Total: 1,200,000 + 75,000 - 20,000 = 1,255,000
    expect(invoice.totalMinor).toBe("1255000");

    const invoiceId = invoice.id;
    const publicToken = invoice.publicToken;

    // 2. Draft is not accessible via public route
    const draftPublic = await request(server.baseUrl, `/api/invoices/public/${publicToken}`);
    expect(draftPublic.status).toBe(404);

    // 3. Update Draft
    const updateRes = await request(server.baseUrl, `${base}/${invoiceId}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({
        notes: "Updated invoice terms & notes",
      }),
    });
    expect(updateRes.status).toBe(200);

    // 4. Send Invoice (Issues number, order, fiscal doc)
    const sendRes = await request(server.baseUrl, `${base}/${invoiceId}/send`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({}),
    });
    expect(sendRes.status).toBe(200);
    const sentInvoice = (sendRes.body as { data: { invoice: { status: string; invoiceNumber: string; orderId: string; fiscalDocumentId: string } } }).data.invoice;
    expect(sentInvoice.status).toBe("pending");
    expect(sentInvoice.invoiceNumber).toMatch(/^INV-\d{6}$/);
    expect(sentInvoice.orderId).toBeTruthy();
    expect(sentInvoice.fiscalDocumentId).toBeTruthy();

    // 5. Send is idempotent
    const sendAgain = await request(server.baseUrl, `${base}/${invoiceId}/send`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({}),
    });
    expect(sendAgain.status).toBe(200);

    // 6. Public route now serves the invoice
    expect(sentInvoiceEmails.some((e) => e.to === "alice@example.com")).toBe(true);

    const publicRes = await request(server.baseUrl, `/api/invoices/public/${publicToken}`);
    expect(publicRes.status).toBe(200);
    const pubData = (publicRes.body as { data: { invoice: { invoiceNumber: string; status: string; totalMinor: number | string; customer: { name: string } } } }).data.invoice;
    expect(pubData.invoiceNumber).toBe(sentInvoice.invoiceNumber);
    expect(pubData.customer.name).toBe("Alice Wonderland");
    expect(pubData.status).toBe("pending");

    // 6b. Public pay endpoint generates online checkout
    const publicPayRes = await request(server.baseUrl, `/api/invoices/public/${publicToken}/pay`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(publicPayRes.status).toBe(200);
    const payResult = (publicPayRes.body as { data: { authorizationUrl: string; reference: string } }).data;
    expect(payResult.authorizationUrl).toContain("reference=");
    expect(payResult.reference).toMatch(/^scripe_inv_/);

    // 7. Record Partial Payment (e.g. 500,000 minor)
    const partPayRes = await request(server.baseUrl, `${base}/${invoiceId}/payments`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        amountMinor: "500000",
        method: "bank_transfer",
        externalReference: "TX_PARTIAL_001",
      }),
    });
    expect(partPayRes.status).toBe(200);
    const partPaidInv = (partPayRes.body as { data: { invoice: { status: string; amountPaidMinor: string; balanceDueMinor: string } } }).data.invoice;
    expect(partPaidInv.status).toBe("partially_paid");
    expect(partPaidInv.amountPaidMinor).toBe("500000");
    expect(partPaidInv.balanceDueMinor).toBe("755000");

    // 8. Cannot void invoice with payments recorded
    const voidFail = await request(server.baseUrl, `${base}/${invoiceId}/void`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({}),
    });
    expect(voidFail.status).toBe(409);

    // 9. Record Final Payment (755,000 minor) -> flips to paid
    const fullPayRes = await request(server.baseUrl, `${base}/${invoiceId}/payments`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        amountMinor: "755000",
        method: "bank_transfer",
        externalReference: "TX_FINAL_002",
      }),
    });
    expect(fullPayRes.status).toBe(200);
    const fullyPaidInv = (fullPayRes.body as { data: { invoice: { status: string; amountPaidMinor: string; balanceDueMinor: string } } }).data.invoice;
    expect(fullyPaidInv.status).toBe("paid");
    expect(fullyPaidInv.amountPaidMinor).toBe("1255000");
    expect(fullyPaidInv.balanceDueMinor).toBe("0");

    // 10. Check metrics
    const metricsRes = await request(server.baseUrl, `${base}/metrics`, {
      cookie: owner.cookies,
    });
    expect(metricsRes.status).toBe(200);
    const metrics = (metricsRes.body as { data: { metrics: { totalCount: number; paidCount: number; paidAmountMinor: string } } }).data.metrics;
    expect(metrics.totalCount).toBe(1);
    expect(metrics.paidCount).toBe(1);
    expect(metrics.paidAmountMinor).toBe("1255000");
  });

  it("can void an unpaid sent invoice", async () => {
    const owner = await authenticate("Void Owner");
    const bizRes = await request(server.baseUrl, "/api/businesses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ displayName: "Void Corp" }),
    });
    const businessId = (bizRes.body as { data: { business: { id: string } } }).data.business.id;
    const base = `/api/businesses/${businessId}/invoices`;

    const createRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        customer: { name: "Bob Builder", email: "bob@example.com" },
        dueDate: "2026-11-01",
        lines: [{ description: "Wood", quantity: 1, unitPriceMinor: "10000" }],
      }),
    });
    const invoiceId = (createRes.body as { data: { invoice: { id: string } } }).data.invoice.id;

    await request(server.baseUrl, `${base}/${invoiceId}/send`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({}),
    });

    const voidRes = await request(server.baseUrl, `${base}/${invoiceId}/void`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({}),
    });
    expect(voidRes.status).toBe(200);
    const voided = (voidRes.body as { data: { invoice: { status: string } } }).data.invoice;
    expect(voided.status).toBe("void");
  });

  it("runs overdue sweep and sends reminder emails for past due invoices", async () => {
    const owner = await authenticate("overdue-owner");
    const bizRes = await request(server.baseUrl, "/api/businesses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ displayName: "Overdue Corp" }),
    });
    const businessId = (bizRes.body as { data: { business: { id: string } } }).data.business.id;
    const base = `/api/businesses/${businessId}/invoices`;

    const invRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        customer: {
          name: "Bob Overdue",
          email: "bob@example.com",
        },
        issueDate: "2026-09-01",
        dueDate: "2026-09-10",
        lines: [{ description: "Consulting", quantity: 1, unitPriceMinor: 50000 }],
      }),
    });
    expect(invRes.status).toBe(201);
    const invoiceId = (invRes.body as { data: { invoice: { id: string } } }).data.invoice.id;

    await request(server.baseUrl, `${base}/${invoiceId}/send`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({}),
    });

    sentReminderEmails = [];
    const sweep = await withDatabaseContext(getDatabase(), anonymousPrincipal("test-sweep"), (ctx) =>
      runInvoiceOverdueSweep(ctx),
    );
    expect(sweep.remindersSent).toBeGreaterThanOrEqual(1);
    expect(sentReminderEmails.some((e) => e.to === "bob@example.com")).toBe(true);
  });
});
