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
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { cookies: verified.cookies };
}

interface Setup {
  readonly base: string;
  readonly businessId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly inventoryItemId: string;
  readonly inventoryLocationId: string;
}

/** Mirrors returns.integration.test.ts's setUpOrderWithInventory - a store, product, priced variant, inventory item/location, and a checked-out (unpaid) order. */
async function setUpOrderWithInventory(cookies: string, quantity: number, unitPriceMinor: number): Promise<Setup> {
  const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `Accounting Co ${randomUUID().slice(0, 8)}` }) });
  const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  const base = `/api/businesses/${business.id}`;

  const channelResponse = await request(server.baseUrl, `${base}/stores/${business.defaultStore.id}/channels`, { method: "POST", cookie: cookies, body: JSON.stringify({ code: `web${randomUUID().slice(0, 6)}`, name: "Web", kind: "storefront" }) });
  const channel = (channelResponse.body as { data: { channel: { id: string } } }).data.channel;

  const productResponse = await request(server.baseUrl, `${base}/products`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId: business.defaultStore.id, name: "Ledger Widget", status: "active", variant: { name: "Default" } }) });
  const variant = (productResponse.body as { data: { product: { variants: [{ id: string }] } } }).data.product.variants[0];
  await request(server.baseUrl, `${base}/prices`, { method: "POST", cookie: cookies, body: JSON.stringify({ productVariantId: variant.id, assetCode: "NGN", amountMinor: unitPriceMinor }) });

  const locationResponse = await request(server.baseUrl, `${base}/stores/${business.defaultStore.id}/locations`, { method: "POST", cookie: cookies, body: JSON.stringify({ name: "Main Warehouse" }) });
  const location = (locationResponse.body as { data: { location: { id: string } } }).data.location;

  const itemResponse = await request(server.baseUrl, `${base}/inventory/items`, { method: "POST", cookie: cookies, body: JSON.stringify({ name: "Ledger Widget", variantId: variant.id }) });
  const item = (itemResponse.body as { data: { item: { id: string } } }).data.item;

  const inventoryLocationResponse = await request(server.baseUrl, `${base}/inventory/locations`, { method: "POST", cookie: cookies, body: JSON.stringify({ locationId: location.id, name: "Main Warehouse" }) });
  const inventoryLocation = (inventoryLocationResponse.body as { data: { location: { id: string } } }).data.location;

  const cartResponse = await request(server.baseUrl, `${base}/carts`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId: business.defaultStore.id, channelId: channel.id }) });
  const cart = (cartResponse.body as { data: { cart: { id: string } } }).data.cart;
  await request(server.baseUrl, `${base}/carts/${cart.id}/lines`, { method: "POST", cookie: cookies, body: JSON.stringify({ productVariantId: variant.id, quantity }) });
  const checkout = await request(server.baseUrl, `${base}/carts/${cart.id}/checkout`, { method: "POST", cookie: cookies, body: JSON.stringify({ idempotencyKey: `checkout-${randomUUID()}` }) });
  const orderId = (checkout.body as { data: { checkout: { orderId: string } } }).data.checkout.orderId;

  const order = await request(server.baseUrl, `${base}/orders/${orderId}`, { cookie: cookies });
  const orderLineId = (order.body as { data: { order: { lines: { id: string }[] } } }).data.order.lines[0]!.id;

  return { base, businessId: business.id, orderId, orderLineId, inventoryItemId: item.id, inventoryLocationId: inventoryLocation.id };
}

interface TrialBalanceLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly type: string;
  readonly debitMinor: string;
  readonly creditMinor: string;
}

async function trialBalance(cookies: string, base: string): Promise<TrialBalanceLine[]> {
  const response = await request(server.baseUrl, `${base}/accounting/trial-balance`, { cookie: cookies });
  return (response.body as { data: { lines: TrialBalanceLine[] } }).data.lines;
}

function balanceOf(lines: TrialBalanceLine[], code: string): { debit: bigint; credit: bigint } {
  const line = lines.find((l) => l.accountCode === code);
  return { debit: BigInt(line?.debitMinor ?? "0"), credit: BigInt(line?.creditMinor ?? "0") };
}

describe("accounting domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/accounting/ledger-accounts`)).status).toBe(401);
  });

  it("seeds the standard chart of accounts when a business is created", async () => {
    const owner = await authenticate("Chart Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 1, 10000);
    const response = await request(server.baseUrl, `${setup.base}/accounting/ledger-accounts`, { cookie: owner.cookies });
    expect(response.status).toBe(200);
    const accounts = (response.body as { data: { accounts: { code: string; type: string }[] } }).data.accounts;
    expect(accounts.map((a) => a.code).sort()).toEqual(
      [
        "accounts_payable", "bank", "cash", "cogs", "fees_expense", "gateway_clearing", "general_expense", "inventory",
        "payroll_expense", "refunds_payable", "rent_expense", "revenue", "sales_returns", "tax_expense", "tax_payable",
        "utilities_expense", "waste_expense",
      ].sort(),
    );
  });

  it("posts a balanced journal entry when a cash payment is captured", async () => {
    const owner = await authenticate("Capture Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 2, 10000); // order total 20000, no tax

    const recorded = await request(server.baseUrl, `${setup.base}/payments`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ orderId: setup.orderId, method: "cash", assetCode: "NGN", amountMinor: 20000, idempotencyKey: `pay-${randomUUID()}` }),
    });
    expect(recorded.status).toBe(201);

    const lines = await trialBalance(owner.cookies, setup.base);
    expect(balanceOf(lines, "cash").debit).toBe(20000n);
    expect(balanceOf(lines, "revenue").credit).toBe(20000n);

    const entries = await request(server.baseUrl, `${setup.base}/accounting/journal-entries`, { cookie: owner.cookies });
    const entryList = (entries.body as { data: { entries: { sourceType: string }[] } }).data.entries;
    expect(entryList.some((e) => e.sourceType === "payment_capture")).toBe(true);
  });

  it("posts a refund-obligation journal entry when a return is recorded", async () => {
    const owner = await authenticate("Return Journal Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 1, 15000);

    const created = await request(server.baseUrl, `${setup.base}/returns`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ orderId: setup.orderId, reason: "Wrong size", lines: [{ orderLineId: setup.orderLineId, quantity: 1, condition: "sellable", restock: false }] }),
    });
    expect(created.status).toBe(201);

    const lines = await trialBalance(owner.cookies, setup.base);
    expect(balanceOf(lines, "sales_returns").debit).toBe(15000n);
    expect(balanceOf(lines, "refunds_payable").credit).toBe(15000n);
  });

  it("posts an accounts-payable journal when a bill is created, and settles it on payment", async () => {
    const owner = await authenticate("Bill Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 1, 10000);

    const bill = await request(server.baseUrl, `${setup.base}/payables/bills`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        billNumber: `BILL-${randomUUID().slice(0, 8)}`,
        billType: "rent",
        subtotalMinor: 40000,
        taxMinor: 4000,
        totalMinor: 44000,
        lines: [{ description: "Warehouse rent", quantity: 1, unitAmountMinor: 40000, taxMinor: 4000, lineTotalMinor: 40000, accountCategory: "rent" }],
      }),
    });
    expect(bill.status).toBe(201);
    const billId = (bill.body as { data: { bill: { id: string } } }).data.bill.id;

    let lines = await trialBalance(owner.cookies, setup.base);
    expect(balanceOf(lines, "rent_expense").debit).toBe(40000n);
    expect(balanceOf(lines, "tax_expense").debit).toBe(4000n);
    expect(balanceOf(lines, "accounts_payable").credit).toBe(44000n);

    const paid = await request(server.baseUrl, `${setup.base}/payables/bills/${billId}/payments`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ paymentReference: `ref-${randomUUID()}`, amountMinor: 44000, assetCode: "NGN" }),
    });
    expect(paid.status).toBe(201);

    lines = await trialBalance(owner.cookies, setup.base);
    expect(balanceOf(lines, "accounts_payable").debit).toBe(44000n);
    expect(balanceOf(lines, "accounts_payable").credit).toBe(44000n); // fully settled: debit and credit both posted, net zero
    expect(balanceOf(lines, "bank").credit).toBe(44000n);
  });

  it("posts a waste-expense journal when a costed waste movement is recorded", async () => {
    const owner = await authenticate("Waste Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 1, 10000);

    // Bring stock on hand up first (a receipt), then waste some of it.
    await request(server.baseUrl, `${setup.base}/inventory/movements`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ inventoryItemId: setup.inventoryItemId, inventoryLocationId: setup.inventoryLocationId, quantity: 5, type: "receipt", reason: "Initial stock", idempotencyKey: `recv-${randomUUID()}`, unitCostMinor: 3000 }),
    });
    const waste = await request(server.baseUrl, `${setup.base}/inventory/movements`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ inventoryItemId: setup.inventoryItemId, inventoryLocationId: setup.inventoryLocationId, quantity: -2, type: "waste", reason: "Damaged in storage", idempotencyKey: `waste-${randomUUID()}`, unitCostMinor: 3000 }),
    });
    expect(waste.status).toBe(201);

    const lines = await trialBalance(owner.cookies, setup.base);
    expect(balanceOf(lines, "waste_expense").debit).toBe(6000n);
    expect(balanceOf(lines, "inventory").credit).toBe(6000n);
  });

  it("keeps every posted journal balanced - total debits equal total credits across every account", async () => {
    const owner = await authenticate("Balance Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 3, 10000);

    await request(server.baseUrl, `${setup.base}/payments`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ orderId: setup.orderId, method: "card", assetCode: "NGN", amountMinor: 30000, idempotencyKey: `pay-${randomUUID()}` }) });
    await request(server.baseUrl, `${setup.base}/returns`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ orderId: setup.orderId, reason: "Partial return", lines: [{ orderLineId: setup.orderLineId, quantity: 1, condition: "sellable", restock: false }] }) });

    const lines = await trialBalance(owner.cookies, setup.base);
    const totalDebit = lines.reduce((sum, line) => sum + BigInt(line.debitMinor), 0n);
    const totalCredit = lines.reduce((sum, line) => sum + BigInt(line.creditMinor), 0n);
    expect(totalDebit).toBe(totalCredit);
  });

  it("blocks new postings into a locked accounting period", async () => {
    const owner = await authenticate("Locked Period Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 1, 10000);

    // Establish the current month's period row via a first posting, then lock it.
    await request(server.baseUrl, `${setup.base}/payments`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ orderId: setup.orderId, method: "cash", assetCode: "NGN", amountMinor: 10000, idempotencyKey: `pay-${randomUUID()}` }) });

    const periods = await request(server.baseUrl, `${setup.base}/accounting/periods`, { cookie: owner.cookies });
    const periodId = (periods.body as { data: { periods: { id: string }[] } }).data.periods[0]!.id;
    const locked = await request(server.baseUrl, `${setup.base}/accounting/periods/${periodId}`, { method: "PATCH", cookie: owner.cookies, body: JSON.stringify({ status: "locked" }) });
    expect(locked.status).toBe(200);

    const secondSetup = await setUpOrderWithInventory(owner.cookies, 1, 10000);
    // Same business context isn't shared across setups, so directly exercise the locked business instead.
    const blocked = await request(server.baseUrl, `${setup.base}/returns`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ orderId: setup.orderId, reason: "Should be blocked", lines: [{ orderLineId: setup.orderLineId, quantity: 1, condition: "sellable", restock: false }] }),
    });
    expect(blocked.status).toBe(503);
    void secondSetup;
  });

  it("rejects cross-tenant ledger access", async () => {
    const owner = await authenticate("Isolated Ledger Owner");
    const outsider = await authenticate("Isolated Ledger Outsider");
    const setup = await setUpOrderWithInventory(owner.cookies, 1, 10000);
    const forbidden = await request(server.baseUrl, `${setup.base}/accounting/ledger-accounts`, { cookie: outsider.cookies });
    expect(forbidden.status).toBe(403);
  });
});
