import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];

jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

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

async function createBusiness(cookies: string, name: string): Promise<string> {
  const res = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ displayName: name }),
  });
  if (res.status !== 201) throw new Error(`Business creation failed: ${res.status}`);
  return (res.body as { data: { business: { id: string } } }).data.business.id;
}

describe("paylinks domain", () => {
  it("requires authentication for business paylink endpoints", async () => {
    const fakeBusinessId = randomUUID();
    const res = await request(server.baseUrl, `/api/businesses/${fakeBusinessId}/paylinks`);
    expect(res.status).toBe(401);
  });

  it("creates a payment link with generated slug, lists, updates, and archives it", async () => {
    const owner = await authenticate("Paylink Owner");
    const businessId = await createBusiness(owner.cookies, "Paylink Store");
    const base = `/api/businesses/${businessId}/paylinks`;

    // 1. Create Paylink
    const createRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Registration Fee",
        mode: "take_payment",
        amountType: "fixed",
        amountMinor: 500000, // ₦5,000
        description: "Annual membership fee",
        collectName: true,
        collectPhone: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const paylink = (createRes.body as any).data.paylink;
    expect(paylink.id).toBeDefined();
    expect(paylink.slug).toHaveLength(8);
    expect(paylink.title).toBe("Registration Fee");
    expect(paylink.amountMinor).toBe("500000");
    expect(paylink.status).toBe("active");

    // 2. List Paylinks
    const listRes = await request(server.baseUrl, base, {
      method: "GET",
      cookie: owner.cookies,
    });
    expect(listRes.status).toBe(200);
    const listData = (listRes.body as any).data;
    expect(listData.totalCount).toBe(1);
    expect(listData.paylinks[0].id).toBe(paylink.id);

    // 3. Get Paylink Details
    const getRes = await request(server.baseUrl, `${base}/${paylink.id}`, {
      method: "GET",
      cookie: owner.cookies,
    });
    expect(getRes.status).toBe(200);
    expect((getRes.body as any).data.paylink.title).toBe("Registration Fee");

    // 4. Update Paylink (pause)
    const updateRes = await request(server.baseUrl, `${base}/${paylink.id}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Registration Fee 2026",
        status: "paused",
      }),
    });
    expect(updateRes.status).toBe(200);
    expect((updateRes.body as any).data.paylink.status).toBe("paused");
    expect((updateRes.body as any).data.paylink.title).toBe("Registration Fee 2026");

    // 5. Archive Paylink
    const archiveRes = await request(server.baseUrl, `${base}/${paylink.id}`, {
      method: "DELETE",
      cookie: owner.cookies,
    });
    expect(archiveRes.status).toBe(200);

    // 6. Archived link is excluded from list
    const listAfterArchive = await request(server.baseUrl, base, {
      method: "GET",
      cookie: owner.cookies,
    });
    expect((listAfterArchive.body as any).data.totalCount).toBe(0);
  });

  it("handles custom slug creation and enforces unique slugs and reserved names", async () => {
    const owner = await authenticate("Slug Owner");
    const businessId = await createBusiness(owner.cookies, "Slug Store");
    const base = `/api/businesses/${businessId}/paylinks`;

    const uniqueSlug = `summer-camp-${randomUUID().slice(0, 8)}`;

    // 1. Create with custom slug
    const createRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Summer Camp",
        mode: "take_payment",
        amountType: "customer_sets",
        minAmountMinor: 100000,
        customSlug: uniqueSlug,
      }),
    });
    expect(createRes.status).toBe(201);
    expect((createRes.body as any).data.paylink.slug).toBe(uniqueSlug);

    // 2. Reject duplicate slug
    const duplicateRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Summer Camp Duplicate",
        mode: "take_payment",
        customSlug: uniqueSlug,
      }),
    });
    expect(duplicateRes.status).toBe(409);

    // 3. Reject reserved slug
    const reservedRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Admin link",
        mode: "take_payment",
        customSlug: "admin",
      }),
    });
    expect(reservedRes.status).toBe(400);
  });

  it("rejects cross-tenant access to another business's paylink", async () => {
    const owner1 = await authenticate("Owner One");
    const biz1 = await createBusiness(owner1.cookies, "Biz One");

    const owner2 = await authenticate("Owner Two");
    const biz2 = await createBusiness(owner2.cookies, "Biz Two");

    // Owner 1 creates link
    const createRes = await request(server.baseUrl, `/api/businesses/${biz1}/paylinks`, {
      method: "POST",
      cookie: owner1.cookies,
      body: JSON.stringify({
        title: "Secret Fundraiser",
        mode: "donation",
        amountType: "customer_sets",
      }),
    });
    expect(createRes.status).toBe(201);
    const linkId = (createRes.body as any).data.paylink.id;

    // Owner 2 tries to access Biz 1's link
    const crossGet = await request(server.baseUrl, `/api/businesses/${biz2}/paylinks/${linkId}`, {
      method: "GET",
      cookie: owner2.cookies,
    });
    expect(crossGet.status).toBe(404);
  });

  it("serves public link and completes public guest checkout flow", async () => {
    const owner = await authenticate("Public Pay Owner");
    const businessId = await createBusiness(owner.cookies, "Public Market");

    const publicSlug = `market-buy-${randomUUID().slice(0, 8)}`;

    const createRes = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Premium Artisan Bread",
        mode: "take_payment",
        amountType: "fixed",
        amountMinor: 350000, // ₦3,500
        description: "Freshly baked organic sourdough loaf",
        customSlug: publicSlug,
      }),
    });
    expect(createRes.status).toBe(201);

    // 1. Public Read (No cookies / anonymous)
    const publicGet = await request(server.baseUrl, `/api/public/paylinks/${publicSlug}`);
    expect(publicGet.status).toBe(200);
    const publicLink = (publicGet.body as any).data.paylink;
    expect(publicLink.title).toBe("Premium Artisan Bread");
    expect(publicLink.businessName).toBe("Public Market");
    expect(publicLink.amountMinor).toBe("350000");

    // 2. Public Guest Checkout
    const checkoutRes = await request(server.baseUrl, `/api/public/paylinks/${publicSlug}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        customerName: "Babajide Cole",
        customerEmail: "babajide@example.com",
        customerPhone: "+2348099887766",
        quantity: 2,
        idempotencyKey: `idemp_${Date.now()}`,
      }),
    });
    expect(checkoutRes.status).toBe(201);
    const checkoutData = (checkoutRes.body as any).data.checkout;
    expect(checkoutData.orderId).toBeDefined();
    expect(checkoutData.paymentId).toBeDefined();
    expect(checkoutData.reference).toBeDefined();
    expect(checkoutData.authorizationUrl).toBeDefined();

    // 3. Public Checkout Status Poll
    const statusRes = await request(
      server.baseUrl,
      `/api/public/paylinks/checkout/${checkoutData.reference}`,
    );
    expect(statusRes.status).toBe(200);
    const statusData = (statusRes.body as any).data.status;
    expect(statusData.reference).toBe(checkoutData.reference);
    expect(statusData.amountMinor).toBe("700000"); // 350000 * 2
  });
});
