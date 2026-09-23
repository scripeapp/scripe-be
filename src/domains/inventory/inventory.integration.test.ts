import { randomUUID } from "node:crypto";
let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({ emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} } }));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
const PASSWORD = "Sup3rSecret!pass"; let server: TestServer;
jest.setTimeout(30_000);
beforeAll(async () => { verificationMessages = []; server = await startTestServer(); }); afterAll(async () => server.close());
async function actor(label: string): Promise<string> { const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`; const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: PASSWORD }) }); const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } }; const code = verificationMessages.find((m) => m.to === email)?.code; if (signup.status !== 200 || !(body.user?.id ?? body.data?.user?.id) || !code) throw new Error("Unable to authenticate inventory actor"); const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) }); return verified.cookies; }
describe("inventory domain", () => {
  it("requires authentication", async () => { expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/inventory/balances`)).status).toBe(401); });
  it("posts immutable stock and reserves/releases available quantity", async () => {
    const cookie = await actor("Inventory Owner"); const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Inventory Market" }) }); const business = (b.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business; const locationResponse = await request(server.baseUrl, `/api/businesses/${business.id}/stores/${business.defaultStore.id}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "Main Stockroom", kind: "stockroom", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) }); expect(locationResponse.status).toBe(201); const location = (locationResponse.body as { data: { location: { id: string } } }).data.location;
    const base = `/api/businesses/${business.id}/inventory`; const itemResponse = await request(server.baseUrl, `${base}/items`, { method: "POST", cookie, body: JSON.stringify({ name: "Coffee Beans", sku: `BEANS-${randomUUID()}` }) }); expect(itemResponse.status).toBe(201); const item = (itemResponse.body as { data: { item: { id: string } } }).data.item; const locationRow = await request(server.baseUrl, `${base}/locations`, { method: "POST", cookie, body: JSON.stringify({ locationId: location.id, name: "Shelf A" }) }); expect(locationRow.status).toBe(201); const inventoryLocation = (locationRow.body as { data: { location: { id: string } } }).data.location;
    const movement = await request(server.baseUrl, `${base}/movements`, { method: "POST", cookie, body: JSON.stringify({ inventoryItemId: item.id, inventoryLocationId: inventoryLocation.id, quantity: 10, type: "receipt", reason: "Initial receipt", idempotencyKey: randomUUID() }) }); expect(movement.status).toBe(201); const reservation = await request(server.baseUrl, `${base}/reservations`, { method: "POST", cookie, body: JSON.stringify({ inventoryItemId: item.id, inventoryLocationId: inventoryLocation.id, quantity: 3, referenceType: "checkout", referenceId: randomUUID() }) }); expect(reservation.status).toBe(201); const reservationId = (reservation.body as { data: { reservation: { id: string } } }).data.reservation.id; const balances = await request(server.baseUrl, `${base}/balances?inventoryItemId=${item.id}`, { cookie }); expect(balances.status).toBe(200); expect((balances.body as { data: { balances: { available: string }[] } }).data.balances[0]?.available).toBe("7.000000"); expect((await request(server.baseUrl, `${base}/reservations/${reservationId}/release`, { method: "POST", cookie })).status).toBe(200);

    const items = await request(server.baseUrl, `${base}/items`, { cookie });
    expect(items.status).toBe(200);
    expect((items.body as { data: { items: { id: string }[] } }).data.items.map((i) => i.id)).toContain(item.id);

    const itemDetail = await request(server.baseUrl, `${base}/items/${item.id}`, { cookie });
    expect(itemDetail.status).toBe(200);
    expect((itemDetail.body as { data: { item: { name: string } } }).data.item.name).toBe("Coffee Beans");
    expect((await request(server.baseUrl, `${base}/items/${randomUUID()}`, { cookie })).status).toBe(404);

    const locations = await request(server.baseUrl, `${base}/locations`, { cookie });
    expect(locations.status).toBe(200);
    expect((locations.body as { data: { locations: { id: string }[] } }).data.locations.map((l) => l.id)).toContain(inventoryLocation.id);

    const movements = await request(server.baseUrl, `${base}/movements?inventoryItemId=${item.id}`, { cookie });
    expect(movements.status).toBe(200);
    const movementRows = (movements.body as { data: { movements: { type: string; reason: string }[] } }).data.movements;
    expect(movementRows.length).toBeGreaterThan(0);
    expect(movementRows[0]).toMatchObject({ type: "receipt", reason: "Initial receipt" });
  });
});
