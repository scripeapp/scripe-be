import { randomUUID } from "node:crypto";
import { localDateTimeToUtcMilliseconds } from "@/shared/tz.js";

let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
}));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
const WORK_START = "09:00";
const WORK_END = "17:00";

let server: TestServer;
jest.setTimeout(30_000);

beforeAll(async () => {
  verificationMessages = [];
  server = await startTestServer();
});
afterAll(async () => server.close());

async function authenticate(label: string): Promise<string> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: PASSWORD }) });
  const code = verificationMessages.find((message) => message.to === email)?.code;
  if (signup.status !== 200 || !code) throw new Error(`Unable to authenticate booking test actor for ${label}`);
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return verified.cookies;
}

interface BookingActor {
  cookies: string;
  businessId: string;
  storeId: string;
}

async function actor(label: string): Promise<BookingActor> {
  const cookies = await authenticate(label);
  const response = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `${label} Salon` }) });
  const business = (response.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  return { cookies, businessId: business.id, storeId: business.defaultStore.id };
}

async function created<T>(fix: BookingActor, path: string, body: unknown, pick: (response: any) => T): Promise<T> {
  const response = await request(server.baseUrl, `/api/businesses/${fix.businessId}${path}`, { method: "POST", cookie: fix.cookies, body: JSON.stringify(body) });
  if (response.status !== 201 && response.status !== 200) throw new Error(`${path} failed: ${response.status}`);
  return pick(response.body);
}

interface BookingFixture {
  cookies: string;
  businessId: string;
  storeId: string;
  productId: string;
  staffId: string;
  locationId: string;
  timezone: string;
  /** Store-local calendar date, three days out, with the staff working that weekday. */
  localDate: string;
  /** UTC instant of 10:00 at the store. */
  startInstant: string;
}

/** Full tenant setup: store activated, a 30-minute service, one bookable staff
 *  member working 09:00-17:00 three days from now. */
async function bookingFixture(label: string): Promise<BookingFixture> {
  const fix = await actor(label);
  const activated = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ status: "active" }) });
  if (activated.status !== 200) throw new Error("Unable to activate store");

  const store = (await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}`, { cookie: fix.cookies })).body as { data: { store: { timezone: string } } };
  const timezone = store.data.store.timezone;

  const today = new Date();
  const localDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3, 12).toISOString().slice(0, 10);
  const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();

  const productId = await created(fix, "/products", { storeId: fix.storeId, name: "Braids", productType: "service" }, (b) => b.data.product.id as string);
  const settings = await request(server.baseUrl, `/api/businesses/${fix.businessId}/products/${productId}/service-settings`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ durationMinutes: 30 }) });
  if (settings.status !== 200) throw new Error("Service settings upsert failed");

  const locationId = await created(fix, `/stores/${fix.storeId}/locations`, { name: "Chair 2", kind: "branch" }, (b) => b.data.location.id as string);
  const partyId = await created(fix, "/parties", { kind: "person", displayName: "Bookable Barber" }, (b) => b.data.party.id as string);
  const staff = await created(fix, "/staff", { partyId, displayName: "Nadia", isBookable: true }, (b) => b.data.staff as { id: string });

  const withServices = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}/services`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ services: [{ productId }] }) });
  if (withServices.status !== 200) throw new Error("Staff services failed");
  const withSchedule = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}/schedule`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ entries: [{ locationId, weekday, startTime: WORK_START, endTime: WORK_END }] }) });
  if (withSchedule.status !== 200) throw new Error("Staff schedule failed");

  const startInstant = new Date(localDateTimeToUtcMilliseconds(localDate, "10:00", timezone)).toISOString();
  return { ...fix, productId, staffId: staff.id, locationId, timezone, localDate, startInstant };
}

function reserveBody(fix: BookingFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    store_id: fix.storeId,
    product_id: fix.productId,
    staff_id: fix.staffId,
    location_id: fix.locationId,
    starts_at: fix.startInstant,
    customer: { name: "Ada Lovelace", email: "ada@example.com" },
    ...overrides,
  };
}

describe("bookings domain", () => {
  it("requires authentication for the dashboard but allows public reservation setup", async () => {
    const storeId = randomUUID();
    expect((await request(server.baseUrl, `/api/store/bookings?store_id=${storeId}`)).status).toBe(401);
    expect((await request(server.baseUrl, `/api/store/bookings/slots?store_id=${storeId}`)).status).toBe(401);
    expect((await request(server.baseUrl, `/api/store/bookings/${randomUUID()}/status`, { method: "PATCH", body: JSON.stringify({ store_id: storeId, status: "confirmed" }) })).status).toBe(401);
  });

  it("reserves a service, lists it, reschedules it, and syncs the status to its item", async () => {
    const fix = await bookingFixture("Booking Owner");

    // The slot engine must surface 10:00 as bookable for this staff member.
    const slots = await request(server.baseUrl, `/api/store/bookings/slots?store_id=${fix.storeId}&product_id=${fix.productId}&staff_id=${fix.staffId}&date=${fix.localDate}&days=1`, { cookie: fix.cookies });
    expect(slots.status).toBe(200);
    const slotsPayload = (slots.body as { data: { timezone: string; slots: { starts_at: string; staff_id: string }[] } }).data;
    expect(slotsPayload.timezone).toBe(fix.timezone);
    const matching = slotsPayload.slots.find((slot) => slot.starts_at === fix.startInstant && slot.staff_id === fix.staffId);
    expect(matching).toBeTruthy();

    const reservation = await request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify(reserveBody(fix)) });
    expect(reservation.status).toBe(201);
    const booking = (reservation.body as { data: { booking_id: string; starts_at: string; ends_at: string; hold_expires_at: string } }).data;
    expect(booking.ends_at).toBe(new Date(Date.parse(booking.starts_at) + 30 * 60 * 1000).toISOString());
    expect(Date.parse(booking.hold_expires_at)).toBeGreaterThan(Date.now());

    const list = await request(server.baseUrl, `/api/store/bookings?store_id=${fix.storeId}`, { cookie: fix.cookies });
    expect(list.status).toBe(200);
    const listPayload = (list.body as { data: { data: { id: string; status: string; starts_at: string; items: { status: string }[] }[]; meta: { total: number } } }).data;
    expect(listPayload.meta.total).toBe(1);
    expect(listPayload.data[0]!.id).toBe(booking.booking_id);
    expect(listPayload.data[0]!.status).toBe("held");
    expect(listPayload.data[0]!.items).toHaveLength(1);
    expect(listPayload.data[0]!.items[0]!.status).toBe("held");

    const rescheduledStart = new Date(localDateTimeToUtcMilliseconds(fix.localDate, "11:00", fix.timezone)).toISOString();
    const rescheduled = await request(server.baseUrl, `/api/store/bookings/${booking.booking_id}/status`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ store_id: fix.storeId, status: "confirmed", starts_at: rescheduledStart }) });
    expect(rescheduled.status).toBe(200);
    const confirmed = (rescheduled.body as { data: { status: string; starts_at: string; items: { status: string }[] } }).data;
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.starts_at).toBe(rescheduledStart);
    expect(confirmed.items[0]!.status).toBe("confirmed");

    const invalid = await request(server.baseUrl, `/api/store/bookings/${booking.booking_id}/status`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ store_id: fix.storeId, status: "held" }) });
    expect(invalid.status).toBe(400);

    const cancelled = await request(server.baseUrl, `/api/store/bookings/${booking.booking_id}/status`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ store_id: fix.storeId, status: "cancelled", cancel_reason: "Changed my mind" }) });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { data: { status: string } }).data.status).toBe("cancelled");

    // Cancelling frees the staff member's slot for the same instant.
    const again = await request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify(reserveBody(fix)) });
    expect(again.status).toBe(201);
  });

  it("rejects a double-booking of the same staff member (409 slot_taken)", async () => {
    const fix = await bookingFixture("Double-book Owner");
    const first = await request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify(reserveBody(fix)) });
    expect(first.status).toBe(201);
    const second = await request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify(reserveBody(fix)) });
    expect(second.status).toBe(409);
  });

  it("resolves exactly one winner under a concurrent reservation race", async () => {
    const fix = await bookingFixture("Race Owner");
    const attempts = await Promise.all([
      request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify(reserveBody(fix, { manage_token: randomUUID().replace(/-/g, "") })) }),
      request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify(reserveBody(fix, { manage_token: randomUUID().replace(/-/g, "") })) }),
    ]);
    const statuses = attempts.map((attempt) => attempt.status).sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("rejects a reservation into an inactive store", async () => {
    const fix = await actor("Inactive Owner");
    const response = await request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify({ store_id: fix.storeId, product_id: randomUUID(), staff_id: randomUUID(), starts_at: new Date(Date.now() + 3 * 86_400_000).toISOString() }) });
    expect(response.status).toBe(404);
  });

  it("blocks cross-tenant booking access", async () => {
    const victim = await bookingFixture("Victim Owner");
    const reservation = await request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify(reserveBody(victim)) });
    expect(reservation.status).toBe(201);
    const bookingId = (reservation.body as { data: { booking_id: string } }).data.booking_id;

    const intruder = await actor("Intruder Owner");
    const statusBody = JSON.stringify({ store_id: victim.storeId, status: "arrived" });
    const status = await request(server.baseUrl, `/api/store/bookings/${bookingId}/status`, { method: "PATCH", cookie: intruder.cookies, body: statusBody });
    expect(status.status).toBe(403);
    const list = await request(server.baseUrl, `/api/store/bookings?store_id=${victim.storeId}`, { cookie: intruder.cookies });
    expect(list.status).toBe(403);
  });
});