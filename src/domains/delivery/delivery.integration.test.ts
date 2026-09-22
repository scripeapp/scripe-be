import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendBusinessInvitation: () => {},
    sendTransactional: () => Promise.resolve(),
  },
}));

import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

let server: TestServer;
let migratorPool: Pool;
const SHIPBUBBLE_WEBHOOK_SECRET = "test-shipbubble-webhook-secret";

beforeAll(async () => {
  server = await startTestServer();
  const environment = loadEnvironment();
  migratorPool = new Pool({ connectionString: environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL });
});
afterAll(async () => {
  await migratorPool.end();
  await server.close();
});

async function authenticate(label: string): Promise<{ cookies: string; userId: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = (body.user?.id ?? body.data?.user?.id)!;
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { cookies: verified.cookies, userId };
}

async function setupBusiness(owner: { cookies: string }, name: string) {
  const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: name }) });
  const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  const base = `/api/businesses/${business.id}`;

  const locationResponse = await request(server.baseUrl, `${base}/stores/${business.defaultStore.id}/locations`, {
    method: "POST",
    cookie: owner.cookies,
    body: JSON.stringify({ name: `${name} Branch`, kind: "branch", addressLine1: "1 Admiralty Way", city: "Lagos", state: "Lagos", phone: "08011111111" }),
  });
  const location = (locationResponse.body as { data: { location: { id: string } } }).data.location;

  return { businessId: business.id, storeId: business.defaultStore.id, locationId: location.id, base };
}

async function createOrderDirectly(businessId: string, storeId: string): Promise<string> {
  const channel = await migratorPool.query<{ id: string }>(
    `insert into app.sales_channels ("businessId","storeId","code","name","kind") values ($1,$2,$3,'Online','storefront') returning id`,
    [businessId, storeId, `online_${randomUUID().replace(/-/g, "").slice(0, 8)}`],
  );
  const order = await migratorPool.query<{ id: string }>(
    `insert into app.orders ("businessId","orderNumber","storeId","channelId","currency","subtotalMinor","totalMinor") values ($1,$2,$3,$4,'NGN',100000,100000) returning id`,
    [businessId, `ORD-${randomUUID().slice(0, 8)}`, storeId, channel.rows[0]!.id],
  );
  return order.rows[0]!.id;
}

function shipbubbleSignature(rawBody: string): string {
  return createHmac("sha512", SHIPBUBBLE_WEBHOOK_SECRET).update(rawBody).digest("hex");
}

describe("delivery domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/delivery/methods`)).status).toBe(401);
  });

  it("rejects a non-member of the business", async () => {
    const owner = await authenticate("Delivery Owner Guard");
    const outsider = await authenticate("Delivery Outsider");
    const { base } = await setupBusiness(owner, "Guarded Delivery Co");
    expect((await request(server.baseUrl, `${base}/delivery/methods`, { cookie: outsider.cookies })).status).toBe(403);
  });

  it("manages flat-rate delivery methods including reorder and deactivation", async () => {
    const owner = await authenticate("Method Owner");
    const { base, storeId } = await setupBusiness(owner, "Method Test Co");

    const standard = await request(server.baseUrl, `${base}/delivery/methods`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ storeId, name: "Standard", priceMinor: 150000, estimatedTime: "2-3 days" }),
    });
    expect(standard.status).toBe(201);
    const standardMethod = (standard.body as { data: { method: { id: string; sortOrder: number } } }).data.method;
    expect(standardMethod.sortOrder).toBe(0);

    const express = await request(server.baseUrl, `${base}/delivery/methods`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ storeId, name: "Express", priceMinor: 500000 }),
    });
    const expressMethod = (express.body as { data: { method: { id: string; sortOrder: number } } }).data.method;
    expect(expressMethod.sortOrder).toBe(1);

    const reordered = await request(server.baseUrl, `${base}/delivery/methods/reorder`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ storeId, order: [expressMethod.id, standardMethod.id] }),
    });
    expect(reordered.status).toBe(200);

    const listed = await request(server.baseUrl, `${base}/delivery/methods?storeId=${storeId}`, { cookie: owner.cookies });
    const methods = (listed.body as { data: { methods: { id: string; sortOrder: number }[] } }).data.methods;
    expect(methods.find((m) => m.id === expressMethod.id)?.sortOrder).toBe(0);
    expect(methods.find((m) => m.id === standardMethod.id)?.sortOrder).toBe(1);

    const deactivated = await request(server.baseUrl, `${base}/delivery/methods/${standardMethod.id}`, { method: "DELETE", cookie: owner.cookies });
    expect(deactivated.status).toBe(200);
    const afterDeactivate = await request(server.baseUrl, `${base}/delivery/methods?storeId=${storeId}`, { cookie: owner.cookies });
    const activeIds = (afterDeactivate.body as { data: { methods: { id: string; isActive: boolean }[] } }).data.methods.filter((m) => m.isActive).map((m) => m.id);
    expect(activeIds).not.toContain(standardMethod.id);
  });

  it("manages delivery zones and matches by exact zip code", async () => {
    const owner = await authenticate("Zone Owner");
    const { base, storeId, locationId } = await setupBusiness(owner, "Zone Test Co");

    const zone = await request(server.baseUrl, `${base}/delivery/zones`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ storeId, locationId, zipCode: "100001", feeMinor: 200000, minOrderMinor: 500000, estimatedMinutes: 45 }),
    });
    expect(zone.status).toBe(201);

    const matched = await request(server.baseUrl, `${base}/delivery/zones/match?storeId=${storeId}&locationId=${locationId}&zipCode=100001`, { cookie: owner.cookies });
    expect(matched.status).toBe(200);
    expect((matched.body as { data: { match: { feeMinor: string } | null } }).data.match?.feeMinor).toBe("200000");

    const unmatched = await request(server.baseUrl, `${base}/delivery/zones/match?storeId=${storeId}&locationId=${locationId}&zipCode=999999`, { cookie: owner.cookies });
    expect((unmatched.body as { data: { match: unknown } }).data.match).toBeNull();
  });

  it("toggles carrier delivery for a store", async () => {
    const owner = await authenticate("Carrier Toggle Owner");
    const { base, storeId } = await setupBusiness(owner, "Carrier Toggle Co");
    const toggled = await request(server.baseUrl, `${base}/delivery/carrier-toggle`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ storeId, enabled: true }) });
    expect(toggled.status).toBe(200);
  });

  it("fetches carrier rates and books a shipment against a mocked Shipbubble API, using the store's default location as sender", async () => {
    const owner = await authenticate("Shipment Owner");
    const { base, businessId, storeId } = await setupBusiness(owner, "Shipment Test Co");
    const orderId = await createOrderDirectly(businessId, storeId);

    const previousApiKey = process.env.SHIPBUBBLE_API_KEY;
    process.env.SHIPBUBBLE_API_KEY = "test-shipbubble-key";
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((url) => {
      const path = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (path.includes("/shipping/address/validate")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "success", data: { address_code: 12345, formatted_address: "Validated Address" } }) } as Response);
      }
      if (path.includes("/shipping/fetch_rates")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "success",
              data: { request_token: "token-123", couriers: [{ courier_id: "c1", courier_name: "GIG Logistics", service_code: "sc1", service_type: "pickup", total: 2000, currency: "NGN", delivery_eta: "2 days" }] },
            }),
        } as Response);
      }
      if (path.includes("/shipping/labels/list")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "success", data: { results: [{ status: "in_transit", courier: { tracking_code: "TRK-1" }, tracking_url: "https://track.example.com/TRK-1", events: [{ location: "Lagos", message: "Picked up", captured: "2026-01-01T00:00:00Z" }] }] } }),
        } as Response);
      }
      if (path.includes("/shipping/labels")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: "success", data: { order_id: "SB-ORDER-1", courier: { name: "GIG Logistics" }, tracking_url: "https://track.example.com/SB-ORDER-1", status: "confirmed", payment: { shipping_fee: 2200, currency: "NGN" } } }) } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch to ${path}`));
    });

    const rates = await request(server.baseUrl, `${base}/delivery/rates`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ storeId, name: "Jane Customer", phone: "08022222222", addressLine1: "5 Bourdillon Road", city: "Lagos", state: "Lagos", parcels: [{ quantity: 1, weight: 1.5 }] }),
    });
    expect(rates.status).toBe(200);
    const rate = (rates.body as { data: { rates: { serviceCode: string; courierId: string; priceMinor: number }[] } }).data.rates[0]!;
    expect(rate.priceMinor).toBeGreaterThan(0);

    const shipment = await request(server.baseUrl, `${base}/delivery/shipments`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        orderId,
        storeId,
        destination: { name: "Jane Customer", phone: "08022222222", addressLine1: "5 Bourdillon Road", city: "Lagos", state: "Lagos" },
        parcels: [{ quantity: 1, weight: 1.5 }],
        serviceCode: rate.serviceCode,
        courierId: rate.courierId,
        rate: { provider: "shipbubble", serviceName: "GIG Logistics", serviceCode: rate.serviceCode, courierId: rate.courierId, priceMinor: rate.priceMinor, currency: "NGN", estimatedTime: "2 days" },
      }),
    });
    expect(shipment.status).toBe(201);
    const delivery = (shipment.body as { data: { delivery: { id: string; status: string; trackingCode: string | null } } }).data.delivery;
    expect(delivery.status).toBe("booked");
    expect(delivery.trackingCode).toBe("SB-ORDER-1");

    const forOrder = await request(server.baseUrl, `${base}/delivery/shipments?orderId=${orderId}`, { cookie: owner.cookies });
    expect((forOrder.body as { data: { deliveries: { id: string }[] } }).data.deliveries.map((d) => d.id)).toContain(delivery.id);

    const refreshed = await request(server.baseUrl, `${base}/delivery/shipments/${delivery.id}/refresh-tracking`, { method: "POST", cookie: owner.cookies });
    expect(refreshed.status).toBe(200);
    expect((refreshed.body as { data: { delivery: { status: string } } }).data.delivery.status).toBe("in_transit");

    fetchSpy.mockRestore();
    process.env.SHIPBUBBLE_API_KEY = previousApiKey;
  });

  it("rejects a shipment request when the store has no default location address configured", async () => {
    const owner = await authenticate("No Address Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: "No Address Co" }) });
    const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const base = `/api/businesses/${business.id}`;
    const orderId = await createOrderDirectly(business.id, business.defaultStore.id);

    const rates = await request(server.baseUrl, `${base}/delivery/rates`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ storeId: business.defaultStore.id, name: "Jane Customer", phone: "08022222222", addressLine1: "5 Bourdillon Road", city: "Lagos", state: "Lagos", parcels: [{ quantity: 1, weight: 1.5 }] }),
    });
    expect(rates.status).toBe(400);
    void orderId;
  });

  it("reconciles a delivery's status through the Shipbubble webhook, signature-verified", async () => {
    const owner = await authenticate("Webhook Owner");
    const { businessId, storeId, base } = await setupBusiness(owner, "Webhook Test Co");
    const orderId = await createOrderDirectly(businessId, storeId);

    const trackingCode = `SB-WEBHOOK-${randomUUID()}`;
    const created = await migratorPool.query<{ id: string }>(
      `insert into app.deliveries ("businessId","orderId","storeId","provider","destination","trackingCode","createdBy") values ($1,$2,$3,'shipbubble','{}'::jsonb,$4,$5) returning id`,
      [businessId, orderId, storeId, trackingCode, owner.userId],
    );
    const deliveryId = created.rows[0]!.id;

    const previousSecret = process.env.SHIPBUBBLE_WEBHOOK_SECRET;
    process.env.SHIPBUBBLE_WEBHOOK_SECRET = SHIPBUBBLE_WEBHOOK_SECRET;

    const rawBody = JSON.stringify({ event: "shipment.status.changed", order_id: trackingCode, status: "completed", courier: { name: "GIG Logistics" } });
    const webhookResponse = await request(server.baseUrl, "/api/webhooks/shipbubble", {
      method: "POST",
      body: rawBody,
      headers: { "x-ship-signature": shipbubbleSignature(rawBody) },
    });
    expect(webhookResponse.status).toBe(200);

    process.env.SHIPBUBBLE_WEBHOOK_SECRET = previousSecret;

    const delivery = await request(server.baseUrl, `${base}/delivery/shipments?orderId=${orderId}`, { cookie: owner.cookies });
    const updated = (delivery.body as { data: { deliveries: { id: string; status: string }[] } }).data.deliveries.find((d) => d.id === deliveryId);
    expect(updated?.status).toBe("delivered");
  });
});
