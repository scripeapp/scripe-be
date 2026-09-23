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

  it("provisions an inventory item automatically for a trackable product variant", async () => {
    const cookie = await actor("Autoprovision Owner");
    const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Autoprovision Market" }) });
    const business = (b.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const productResponse = await request(server.baseUrl, `/api/businesses/${business.id}/products`, { method: "POST", cookie, body: JSON.stringify({ storeId: business.defaultStore.id, name: "Roasted Coffee", trackInventory: true }) });
    expect(productResponse.status).toBe(201);
    const product = (productResponse.body as { data: { product: { variants: { id: string; name: string }[] } } }).data.product;
    const variantId = product.variants[0]!.id;

    const items = await request(server.baseUrl, `/api/businesses/${business.id}/inventory/items`, { cookie });
    expect(items.status).toBe(200);
    const provisioned = (items.body as { data: { items: { variantId: string | null }[] } }).data.items.find((i) => i.variantId === variantId);
    expect(provisioned).toBeTruthy();
  });

  it("runs a stock transfer through draft, sent, and received", async () => {
    const cookie = await actor("Transfer Owner");
    const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Transfer Market" }) });
    const business = (b.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const storesBase = `/api/businesses/${business.id}/stores/${business.defaultStore.id}`;
    const locA = await request(server.baseUrl, `${storesBase}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "Warehouse A", kind: "warehouse", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) });
    const locB = await request(server.baseUrl, `${storesBase}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "Warehouse B", kind: "warehouse", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) });
    const fromLocationId = (locA.body as { data: { location: { id: string } } }).data.location.id;
    const toLocationId = (locB.body as { data: { location: { id: string } } }).data.location.id;

    const base = `/api/businesses/${business.id}/inventory`;
    const itemResponse = await request(server.baseUrl, `${base}/items`, { method: "POST", cookie, body: JSON.stringify({ name: "Sugar 1kg", sku: `SUGAR-${randomUUID()}` }) });
    const item = (itemResponse.body as { data: { item: { id: string } } }).data.item;
    const fromInvLoc = await request(server.baseUrl, `${base}/locations`, { method: "POST", cookie, body: JSON.stringify({ locationId: fromLocationId, name: "Warehouse A" }) });
    const fromInventoryLocationId = (fromInvLoc.body as { data: { location: { id: string } } }).data.location.id;
    await request(server.baseUrl, `${base}/movements`, { method: "POST", cookie, body: JSON.stringify({ inventoryItemId: item.id, inventoryLocationId: fromInventoryLocationId, quantity: 20, type: "receipt", reason: "Initial stock", idempotencyKey: randomUUID() }) });

    const reference = `TRF-${randomUUID().slice(0, 8)}`;
    const created = await request(server.baseUrl, `${base}/transfers`, { method: "POST", cookie, body: JSON.stringify({ reference, fromLocationId, toLocationId, lines: [{ inventoryItemId: item.id, quantity: 5, unitCostMinor: 200 }] }) });
    expect(created.status).toBe(201);
    const transfer = (created.body as { data: { transfer: { id: string; status: string } } }).data.transfer;
    expect(transfer.status).toBe("draft");

    const transferList = await request(server.baseUrl, `${base}/transfers`, { cookie });
    expect(transferList.status).toBe(200);
    const listedTransfer = (transferList.body as { data: { transfers: { id: string; itemCount: number; totalValueMinor: string }[] } }).data.transfers.find((t) => t.id === transfer.id);
    expect(listedTransfer).toMatchObject({ itemCount: 1, totalValueMinor: "1000.000000" });

    expect((await request(server.baseUrl, `${base}/transfers/${transfer.id}/receive`, { method: "POST", cookie, body: JSON.stringify({ lines: [] }) })).status).toBe(400);

    const sent = await request(server.baseUrl, `${base}/transfers/${transfer.id}/send`, { method: "POST", cookie });
    expect(sent.status).toBe(200);
    expect((sent.body as { data: { transfer: { status: string } } }).data.transfer.status).toBe("sent");

    const balanceAfterSend = await request(server.baseUrl, `${base}/balances?inventoryItemId=${item.id}&inventoryLocationId=${fromInventoryLocationId}`, { cookie });
    expect((balanceAfterSend.body as { data: { balances: { onHand: string }[] } }).data.balances[0]?.onHand).toBe("15.000000");

    const detail = await request(server.baseUrl, `${base}/transfers/${transfer.id}`, { cookie });
    const lineId = (detail.body as { data: { transfer: { lines: { id: string }[] } } }).data.transfer.lines[0]!.id;

    const received = await request(server.baseUrl, `${base}/transfers/${transfer.id}/receive`, { method: "POST", cookie, body: JSON.stringify({ lines: [{ lineId, quantityReceived: 4 }] }) });
    expect(received.status).toBe(200);
    expect((received.body as { data: { transfer: { status: string } } }).data.transfer.status).toBe("received");

    const toInvLocLookup = await request(server.baseUrl, `${base}/locations`, { cookie });
    const toInventoryLocationId = (toInvLocLookup.body as { data: { locations: { id: string; locationId: string }[] } }).data.locations.find((l) => l.locationId === toLocationId)!.id;
    const balanceAtDestination = await request(server.baseUrl, `${base}/balances?inventoryItemId=${item.id}&inventoryLocationId=${toInventoryLocationId}`, { cookie });
    expect((balanceAtDestination.body as { data: { balances: { onHand: string }[] } }).data.balances[0]?.onHand).toBe("4.000000");

    expect((await request(server.baseUrl, `${base}/transfers/${transfer.id}/send`, { method: "POST", cookie })).status).toBe(400);
  });

  it("cancels a draft transfer without moving stock", async () => {
    const cookie = await actor("Transfer Cancel Owner");
    const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Transfer Cancel Market" }) });
    const business = (b.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const storesBase = `/api/businesses/${business.id}/stores/${business.defaultStore.id}`;
    const locA = await request(server.baseUrl, `${storesBase}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "A", kind: "warehouse", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) });
    const locB = await request(server.baseUrl, `${storesBase}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "B", kind: "warehouse", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) });
    const base = `/api/businesses/${business.id}/inventory`;
    const itemResponse = await request(server.baseUrl, `${base}/items`, { method: "POST", cookie, body: JSON.stringify({ name: "Flour", sku: `FLOUR-${randomUUID()}` }) });
    const item = (itemResponse.body as { data: { item: { id: string } } }).data.item;
    const created = await request(server.baseUrl, `${base}/transfers`, { method: "POST", cookie, body: JSON.stringify({
      reference: `TRF-${randomUUID().slice(0, 8)}`,
      fromLocationId: (locA.body as { data: { location: { id: string } } }).data.location.id,
      toLocationId: (locB.body as { data: { location: { id: string } } }).data.location.id,
      lines: [{ inventoryItemId: item.id, quantity: 2 }],
    }) });
    const transfer = (created.body as { data: { transfer: { id: string } } }).data.transfer;
    const cancelled = await request(server.baseUrl, `${base}/transfers/${transfer.id}/cancel`, { method: "POST", cookie });
    expect(cancelled.status).toBe(200);
    expect((await request(server.baseUrl, `${base}/transfers/${transfer.id}/send`, { method: "POST", cookie })).status).toBe(400);
  });

  it("cancels a sent transfer, reversing the stock that already left the source", async () => {
    const cookie = await actor("Transfer Sent Cancel Owner");
    const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Transfer Sent Cancel Market" }) });
    const business = (b.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const storesBase = `/api/businesses/${business.id}/stores/${business.defaultStore.id}`;
    const locA = await request(server.baseUrl, `${storesBase}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "A", kind: "warehouse", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) });
    const locB = await request(server.baseUrl, `${storesBase}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "B", kind: "warehouse", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) });
    const fromLocationId = (locA.body as { data: { location: { id: string } } }).data.location.id;
    const base = `/api/businesses/${business.id}/inventory`;
    const itemResponse = await request(server.baseUrl, `${base}/items`, { method: "POST", cookie, body: JSON.stringify({ name: "Butter", sku: `BUTTER-${randomUUID()}` }) });
    const item = (itemResponse.body as { data: { item: { id: string } } }).data.item;
    const fromInvLoc = await request(server.baseUrl, `${base}/locations`, { method: "POST", cookie, body: JSON.stringify({ locationId: fromLocationId, name: "A" }) });
    const fromInventoryLocationId = (fromInvLoc.body as { data: { location: { id: string } } }).data.location.id;
    await request(server.baseUrl, `${base}/movements`, { method: "POST", cookie, body: JSON.stringify({ inventoryItemId: item.id, inventoryLocationId: fromInventoryLocationId, quantity: 10, type: "receipt", reason: "Initial stock", idempotencyKey: randomUUID() }) });

    const created = await request(server.baseUrl, `${base}/transfers`, { method: "POST", cookie, body: JSON.stringify({
      reference: `TRF-${randomUUID().slice(0, 8)}`,
      fromLocationId,
      toLocationId: (locB.body as { data: { location: { id: string } } }).data.location.id,
      lines: [{ inventoryItemId: item.id, quantity: 4 }],
    }) });
    const transfer = (created.body as { data: { transfer: { id: string } } }).data.transfer;
    expect((await request(server.baseUrl, `${base}/transfers/${transfer.id}/send`, { method: "POST", cookie })).status).toBe(200);

    const balanceAfterSend = await request(server.baseUrl, `${base}/balances?inventoryItemId=${item.id}&inventoryLocationId=${fromInventoryLocationId}`, { cookie });
    expect((balanceAfterSend.body as { data: { balances: { onHand: string }[] } }).data.balances[0]?.onHand).toBe("6.000000");

    const cancelled = await request(server.baseUrl, `${base}/transfers/${transfer.id}/cancel`, { method: "POST", cookie });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { data: { cancelled: boolean } }).data.cancelled).toBe(true);

    const balanceAfterCancel = await request(server.baseUrl, `${base}/balances?inventoryItemId=${item.id}&inventoryLocationId=${fromInventoryLocationId}`, { cookie });
    expect((balanceAfterCancel.body as { data: { balances: { onHand: string }[] } }).data.balances[0]?.onHand).toBe("10.000000");

    expect((await request(server.baseUrl, `${base}/transfers/${transfer.id}/receive`, { method: "POST", cookie, body: JSON.stringify({ lines: [] }) })).status).toBe(400);
  });

  it("applies a stock count and posts the variance as an adjustment", async () => {
    const cookie = await actor("Count Owner");
    const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Count Market" }) });
    const business = (b.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const storesBase = `/api/businesses/${business.id}/stores/${business.defaultStore.id}`;
    const locResponse = await request(server.baseUrl, `${storesBase}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "Count Room", kind: "stockroom", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) });
    const locationId = (locResponse.body as { data: { location: { id: string } } }).data.location.id;

    const base = `/api/businesses/${business.id}/inventory`;
    const itemResponse = await request(server.baseUrl, `${base}/items`, { method: "POST", cookie, body: JSON.stringify({ name: "Rice 5kg", sku: `RICE-${randomUUID()}` }) });
    const item = (itemResponse.body as { data: { item: { id: string } } }).data.item;
    const invLoc = await request(server.baseUrl, `${base}/locations`, { method: "POST", cookie, body: JSON.stringify({ locationId, name: "Count Room" }) });
    const inventoryLocationId = (invLoc.body as { data: { location: { id: string } } }).data.location.id;
    await request(server.baseUrl, `${base}/movements`, { method: "POST", cookie, body: JSON.stringify({ inventoryItemId: item.id, inventoryLocationId, quantity: 10, type: "receipt", reason: "Initial stock", idempotencyKey: randomUUID() }) });

    const created = await request(server.baseUrl, `${base}/counts`, { method: "POST", cookie, body: JSON.stringify({ reference: `CNT-${randomUUID().slice(0, 8)}`, locationId, lines: [{ inventoryItemId: item.id, countedQuantity: 8 }] }) });
    expect(created.status).toBe(201);
    const count = (created.body as { data: { count: { id: string; status: string } } }).data.count;
    expect(count.status).toBe("draft");

    const detail = await request(server.baseUrl, `${base}/counts/${count.id}`, { cookie });
    const line = (detail.body as { data: { count: { lines: { systemQuantity: string; countedQuantity: string }[] } } }).data.count.lines[0]!;
    expect(line).toMatchObject({ systemQuantity: "10.000000", countedQuantity: "8.000000" });

    const countList = await request(server.baseUrl, `${base}/counts`, { cookie });
    const listedCount = (countList.body as { data: { counts: { id: string; itemCount: number; totalVariance: string }[] } }).data.counts.find((c) => c.id === count.id);
    expect(listedCount).toMatchObject({ itemCount: 1, totalVariance: "-2.000000" });

    const applied = await request(server.baseUrl, `${base}/counts/${count.id}/apply`, { method: "POST", cookie });
    expect(applied.status).toBe(200);
    expect((applied.body as { data: { count: { status: string } } }).data.count.status).toBe("applied");

    const balance = await request(server.baseUrl, `${base}/balances?inventoryItemId=${item.id}&inventoryLocationId=${inventoryLocationId}`, { cookie });
    expect((balance.body as { data: { balances: { onHand: string }[] } }).data.balances[0]?.onHand).toBe("8.000000");

    const movements = await request(server.baseUrl, `${base}/movements?inventoryItemId=${item.id}`, { cookie });
    const countMovement = (movements.body as { data: { movements: { type: string; quantity: string }[] } }).data.movements.find((m) => m.type === "count");
    expect(countMovement).toMatchObject({ type: "count", quantity: "-2.000000" });

    expect((await request(server.baseUrl, `${base}/counts/${count.id}/apply`, { method: "POST", cookie })).status).toBe(400);
  });

  it("rejects editing lines on an applied count and cancelling it", async () => {
    const cookie = await actor("Count Guard Owner");
    const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Count Guard Market" }) });
    const business = (b.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const storesBase = `/api/businesses/${business.id}/stores/${business.defaultStore.id}`;
    const locResponse = await request(server.baseUrl, `${storesBase}/locations`, { method: "POST", cookie, body: JSON.stringify({ name: "Room", kind: "stockroom", countryCode: "NG", timezone: "Africa/Lagos", businessHours: {} }) });
    const locationId = (locResponse.body as { data: { location: { id: string } } }).data.location.id;
    const base = `/api/businesses/${business.id}/inventory`;
    const itemResponse = await request(server.baseUrl, `${base}/items`, { method: "POST", cookie, body: JSON.stringify({ name: "Salt", sku: `SALT-${randomUUID()}` }) });
    const item = (itemResponse.body as { data: { item: { id: string } } }).data.item;
    const created = await request(server.baseUrl, `${base}/counts`, { method: "POST", cookie, body: JSON.stringify({ reference: `CNT-${randomUUID().slice(0, 8)}`, locationId, lines: [{ inventoryItemId: item.id, countedQuantity: 0 }] }) });
    const count = (created.body as { data: { count: { id: string } } }).data.count;
    await request(server.baseUrl, `${base}/counts/${count.id}/apply`, { method: "POST", cookie });

    expect((await request(server.baseUrl, `${base}/counts/${count.id}/lines`, { method: "PUT", cookie, body: JSON.stringify({ lines: [{ inventoryItemId: item.id, countedQuantity: 5 }] }) })).status).toBe(400);
    expect((await request(server.baseUrl, `${base}/counts/${count.id}/cancel`, { method: "POST", cookie })).status).toBe(400);
  });
});
