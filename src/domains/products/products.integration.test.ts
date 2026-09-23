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

describe("products/modifier groups", () => {
  it("requires authentication", async () => { expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/modifier-groups?storeId=${randomUUID()}`)).status).toBe(401); });

  it("runs a modifier group through creation, options, reordering, and product attachment", async () => {
    const cookies = await actor("Modifier Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: "Modifier Market" }) });
    const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const storeId = business.defaultStore.id;

    const created = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId, name: "Size", selectionMode: "single", minSelections: 1, kind: "modifier" }) });
    expect(created.status).toBe(201);
    const group = (created.body as { data: { group: { id: string; optionsCount: number; productCount: number } } }).data.group;
    expect(group).toMatchObject({ optionsCount: 0, productCount: 0 });

    const addon = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId, name: "Extras", kind: "addon" }) });
    const addonGroup = (addon.body as { data: { group: { id: string } } }).data.group;

    const smallOption = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}/options`, { method: "POST", cookie: cookies, body: JSON.stringify({ name: "Small" }) });
    expect(smallOption.status).toBe(201);
    const small = (smallOption.body as { data: { option: { id: string; sortOrder: number } } }).data.option;
    expect(small.sortOrder).toBe(0);
    const largeOption = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}/options`, { method: "POST", cookie: cookies, body: JSON.stringify({ name: "Large", priceAdjustmentMinor: 50000, isDefault: true }) });
    const large = (largeOption.body as { data: { option: { id: string; isDefault: boolean } } }).data.option;
    expect(large.isDefault).toBe(true);

    const list = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups?storeId=${storeId}`, { cookie: cookies });
    expect(list.status).toBe(200);
    const groups = (list.body as { data: { groups: { id: string; optionsCount: number }[] } }).data.groups;
    expect(groups.find((g) => g.id === group.id)?.optionsCount).toBe(2);

    const detail = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}`, { cookie: cookies });
    expect(detail.status).toBe(200);
    const detailGroup = (detail.body as { data: { group: { options: { id: string; name: string }[] } } }).data.group;
    expect(detailGroup.options.map((o) => o.name)).toEqual(["Small", "Large"]);

    const updated = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}`, { method: "PATCH", cookie: cookies, body: JSON.stringify({ description: "Pick a size", maxSelections: 1 }) });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { group: { description: string } } }).data.group.description).toBe("Pick a size");

    const reordered = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/reorder`, { method: "PUT", cookie: cookies, body: JSON.stringify({ storeId, orderedIds: [addonGroup.id, group.id] }) });
    expect(reordered.status).toBe(200);
    const reorderedList = (await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups?storeId=${storeId}`, { cookie: cookies })).body as { data: { groups: { id: string }[] } };
    expect(reorderedList.data.groups.map((g) => g.id)).toEqual([addonGroup.id, group.id]);

    const optionReorder = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}/options/reorder`, { method: "PUT", cookie: cookies, body: JSON.stringify({ orderedIds: [large.id, small.id] }) });
    expect(optionReorder.status).toBe(200);
    const reorderedDetail = (await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}`, { cookie: cookies })).body as { data: { group: { options: { id: string }[] } } };
    expect(reorderedDetail.data.group.options.map((o) => o.id)).toEqual([large.id, small.id]);

    const unavailable = await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}/options/${small.id}`, { method: "PATCH", cookie: cookies, body: JSON.stringify({ isAvailable: false }) });
    expect(unavailable.status).toBe(200);
    expect((unavailable.body as { data: { option: { isAvailable: boolean } } }).data.option.isAvailable).toBe(false);

    expect((await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}/options/${small.id}`, { method: "DELETE", cookie: cookies })).status).toBe(200);
    const afterOptionDelete = (await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}`, { cookie: cookies })).body as { data: { group: { options: { id: string }[]; optionsCount: number } } };
    expect(afterOptionDelete.data.group.options.map((o) => o.id)).toEqual([large.id]);
    expect(afterOptionDelete.data.group.optionsCount).toBe(1);

    const productResponse = await request(server.baseUrl, `/api/businesses/${business.id}/products`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId, name: "Latte" }) });
    const product = (productResponse.body as { data: { product: { id: string } } }).data.product;

    expect((await request(server.baseUrl, `/api/businesses/${business.id}/products/${product.id}/modifier-groups`, { method: "POST", cookie: cookies, body: JSON.stringify({ groupId: group.id }) })).status).toBe(201);
    const attached = (await request(server.baseUrl, `/api/businesses/${business.id}/products/${product.id}/modifier-groups`, { cookie: cookies })).body as { data: { groups: { id: string }[] } };
    expect(attached.data.groups.map((g) => g.id)).toEqual([group.id]);
    const groupAfterAttach = (await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}`, { cookie: cookies })).body as { data: { group: { productCount: number } } };
    expect(groupAfterAttach.data.group.productCount).toBe(1);

    expect((await request(server.baseUrl, `/api/businesses/${business.id}/products/${product.id}/modifier-groups/${group.id}`, { method: "DELETE", cookie: cookies })).status).toBe(200);
    const afterDetach = (await request(server.baseUrl, `/api/businesses/${business.id}/products/${product.id}/modifier-groups`, { cookie: cookies })).body as { data: { groups: { id: string }[] } };
    expect(afterDetach.data.groups).toHaveLength(0);

    expect((await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups/${group.id}`, { method: "DELETE", cookie: cookies })).status).toBe(200);
    const afterArchive = (await request(server.baseUrl, `/api/businesses/${business.id}/modifier-groups?storeId=${storeId}`, { cookie: cookies })).body as { data: { groups: { id: string }[] } };
    expect(afterArchive.data.groups.map((g) => g.id)).not.toContain(group.id);
  });
});
