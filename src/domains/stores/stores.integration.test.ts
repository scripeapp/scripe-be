import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];

jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) =>
      verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
}));

import { sql } from "kysely";
import { getDatabase } from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { withIdentity } from "@/db/principal.js";
import {
  request,
  startTestServer,
  type HttpResponse,
  type TestServer,
} from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;

jest.setTimeout(30_000);

beforeAll(async () => {
  verificationMessages = [];
  server = await startTestServer();
});

afterAll(async () => server.close());

interface Actor {
  readonly cookies: string;
  readonly userId: string;
}

interface CreatedBusiness {
  readonly id: string;
  readonly defaultStore: { readonly id: string };
}

async function authenticate(label: string): Promise<Actor> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: PASSWORD }),
  });
  const signupBody = signup.body as {
    user?: { id: string };
    data?: { user?: { id: string } };
  };
  const userId = signupBody.user?.id ?? signupBody.data?.user?.id;
  const code = verificationMessages.find((message) => message.to === email)?.code;
  if (signup.status !== 200 || !userId || !code) {
    throw new Error(`Could not authenticate test actor: ${JSON.stringify(signup.body)}`);
  }
  const verified = await request(
    server.baseUrl,
    "/api/auth/email-otp/verify-email",
    {
      method: "POST",
      body: JSON.stringify({ email, otp: code }),
    },
  );
  return { cookies: verified.cookies, userId };
}

async function createBusiness(actor: Actor, name: string): Promise<CreatedBusiness> {
  const response = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: actor.cookies,
    body: JSON.stringify({ displayName: name }),
  });
  expect(response.status).toBe(201);
  return (response.body as { data: { business: CreatedBusiness } }).data.business;
}

function entity<T>(response: HttpResponse, key: string): T {
  return (response.body as { data: Record<string, T> }).data[key]!;
}

describe("stores domain", () => {
  it("requires authentication", async () => {
    const response = await request(
      server.baseUrl,
      `/api/businesses/${randomUUID()}/stores`,
    );
    expect(response.status).toBe(401);
  });

  it("manages stores, locations, channels, registers, shifts, and idempotent cash movements", async () => {
    const owner = await authenticate("Store Owner");
    const business = await createBusiness(owner, "Marina Market");
    const base = `/api/businesses/${business.id}/stores`;

    const secondStoreResponse = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        name: "Marina Annex",
        slug: `marina-annex-${randomUUID().slice(0, 8)}`,
        isDefault: true,
        sellsInPerson: true,
      }),
    });
    expect(secondStoreResponse.status).toBe(201);
    const secondStore = entity<{ id: string; isDefault: boolean }>(
      secondStoreResponse,
      "store",
    );
    expect(secondStore.isDefault).toBe(true);

    const unsetDefault = await request(
      server.baseUrl,
      `${base}/${secondStore.id}`,
      {
        method: "PATCH",
        cookie: owner.cookies,
        body: JSON.stringify({ isDefault: false }),
      },
    );
    expect(unsetDefault.status).toBe(409);

    const archived = await request(
      server.baseUrl,
      `${base}/${secondStore.id}`,
      { method: "DELETE", cookie: owner.cookies },
    );
    expect(archived.status).toBe(200);
    const stores = await request(server.baseUrl, base, { cookie: owner.cookies });
    expect(
      entity<{ id: string; isDefault: boolean }[]>(stores, "stores"),
    ).toEqual([
      expect.objectContaining({ id: business.defaultStore.id, isDefault: true }),
    ]);

    const locationResponse = await request(
      server.baseUrl,
      `${base}/${business.defaultStore.id}/locations`,
      {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({
          name: "Lekki Branch",
          kind: "branch",
          addressLine1: "1 Admiralty Way",
          city: "Lagos",
          state: "Lagos",
          operationTypes: ["dine_in", "pickup"],
          taxRate: 7.5,
          serviceChargeRates: { dine_in: 10 },
          manager: "Chidi Okafor",
          format: "fast-casual",
        }),
      },
    );
    expect(locationResponse.status).toBe(201);
    const location = entity<{
      id: string;
      isDefault: boolean;
      operationTypes: string[];
      acceptingOrders: boolean;
      taxRate: string;
      serviceChargeRates: Record<string, number>;
      manager: string | null;
      format: string | null;
    }>(locationResponse, "location");
    expect(location.isDefault).toBe(true);
    expect(location).toMatchObject({
      operationTypes: ["dine_in", "pickup"],
      acceptingOrders: true,
      taxRate: "7.50",
      serviceChargeRates: { dine_in: 10 },
      manager: "Chidi Okafor",
      format: "fast-casual",
    });

    const locationUpdate = await request(
      server.baseUrl,
      `${base}/${business.defaultStore.id}/locations/${location.id}`,
      {
        method: "PATCH",
        cookie: owner.cookies,
        body: JSON.stringify({ acceptingOrders: false }),
      },
    );
    expect(locationUpdate.status).toBe(200);
    const updatedLocation = entity<{ acceptingOrders: boolean; manager: string | null; taxRate: string }>(
      locationUpdate,
      "location",
    );
    expect(updatedLocation.acceptingOrders).toBe(false);
    // Fields not sent in the PATCH stay untouched.
    expect(updatedLocation.manager).toBe("Chidi Okafor");
    expect(updatedLocation.taxRate).toBe("7.50");

    const channelResponse = await request(
      server.baseUrl,
      `${base}/${business.defaultStore.id}/channels`,
      {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({ code: "pos", name: "Point of Sale", kind: "pos" }),
      },
    );
    expect(channelResponse.status).toBe(201);

    const registerResponse = await request(
      server.baseUrl,
      `${base}/${business.defaultStore.id}/registers`,
      {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({ locationId: location.id, name: "Front Till" }),
      },
    );
    expect(registerResponse.status).toBe(201);
    const register = entity<{ id: string }>(registerResponse, "register");

    const shiftPath = `${base}/${business.defaultStore.id}/registers/${register.id}/shifts`;
    const [firstOpen, racingOpen] = await Promise.all([
      request(server.baseUrl, shiftPath, {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({ openingCashMinor: "10000" }),
      }),
      request(server.baseUrl, shiftPath, {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({ openingCashMinor: "10000" }),
      }),
    ]);
    expect([firstOpen.status, racingOpen.status].sort()).toEqual([201, 409]);
    const opened = [firstOpen, racingOpen].find((response) => response.status === 201)!;
    const shift = entity<{ id: string; openingCashMinor: string }>(opened, "shift");
    expect(shift.openingCashMinor).toBe("10000");

    const cashPath = `${base}/${business.defaultStore.id}/shifts/${shift.id}/cash-movements`;
    const movementInput = {
      type: "cash_out",
      amountMinor: "1000",
      reason: "Petty cash",
      idempotencyKey: randomUUID(),
    };
    const movement = await request(server.baseUrl, cashPath, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify(movementInput),
    });
    const replay = await request(server.baseUrl, cashPath, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify(movementInput),
    });
    expect([movement.status, replay.status]).toEqual([201, 201]);
    expect(entity<{ id: string }>(replay, "cashMovement").id).toBe(
      entity<{ id: string }>(movement, "cashMovement").id,
    );

    const conflictingReplay = await request(server.baseUrl, cashPath, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ ...movementInput, amountMinor: "2000" }),
    });
    expect(conflictingReplay.status).toBe(409);

    const closed = await request(
      server.baseUrl,
      `${base}/${business.defaultStore.id}/shifts/${shift.id}/close`,
      {
        method: "PATCH",
        cookie: owner.cookies,
        body: JSON.stringify({ countedCashMinor: "9000" }),
      },
    );
    expect(closed.status).toBe(200);
    expect(
      entity<{
        expectedCashMinor: string;
        countedCashMinor: string;
        varianceMinor: string;
      }>(closed, "shift"),
    ).toMatchObject({
      expectedCashMinor: "9000",
      countedCashMinor: "9000",
      varianceMinor: "0",
    });

    const archivedLocation = await request(
      server.baseUrl,
      `${base}/${business.defaultStore.id}/locations/${location.id}`,
      { method: "DELETE", cookie: owner.cookies },
    );
    expect(archivedLocation.status).toBe(200);
  });

  it("blocks cross-tenant HTTP and RLS access", async () => {
    const owner = await authenticate("Tenant Owner");
    const outsider = await authenticate("Tenant Outsider");
    const business = await createBusiness(owner, "Tenant Safe Store");

    const forbidden = await request(
      server.baseUrl,
      `/api/businesses/${business.id}/stores`,
      { cookie: outsider.cookies },
    );
    expect(forbidden.status).toBe(403);

    const result = await withDatabaseContext(
      getDatabase(),
      withIdentity(randomUUID(), outsider.userId, business.id),
      ({ transaction }) =>
        sql<{ id: string }>`
          select "id" from app.stores where "businessId"=${business.id}::uuid
        `.execute(transaction),
    );
    expect(result.rows).toEqual([]);
  });

  describe("public storefront browsing", () => {
    async function activateDefaultStore(
      owner: Actor,
      business: CreatedBusiness,
      slug: string,
    ): Promise<void> {
      const response = await request(
        server.baseUrl,
        `/api/businesses/${business.id}/stores/${business.defaultStore.id}`,
        {
          method: "PATCH",
          cookie: owner.cookies,
          body: JSON.stringify({ status: "active", slug }),
        },
      );
      expect(response.status).toBe(200);
    }

    it("404s for a draft store, a nonexistent slug, and rejects malformed product ids", async () => {
      const owner = await authenticate("Draft Owner");
      const business = await createBusiness(owner, "Still Drafting");
      const slug = `draft-store-${randomUUID().slice(0, 8)}`;
      await request(
        server.baseUrl,
        `/api/businesses/${business.id}/stores/${business.defaultStore.id}`,
        { method: "PATCH", cookie: owner.cookies, body: JSON.stringify({ slug }) },
      );

      const draftLookup = await request(server.baseUrl, `/api/store/public/${slug}`);
      expect(draftLookup.status).toBe(404);

      const missingLookup = await request(server.baseUrl, `/api/store/public/${randomUUID()}`);
      expect(missingLookup.status).toBe(404);

      const badIds = await request(server.baseUrl, `/api/store/public/products?ids=not-a-uuid`);
      expect(badIds.status).toBe(400);
    });

    it("serves an active store's public profile, products (with resolved price), and categories, anonymously", async () => {
      const owner = await authenticate("Public Store Owner");
      const business = await createBusiness(owner, "Lagos Corner Shop");
      const slug = `corner-shop-${randomUUID().slice(0, 8)}`;
      await activateDefaultStore(owner, business, slug);

      const category = entity<{ id: string }>(
        await request(server.baseUrl, `/api/businesses/${business.id}/categories`, {
          method: "POST",
          cookie: owner.cookies,
          body: JSON.stringify({ name: "Drinks" }),
        }),
        "category",
      );

      const activeProduct = entity<{ id: string; slug?: string; variants: { id: string; isDefault: boolean }[] }>(
        await request(server.baseUrl, `/api/businesses/${business.id}/products`, {
          method: "POST",
          cookie: owner.cookies,
          body: JSON.stringify({
            storeId: business.defaultStore.id,
            name: "Chilled Zobo",
            status: "active",
            categoryIds: [category.id],
          }),
        }),
        "product",
      );
      const defaultVariant = activeProduct.variants.find((v) => v.isDefault)!;

      await request(server.baseUrl, `/api/businesses/${business.id}/prices`, {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({
          productVariantId: defaultVariant.id,
          assetCode: "NGN",
          amountMinor: 150000,
          compareAtMinor: 200000,
        }),
      });

      // A draft product in the same active store must stay invisible.
      await request(server.baseUrl, `/api/businesses/${business.id}/products`, {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({ storeId: business.defaultStore.id, name: "Unreleased Snack" }),
      });

      const storeLookup = await request(server.baseUrl, `/api/store/public/${slug}`);
      expect(storeLookup.status).toBe(200);
      const publicStore = entity<{ id: string; name: string; slug: string; status?: string }>(
        storeLookup,
        "store",
      );
      expect(publicStore.id).toBe(business.defaultStore.id);
      expect(publicStore.name).toBe("Lagos Corner Shop");
      expect(publicStore.status).toBeUndefined(); // internal field, not part of the public DTO

      const productsResponse = await request(server.baseUrl, `/api/store/public/${slug}/products`);
      expect(productsResponse.status).toBe(200);
      const products = entity<
        { id: string; name: string; variants: { priceMinor: string | null; compareAtMinor: string | null; assetCode: string | null }[] }[]
      >(productsResponse, "products");
      expect(products).toHaveLength(1); // the draft product is excluded
      expect(products[0]!.id).toBe(activeProduct.id);
      expect(products[0]!.variants[0]).toMatchObject({
        priceMinor: "150000",
        compareAtMinor: "200000",
        assetCode: "NGN",
      });

      const categoriesResponse = await request(server.baseUrl, `/api/store/public/${slug}/categories`);
      expect(categoriesResponse.status).toBe(200);
      expect(entity<{ id: string }[]>(categoriesResponse, "categories")).toEqual([
        expect.objectContaining({ id: category.id }),
      ]);

      const byIds = await request(
        server.baseUrl,
        `/api/store/public/products?ids=${activeProduct.id}`,
      );
      expect(byIds.status).toBe(200);
      expect(entity<{ id: string }[]>(byIds, "products")).toEqual([
        expect.objectContaining({ id: activeProduct.id }),
      ]);

      // Single product lookup by ID
      const byProductId = await request(
        server.baseUrl,
        `/api/store/public/${slug}/product/${activeProduct.id}`,
      );
      expect(byProductId.status).toBe(200);
      expect(entity<{ id: string }>(byProductId, "product").id).toBe(activeProduct.id);

      // Single product lookup by slug
      const byProductSlug = await request(
        server.baseUrl,
        `/api/store/public/${slug}/product/${activeProduct.slug || activeProduct.id}`,
      );
      expect(byProductSlug.status).toBe(200);
      expect(entity<{ id: string }>(byProductSlug, "product").id).toBe(activeProduct.id);

      // Branches lookup
      const branchesRes = await request(server.baseUrl, `/api/store/public/${slug}/branches`);
      expect(branchesRes.status).toBe(200);

      // Manifest lookup
      const manifestRes = await request(server.baseUrl, `/api/store/public/${slug}/manifest.json`);
      expect(manifestRes.status).toBe(200);
      expect((manifestRes.body as any).data.name).toBe("Lagos Corner Shop");

      // Business-scoped public store alias
      const businessPublicStore = await request(server.baseUrl, `/api/businesses/${business.id}/public/stores/${slug}`);
      expect(businessPublicStore.status).toBe(200);
      expect(entity<{ id: string }>(businessPublicStore, "store").id).toBe(business.defaultStore.id);
    });

    it("never exposes another business's rows through the public endpoints, even to an authenticated outsider", async () => {
      const owner = await authenticate("Private Store Owner");
      const business = await createBusiness(owner, "Members Only");
      const outsider = await authenticate("Curious Outsider");

      // Store stays in "draft" — never activated.
      const slug = `members-only-${randomUUID().slice(0, 8)}`;
      await request(
        server.baseUrl,
        `/api/businesses/${business.id}/stores/${business.defaultStore.id}`,
        { method: "PATCH", cookie: owner.cookies, body: JSON.stringify({ slug }) },
      );

      const asOutsider = await request(server.baseUrl, `/api/store/public/${slug}`, {
        cookie: outsider.cookies,
      });
      expect(asOutsider.status).toBe(404);
    });
  });
});
