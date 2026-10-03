import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
const sentInvoiceEmails: { to: string; params: Record<string, unknown> }[] = [];
jest.mock("@/shared/email.js", () => ({
  ...jest.requireActual<Record<string, unknown>>("@/shared/email.js"),
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendInvoiceIssued: (to: string, params: Record<string, unknown>) => sentInvoiceEmails.push({ to, params }),
    sendInvoiceReminder: () => {},
    sendTransactional: () => {},
  },
}));

// Never hit real object storage from a test (same mock as the uploads suite).
const uploadedObjects = new Map<string, number>();
jest.mock("@/integrations/r2.js", () => ({
  objectStorage: {
    createPresignedUploadUrl: (key: string) => Promise.resolve({ uploadUrl: `https://mock-r2.test/${key}`, expiresAt: new Date(Date.now() + 600_000) }),
    createPresignedDownloadUrl: (key: string) => Promise.resolve(`https://mock-r2.test/${key}?download`),
    headObject: (key: string) => Promise.resolve(uploadedObjects.has(key) ? { exists: true, sizeBytes: uploadedObjects.get(key) } : { exists: false }),
    deleteObject: () => Promise.resolve(),
  },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
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

async function createBusiness(cookies: string, name: string): Promise<{ id: string; storeId: string; storeSlug: string }> {
  const created = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: name }) });
  const business = (created.body as { data: { business: { id: string; defaultStore: { id: string; slug: string } } } }).data.business;
  return { id: business.id, storeId: business.defaultStore.id, storeSlug: business.defaultStore.slug };
}

/** Creates, "uploads" and confirms an image for the business; returns the upload id. */
async function uploadImage(cookies: string, businessId: string, purpose: string, mimeType = "image/png", confirm = true): Promise<{ id: string; status: number }> {
  const created = await request(server.baseUrl, "/api/uploads", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ businessId, purpose, mimeType, sizeBytes: "2048" }),
  });
  if (created.status !== 201) return { id: "", status: created.status };
  const body = created.body as { data: { upload: { id: string }; uploadUrl: string } };
  const key = body.data.uploadUrl.replace("https://mock-r2.test/", "");
  uploadedObjects.set(key, 2048);
  if (confirm) {
    const confirmed = await request(server.baseUrl, `/api/uploads/${body.data.upload.id}/confirm`, { method: "POST", cookie: cookies });
    expect(confirmed.status).toBe(200);
  }
  return { id: body.data.upload.id, status: created.status };
}

type BrandingBody = { data: { business: { branding: { logoUrl: string | null; coverUrl: string | null; brandColor: string | null } } } };

describe("business branding", () => {
  it("links a logo, banner and colour, and serves them publicly", async () => {
    const owner = await authenticate("Brand Owner");
    const business = await createBusiness(owner.cookies, "Brand Co");
    const logo = await uploadImage(owner.cookies, business.id, "business_logo");
    const cover = await uploadImage(owner.cookies, business.id, "business_cover", "image/webp");

    const updated = await request(server.baseUrl, `/api/businesses/${business.id}/branding`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ logoUploadId: logo.id, coverUploadId: cover.id, brandColor: "#1a2b3c" }),
    });
    expect(updated.status).toBe(200);
    const branding = (updated.body as BrandingBody).data.business.branding;
    expect(branding.logoUrl).toBe(`/api/businesses/${business.id}/branding/logo?v=${logo.id}`);
    expect(branding.coverUrl).toBe(`/api/businesses/${business.id}/branding/cover?v=${cover.id}`);
    expect(branding.brandColor).toBe("#1A2B3C");

    const fetched = await request(server.baseUrl, `/api/businesses/${business.id}`, { cookie: owner.cookies });
    expect((fetched.body as BrandingBody).data.business.branding.brandColor).toBe("#1A2B3C");

    const publicBranding = await request(server.baseUrl, `/api/businesses/${business.id}/branding`, { origin: null });
    expect(publicBranding.status).toBe(200);
    expect((publicBranding.body as { data: { branding: { logoUrl: string } } }).data.branding.logoUrl).toContain("/branding/logo");

    const logoImage = await request(server.baseUrl, `/api/businesses/${business.id}/branding/logo?v=${logo.id}`, { origin: null });
    expect(logoImage.status).toBe(302);

    // The storefront is public only once the store is active.
    const activated = await request(server.baseUrl, `/api/businesses/${business.id}/stores/${business.storeId}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ status: "active" }),
    });
    expect(activated.status).toBe(200);
    const storefront = await request(server.baseUrl, `/api/store/public/${business.storeSlug}`, { origin: null });
    expect(storefront.status).toBe(200);
    const storeData = storefront.body as { data: { store?: { branding: { logoUrl: string | null; brandColor: string | null } }; branding?: { logoUrl: string | null; brandColor: string | null } } };
    const storeBranding = storeData.data.store?.branding ?? storeData.data.branding;
    expect(storeBranding?.logoUrl).toMatch(/^https?:\/\/.+\/api\/businesses\/.+\/branding\/logo\?v=/);
    expect(storeBranding?.brandColor).toBe("#1A2B3C");

    const cleared = await request(server.baseUrl, `/api/businesses/${business.id}/branding`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ logoUploadId: null }),
    });
    const afterClear = (cleared.body as BrandingBody).data.business.branding;
    expect(afterClear.logoUrl).toBeNull();
    expect(afterClear.coverUrl).not.toBeNull();
    expect(afterClear.brandColor).toBe("#1A2B3C");

    const gone = await request(server.baseUrl, `/api/businesses/${business.id}/branding/logo`, { origin: null });
    expect(gone.status).toBe(404);

    // A new banner replaces the old one and reaches the storefront.
    const newCover = await uploadImage(owner.cookies, business.id, "business_cover", "image/jpeg");
    const withCover = await request(server.baseUrl, `/api/businesses/${business.id}/branding`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ coverUploadId: newCover.id }),
    });
    expect(withCover.status).toBe(200);
    expect((withCover.body as { data: { business: { branding: { coverUrl: string | null } } } }).data.business.branding.coverUrl).toBe(
      `/api/businesses/${business.id}/branding/cover?v=${newCover.id}`,
    );
    const coverImage = await request(server.baseUrl, `/api/businesses/${business.id}/branding/cover?v=${newCover.id}`, { origin: null });
    expect(coverImage.status).toBe(302);
    const storefrontWithCover = await request(server.baseUrl, `/api/store/public/${business.storeSlug}`, { origin: null });
    expect((storefrontWithCover.body as { data: { store: { branding: { coverUrl: string } } } }).data.store.branding.coverUrl).toMatch(
      /^https?:\/\/.+\/api\/businesses\/.+\/branding\/cover\?v=/,
    );
  });

  it("rejects images that aren't this business's confirmed logo", async () => {
    const owner = await authenticate("Strict Brand Owner");
    const business = await createBusiness(owner.cookies, "Strict Brand Co");
    const other = await createBusiness(owner.cookies, "Other Brand Co");

    const pdf = await uploadImage(owner.cookies, business.id, "business_logo", "application/pdf");
    expect(pdf.status).toBe(400);

    const patch = (body: Record<string, unknown>) =>
      request(server.baseUrl, `/api/businesses/${business.id}/branding`, { method: "PATCH", cookie: owner.cookies, body: JSON.stringify(body) });

    const otherLogo = await uploadImage(owner.cookies, other.id, "business_logo");
    expect((await patch({ logoUploadId: otherLogo.id })).status).toBe(404);

    const unconfirmed = await uploadImage(owner.cookies, business.id, "business_logo", "image/png", false);
    expect((await patch({ logoUploadId: unconfirmed.id })).status).toBe(409);

    const coverAsLogo = await uploadImage(owner.cookies, business.id, "business_cover");
    expect((await patch({ logoUploadId: coverAsLogo.id })).status).toBe(409);
    const realLogo = await uploadImage(owner.cookies, business.id, "business_logo");
    expect((await patch({ coverUploadId: realLogo.id })).status).toBe(409);
    expect((await uploadImage(owner.cookies, business.id, "business_icon")).status).toBe(400);

    expect((await patch({ brandColor: "red" })).status).toBe(400);
    expect((await patch({ brandColor: "#12345" })).status).toBe(400);

    const stranger = await authenticate("Brand Stranger");
    const foreign = await request(server.baseUrl, `/api/businesses/${business.id}/branding`, {
      method: "PATCH",
      cookie: stranger.cookies,
      body: JSON.stringify({ brandColor: "#000000" }),
    });
    expect([403, 404]).toContain(foreign.status);
  });

  it("brands the public invoice and the invoice email", async () => {
    process.env.PAYSTACK_MOCK_CHECKOUT = "true";
    const owner = await authenticate("Invoice Brand Owner");
    const business = await createBusiness(owner.cookies, "Invoice Brand Co");
    const logo = await uploadImage(owner.cookies, business.id, "business_logo");
    await request(server.baseUrl, `/api/businesses/${business.id}/branding`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ logoUploadId: logo.id, brandColor: "#123456" }),
    });

    const base = `/api/businesses/${business.id}/invoices`;
    const created = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        customer: { name: "Bea Branded", email: "bea-branded@example.com" },
        dueDate: "2099-01-01",
        lines: [{ description: "Design", quantity: 1, unitPriceMinor: "50000" }],
      }),
    });
    const invoice = (created.body as { data: { invoice: { id: string; publicToken: string } } }).data.invoice;
    await request(server.baseUrl, `${base}/${invoice.id}/send`, { method: "POST", cookie: owner.cookies, body: "{}" });

    const email = sentInvoiceEmails.find((sent) => sent.to === "bea-branded@example.com");
    expect(email?.params.brandColor).toBe("#123456");
    expect(String(email?.params.logoUrl)).toMatch(/^https?:\/\/.+\/branding\/logo\?v=/);

    const pub = await request(server.baseUrl, `/api/invoices/public/${invoice.publicToken}`, { origin: null, headers: { "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.1` } });
    const publicBusiness = (pub.body as { data: { invoice: { business: { brandColor: string; logoUrl: string; logoVersion?: string } } } }).data.invoice.business;
    expect(publicBusiness.brandColor).toBe("#123456");
    expect(publicBusiness.logoUrl).toContain(`/branding/logo?v=${logo.id}`);
    expect(publicBusiness.logoVersion).toBeUndefined();
  });
});
