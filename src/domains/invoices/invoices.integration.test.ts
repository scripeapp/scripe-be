import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];

type EmailParams = Record<string, unknown>;
const sentInvoiceEmails: { to: string; params: EmailParams }[] = [];
let sentReminderEmails: { to: string; params: EmailParams }[] = [];
const sentTransactionalEmails: { to: string; subject: string; html: string }[] = [];

jest.mock("@/shared/email.js", () => ({
  ...jest.requireActual<Record<string, unknown>>("@/shared/email.js"),
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendInvoiceIssued: (to: string, params: EmailParams) => sentInvoiceEmails.push({ to, params }),
    sendInvoiceReminder: (to: string, params: EmailParams) => sentReminderEmails.push({ to, params }),
    sendTransactional: (params: { to: string; subject: string; html: string }) => sentTransactionalEmails.push(params),
  },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";
import { getDatabase } from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { anonymousPrincipal } from "@/db/principal.js";
import { runInvoiceOverdueSweep } from "./invoices.service.js";
import { getPaystackGateway } from "@/integrations/checkout-gateway.js";
import { settleCheckoutPayment } from "@/domains/provider-events/checkout-settlement.js";
import { loadEnvironment } from "@/shared/environment.js";
import { Pool } from "pg";

/** Privileged connection for seeding rows the app role can't write (an issued virtual account) and for reading back across RLS. */
function migratorPool(): Pool {
  const environment = loadEnvironment();
  return new Pool({ connectionString: environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL });
}

async function seedActiveVirtualAccount(businessId: string, accountNumber: string): Promise<void> {
  const pool = migratorPool();
  try {
    await pool.query(
      `insert into app.virtual_accounts ("businessId", "provider", "accountNumber", "accountName", "bankName", "status")
       values ($1, 'anchor', $2, 'Settle Co Ltd', 'Providus Bank', 'active')`,
      [businessId, accountNumber],
    );
  } finally {
    await pool.end();
  }
}

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;

beforeAll(async () => {
  verificationMessages = [];
  // The Paystack dev mock is opt-in; without it checkout initiation answers 503.
  process.env.PAYSTACK_MOCK_CHECKOUT = "true";
  // Public calls each carry their own client IP (see publicRequest), so the
  // per-IP rate limits of one test never spill into another.
  process.env.TRUST_PROXY_HOPS = "1";
  server = await startTestServer();
});

afterAll(async () => server.close());

async function authenticate(label: string): Promise<{ cookies: string; userId: string; email: string }> {
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
  return { cookies: verified.cookies, userId, email };
}

let ipCounter = 0;
/** A public (no login) request from its own made-up client IP. */
function publicRequest(path: string, init: { method?: string; body?: string; ip?: string } = {}) {
  ipCounter += 1;
  const ip = init.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
  return request(server.baseUrl, path, { method: init.method, body: init.body, headers: { "x-forwarded-for": ip } });
}

/** Today in Lagos (the default store time zone), offset by `days`, as YYYY-MM-DD. */
function lagosDate(days = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type InvoiceBody = { data: { invoice: { id: string; status: string; publicToken: string; orderId: string; customer: { id: string } } } };

async function createBusiness(label: string): Promise<{ cookies: string; base: string; businessId: string; email: string; userId: string }> {
  const owner = await authenticate(label);
  const bizRes = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: owner.cookies,
    body: JSON.stringify({ displayName: `${label} Corp` }),
  });
  const businessId = (bizRes.body as { data: { business: { id: string } } }).data.business.id;
  return { cookies: owner.cookies, businessId, base: `/api/businesses/${businessId}/invoices`, email: owner.email, userId: owner.userId };
}

async function createInvoice(
  owner: { cookies: string; base: string },
  body: Record<string, unknown>,
  send = true,
): Promise<InvoiceBody["data"]["invoice"]> {
  const created = await request(server.baseUrl, owner.base, { method: "POST", cookie: owner.cookies, body: JSON.stringify(body) });
  expect(created.status).toBe(201);
  const invoice = (created.body as InvoiceBody).data.invoice;
  if (!send) return invoice;
  const sent = await request(server.baseUrl, `${owner.base}/${invoice.id}/send`, { method: "POST", cookie: owner.cookies, body: "{}" });
  expect(sent.status).toBe(200);
  return (sent.body as InvoiceBody).data.invoice;
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
    const draftPublic = await publicRequest(`/api/invoices/public/${publicToken}`);
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

    const publicRes = await publicRequest(`/api/invoices/public/${publicToken}`);
    expect(publicRes.status).toBe(200);
    const pubData = (publicRes.body as { data: { invoice: { invoiceNumber: string; status: string; totalMinor: number | string; customer: { name: string } } } }).data.invoice;
    expect(pubData.invoiceNumber).toBe(sentInvoice.invoiceNumber);
    expect(pubData.customer.name).toBe("Alice Wonderland");
    expect(pubData.status).toBe("pending");

    // 6b. Public pay endpoint generates online checkout
    const publicPayRes = await publicRequest(`/api/invoices/public/${publicToken}/pay`, {
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
        issueDate: lagosDate(-10),
        dueDate: lagosDate(-3),
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

  it("reminds only on the cadence days, and never twice in a day", async () => {
    const owner = await createBusiness("Cadence Owner");
    const onCadence = await createInvoice(owner, {
      customer: { name: "Cara Cadence", email: "cara-cadence@example.com" },
      issueDate: lagosDate(-20),
      dueDate: lagosDate(-7),
      lines: [{ description: "Work", quantity: 1, unitPriceMinor: "10000" }],
    });
    await createInvoice(owner, {
      customer: { name: "Otto OffCadence", email: "otto-offcadence@example.com" },
      issueDate: lagosDate(-20),
      dueDate: lagosDate(-2),
      lines: [{ description: "Work", quantity: 1, unitPriceMinor: "10000" }],
    });

    sentReminderEmails = [];
    await withDatabaseContext(getDatabase(), anonymousPrincipal("test-sweep"), (ctx) => runInvoiceOverdueSweep(ctx));
    expect(sentReminderEmails.some((e) => e.to === "cara-cadence@example.com")).toBe(true);
    expect(sentReminderEmails.some((e) => e.to === "otto-offcadence@example.com")).toBe(false);

    sentReminderEmails = [];
    await withDatabaseContext(getDatabase(), anonymousPrincipal("test-sweep"), (ctx) => runInvoiceOverdueSweep(ctx));
    expect(sentReminderEmails.some((e) => e.to === "cara-cadence@example.com")).toBe(false);
    expect(onCadence.status).toBe("overdue");
  });

  it("is not overdue on its due date in the store's time zone", async () => {
    const owner = await createBusiness("Due Today Owner");
    const dueToday = await createInvoice(owner, {
      customer: { name: "Dee Today", email: "dee-today@example.com" },
      dueDate: lagosDate(0),
      lines: [{ description: "Work", quantity: 1, unitPriceMinor: "10000" }],
    });
    expect(dueToday.status).toBe("pending");
    const pub = await publicRequest(`/api/invoices/public/${dueToday.publicToken}`);
    expect((pub.body as { data: { invoice: { status: string; dueDate: string } } }).data.invoice.status).toBe("pending");
  });

  it("filters the list by derived status and leaves drafts out of the metrics", async () => {
    const owner = await createBusiness("Filter Owner");
    await createInvoice(owner, { customer: { name: "Draft Dan", email: "draft-dan@example.com" }, dueDate: lagosDate(10), lines: [{ description: "A", quantity: 1, unitPriceMinor: "70000" }] }, false);
    await createInvoice(owner, { customer: { name: "Late Lou", email: "late-lou@example.com" }, issueDate: lagosDate(-30), dueDate: lagosDate(-5), lines: [{ description: "B", quantity: 1, unitPriceMinor: "20000" }] });
    const pending = await createInvoice(owner, { customer: { name: "Penny Pending", email: "penny-pending@example.com" }, dueDate: lagosDate(10), lines: [{ description: "C", quantity: 1, unitPriceMinor: "30000" }] });

    const overdueList = await request(server.baseUrl, `${owner.base}?status=overdue`, { cookie: owner.cookies });
    const overdue = (overdueList.body as { data: { invoices: { status: string }[] } }).data.invoices;
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.status).toBe("overdue");

    const pendingList = await request(server.baseUrl, `${owner.base}?status=pending`, { cookie: owner.cookies });
    const pendingIds = (pendingList.body as { data: { invoices: { id: string }[] } }).data.invoices.map((i) => i.id);
    expect(pendingIds).toEqual([pending.id]);

    const draftList = await request(server.baseUrl, `${owner.base}?status=draft`, { cookie: owner.cookies });
    expect((draftList.body as { data: { invoices: unknown[] } }).data.invoices).toHaveLength(1);

    const metricsRes = await request(server.baseUrl, `${owner.base}/metrics`, { cookie: owner.cookies });
    const metrics = (metricsRes.body as { data: { metrics: { totalCount: number; totalInvoicedMinor: string; overdueAmountMinor: string; pendingAmountMinor: string } } }).data.metrics;
    expect(metrics.totalCount).toBe(2);
    expect(metrics.totalInvoicedMinor).toBe("50000");
    expect(metrics.overdueAmountMinor).toBe("20000");
    expect(metrics.pendingAmountMinor).toBe("30000");
  });

  it("reuses an existing customer when the same email is typed again", async () => {
    const owner = await createBusiness("Reuse Owner");
    const first = await createInvoice(owner, { customer: { name: "Rita Repeat", email: "rita-repeat@example.com" }, dueDate: lagosDate(10), lines: [{ description: "A", quantity: 1, unitPriceMinor: "1000" }] }, false);
    const second = await createInvoice(owner, { customer: { name: "Rita R.", email: "RITA-REPEAT@example.com" }, dueDate: lagosDate(10), lines: [{ description: "B", quantity: 1, unitPriceMinor: "1000" }] }, false);
    expect(second.customer.id).toBe(first.customer.id);

    const updated = await request(server.baseUrl, `${owner.base}/${first.id}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ customer: { name: "Rita Repeat", email: "rita-repeat@example.com" } }),
    });
    expect((updated.body as InvoiceBody).data.invoice.customer.id).toBe(first.customer.id);
  });

  it("recomputes totals on a discount-only edit", async () => {
    const owner = await createBusiness("Discount Owner");
    const draft = await createInvoice(owner, { customer: { name: "Dora Discount", email: "dora-discount@example.com" }, dueDate: lagosDate(10), lines: [{ description: "A", quantity: 1, unitPriceMinor: "100000" }] }, false);
    const updated = await request(server.baseUrl, `${owner.base}/${draft.id}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ discountMinor: "10000" }),
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { invoice: { totalMinor: string; lines: unknown[] } } }).data.invoice.totalMinor).toBe("90000");
    expect((updated.body as { data: { invoice: { lines: unknown[] } } }).data.invoice.lines).toHaveLength(1);
  });

  it("keeps fractional quantities' money exact on the order", async () => {
    const owner = await createBusiness("Fraction Owner");
    const sent = await createInvoice(owner, {
      customer: { name: "Fran Fraction", email: "fran-fraction@example.com" },
      dueDate: lagosDate(10),
      lines: [{ description: "Consulting hours", quantity: 1.5, unitPriceMinor: "1000000", taxRateBps: 750 }],
    });
    const order = await request(server.baseUrl, `/api/businesses/${owner.businessId}/orders/${sent.orderId}`, { cookie: owner.cookies });
    const orderBody = order.body as { data: { order: { totalMinor: string; lines: { quantity: number; unitPriceMinor: string; taxMinor: string; lineTotalMinor: string; description: string }[] } } };
    const line = orderBody.data.order.lines[0]!;
    // 1.5 x 10,000.00 = 15,000.00 + 7.5% VAT 1,125.00 = 16,125.00, billed as one unit.
    expect(orderBody.data.order.totalMinor).toBe("1612500");
    expect(line.quantity).toBe(1);
    expect(line.unitPriceMinor).toBe("1500000");
    expect(line.taxMinor).toBe("112500");
    expect(line.lineTotalMinor).toBe("1612500");
    expect(line.description).toContain("qty 1.5");
  });

  it("hands back the same checkout on repeat pay clicks and blocks voiding mid-checkout", async () => {
    const owner = await createBusiness("Checkout Owner");
    const sent = await createInvoice(owner, { customer: { name: "Cal Checkout", email: "cal-checkout@example.com" }, dueDate: lagosDate(10), lines: [{ description: "A", quantity: 1, unitPriceMinor: "50000" }] });

    const first = await publicRequest(`/api/invoices/public/${sent.publicToken}/pay`, {
      method: "POST",
      body: JSON.stringify({ callbackUrl: "https://evil.example.com/steal" }),
    });
    expect(first.status).toBe(200);
    const firstData = (first.body as { data: { authorizationUrl: string; reference: string } }).data;
    expect(firstData.authorizationUrl).not.toContain("evil.example.com");

    const second = await publicRequest(`/api/invoices/public/${sent.publicToken}/pay`, { method: "POST", body: "{}" });
    expect((second.body as { data: { reference: string } }).data.reference).toBe(firstData.reference);

    const voidRes = await request(server.baseUrl, `${owner.base}/${sent.id}/void`, { method: "POST", cookie: owner.cookies, body: "{}" });
    expect(voidRes.status).toBe(409);
  });

  it("settles online invoice payments to the business account and tells both sides", async () => {
    const owner = await createBusiness("Settle Owner");
    const accountNumber = String(Math.floor(1e9 + Math.random() * 8e9));
    await seedActiveVirtualAccount(owner.businessId, accountNumber);
    const sent = await createInvoice(owner, { customer: { name: "Sam Settle", email: "sam-settle@example.com" }, dueDate: lagosDate(10), lines: [{ description: "Work", quantity: 1, unitPriceMinor: "250000" }] });

    const pay = await publicRequest(`/api/invoices/public/${sent.publicToken}/pay`, { method: "POST", body: "{}" });
    expect(pay.status).toBe(200);
    const reference = (pay.body as { data: { reference: string } }).data.reference;
    expect(getPaystackGateway().mockSubaccountFor(reference)).toBe(`ACCT_mock_${accountNumber}`);

    const settings = await request(server.baseUrl, `/api/businesses/${owner.businessId}/subaccount`, { cookie: owner.cookies });
    const view = (settings.body as { data: { is_configured: boolean; account_number: string } }).data;
    expect(view.is_configured).toBe(true);
    expect(view.account_number).toBe(accountNumber);

    sentTransactionalEmails.length = 0;
    const outcome = await withDatabaseContext(getDatabase(), anonymousPrincipal("test-webhook"), (ctx) =>
      settleCheckoutPayment(ctx, reference, { amountMinor: "250000", currency: "NGN" }),
    );
    expect(outcome.status).toBe("captured");

    const detail = await request(server.baseUrl, `${owner.base}/${sent.id}`, { cookie: owner.cookies });
    expect((detail.body as InvoiceBody).data.invoice.status).toBe("paid");
    expect(sentTransactionalEmails.some((e) => e.to === "sam-settle@example.com" && e.subject.startsWith("Payment received"))).toBe(true);
    expect(sentTransactionalEmails.some((e) => e.to === owner.email && e.subject.includes("is paid"))).toBe(true);

    const pool = migratorPool();
    try {
      const notes = await pool.query<{ type: string }>(`select "type" from app.notifications where "userId" = $1 and "businessId" = $2`, [owner.userId, owner.businessId]);
      expect(notes.rows.map((n) => n.type)).toContain("invoice.paid");
    } finally {
      await pool.end();
    }
  });

  it("refuses online payment when real Paystack is configured and the business has no payout account", async () => {
    const owner = await createBusiness("NoPayout Owner");
    const sent = await createInvoice(owner, { customer: { name: "Nia NoPayout", email: "nia-nopayout@example.com" }, dueDate: lagosDate(10), lines: [{ description: "Work", quantity: 1, unitPriceMinor: "10000" }] });
    const previous = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = "sk_test_not_a_real_key";
    try {
      const pay = await publicRequest(`/api/invoices/public/${sent.publicToken}/pay`, { method: "POST", body: "{}" });
      expect(pay.status).toBe(409);
    } finally {
      if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY;
      else process.env.PAYSTACK_SECRET_KEY = previous;
    }
  });

  it("emails a receipt when the merchant records a payment", async () => {
    const owner = await createBusiness("Manual Owner");
    const sent = await createInvoice(owner, { customer: { name: "Mo Manual", email: "mo-manual@example.com" }, dueDate: lagosDate(10), lines: [{ description: "Work", quantity: 1, unitPriceMinor: "40000" }] });
    sentTransactionalEmails.length = 0;
    const paid = await request(server.baseUrl, `${owner.base}/${sent.id}/payments`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ amountMinor: "15000", method: "bank_transfer" }),
    });
    expect(paid.status).toBe(200);
    const receipt = sentTransactionalEmails.find((e) => e.to === "mo-manual@example.com");
    expect(receipt?.html).toContain("₦150.00");
    expect(receipt?.html).toContain("₦250.00");
  });

  it("tells the merchant once when a customer reports a transfer", async () => {
    const owner = await createBusiness("Transfer Owner");
    const sent = await createInvoice(owner, { customer: { name: "Tia Transfer", email: "tia-transfer@example.com" }, dueDate: lagosDate(10), lines: [{ description: "Work", quantity: 1, unitPriceMinor: "30000" }] });
    sentTransactionalEmails.length = 0;

    const first = await publicRequest(`/api/invoices/public/${sent.publicToken}/transfer-reported`, { method: "POST", body: "{}" });
    expect(first.status).toBe(200);
    const again = await publicRequest(`/api/invoices/public/${sent.publicToken}/transfer-reported`, { method: "POST", body: "{}" });
    expect(again.status).toBe(200);
    expect(sentTransactionalEmails.filter((e) => e.to === owner.email)).toHaveLength(1);

    const detail = await request(server.baseUrl, `${owner.base}/${sent.id}`, { cookie: owner.cookies });
    const invoice = (detail.body as { data: { invoice: { status: string; transferReportedAt: string | null } } }).data.invoice;
    expect(invoice.transferReportedAt).toBeTruthy();
    expect(invoice.status).toBe("pending");

    const pub = await publicRequest(`/api/invoices/public/${sent.publicToken}`);
    expect((pub.body as { data: { invoice: { transferReportedAt: string | null } } }).data.invoice.transferReportedAt).toBeTruthy();
  });

  it("duplicates an invoice into a new draft dated today", async () => {
    const owner = await createBusiness("Duplicate Owner");
    const sent = await createInvoice(owner, {
      customer: { name: "Dua Duplicate", email: "dua-duplicate@example.com" },
      issueDate: lagosDate(-20),
      dueDate: lagosDate(-6),
      discountMinor: "5000",
      notes: "Same as last month",
      lines: [
        { description: "Retainer", quantity: 1, unitPriceMinor: "100000", taxRateBps: 750 },
        { description: "Extra", quantity: 2, unitPriceMinor: "10000", discountMinor: "1000" },
      ],
    });
    const copy = await request(server.baseUrl, `${owner.base}/${sent.id}/duplicate`, { method: "POST", cookie: owner.cookies, body: "{}" });
    expect(copy.status).toBe(201);
    const draft = (copy.body as { data: { invoice: { id: string; status: string; issueDate: string; dueDate: string; totalMinor: string; notes: string; lines: unknown[]; customer: { id: string } } } }).data.invoice;
    const original = await request(server.baseUrl, `${owner.base}/${sent.id}`, { cookie: owner.cookies });
    const source = (original.body as { data: { invoice: { totalMinor: string } } }).data.invoice;
    expect(draft.id).not.toBe(sent.id);
    expect(draft.status).toBe("draft");
    expect(draft.issueDate).toBe(lagosDate(0));
    expect(draft.dueDate).toBe(lagosDate(14));
    expect(draft.totalMinor).toBe(source.totalMinor);
    expect(draft.lines).toHaveLength(2);
    expect(draft.notes).toBe("Same as last month");
    expect(draft.customer.id).toBe(sent.customer.id);
  });

  it("rate-limits checkout attempts on one invoice link", async () => {
    const owner = await createBusiness("RateLimit Owner");
    const sent = await createInvoice(owner, { customer: { name: "Rae Rate", email: "rae-rate@example.com" }, dueDate: lagosDate(10), lines: [{ description: "Work", quantity: 1, unitPriceMinor: "10000" }] });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const pay = await publicRequest(`/api/invoices/public/${sent.publicToken}/pay`, { method: "POST", body: "{}" });
      statuses.push(pay.status);
    }
    expect(statuses.slice(0, 5).every((status) => status === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
