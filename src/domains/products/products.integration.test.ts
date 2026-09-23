import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;
jest.setTimeout(30_000);

beforeAll(async () => { verificationMessages = []; server = await startTestServer(); });
afterAll(async () => server.close());

async function actor(label: string): Promise<string> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: PASSWORD }) });
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const code = verificationMessages.find((message) => message.to === email)?.code;
  if (signup.status !== 200 || !(body.user?.id ?? body.data?.user?.id) || !code) throw new Error("Unable to authenticate product test actor");
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return verified.cookies;
}

describe("products/catalog domain", () => {
  it("requires authentication", async () => { expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/products`)).status).toBe(401); });
  it("creates a product with a default variant, categories, updates, and archives it", async () => {
    const cookies = await actor("Catalog Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: "Catalog Market" }) });
    expect(businessResponse.status).toBe(201);
    const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const categoryResponse = await request(server.baseUrl, `/api/businesses/${business.id}/categories`, { method: "POST", cookie: cookies, body: JSON.stringify({ name: "Beverages" }) });
    expect(categoryResponse.status).toBe(201);
    const category = (categoryResponse.body as { data: { category: { id: string } } }).data.category;
    const productResponse = await request(server.baseUrl, `/api/businesses/${business.id}/products`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId: business.defaultStore.id, name: "Coffee", categoryIds: [category.id] }) });
    expect(productResponse.status).toBe(201);
    const product = (productResponse.body as { data: { product: { id: string; variants: { isDefault: boolean }[]; categoryIds: string[] } } }).data.product;
    expect(product.variants).toHaveLength(1); expect(product.variants[0]?.isDefault).toBe(true); expect(product.categoryIds).toEqual([category.id]);
    const updated = await request(server.baseUrl, `/api/businesses/${business.id}/products/${product.id}`, { method: "PATCH", cookie: cookies, body: JSON.stringify({ description: "Freshly roasted" }) });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { product: { description: string } } }).data.product.description).toBe("Freshly roasted");
    expect((await request(server.baseUrl, `/api/businesses/${business.id}/products/${product.id}`, { method: "DELETE", cookie: cookies })).status).toBe(200);
  });
  it("rejects invalid product contracts", async () => { const cookies = await actor("Invalid Catalog"); const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: "Invalid Catalog Market" }) }); const id = (businessResponse.body as { data: { business: { id: string } } }).data.business.id; expect((await request(server.baseUrl, `/api/businesses/${id}/products`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId: "not-a-uuid", name: "" }) })).status).toBe(400); });
  it("updates and archives a category", async () => {
    const cookies = await actor("Category Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: "Category Market" }) });
    const business = (businessResponse.body as { data: { business: { id: string } } }).data.business;
    const created = await request(server.baseUrl, `/api/businesses/${business.id}/categories`, { method: "POST", cookie: cookies, body: JSON.stringify({ name: "Snacks" }) });
    const category = (created.body as { data: { category: { id: string } } }).data.category;

    const updated = await request(server.baseUrl, `/api/businesses/${business.id}/categories/${category.id}`, { method: "PATCH", cookie: cookies, body: JSON.stringify({ name: "Salty Snacks", sortOrder: 3 }) });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { category: { name: string; sortOrder: number } } }).data.category).toMatchObject({ name: "Salty Snacks", sortOrder: 3 });

    expect((await request(server.baseUrl, `/api/businesses/${business.id}/categories/${category.id}`, { method: "PATCH", cookie: cookies, body: JSON.stringify({}) })).status).toBe(400);

    const archived = await request(server.baseUrl, `/api/businesses/${business.id}/categories/${category.id}`, { method: "DELETE", cookie: cookies });
    expect(archived.status).toBe(200);
    const remaining = await request(server.baseUrl, `/api/businesses/${business.id}/categories`, { cookie: cookies });
    expect((remaining.body as { data: { categories: { id: string }[] } }).data.categories.map((c) => c.id)).not.toContain(category.id);

    expect((await request(server.baseUrl, `/api/businesses/${business.id}/categories/${randomUUID()}`, { method: "PATCH", cookie: cookies, body: JSON.stringify({ name: "Ghost" }) })).status).toBe(404);
  });
});
