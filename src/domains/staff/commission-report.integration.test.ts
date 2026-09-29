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
  if (signup.status !== 200 || !code) throw new Error(`Unable to authenticate commission test actor for ${label}`);
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

interface CommissionFixture {
  cookies: string;
  businessId: string;
  storeId: string;
  productId: string;
  staffId: string;
  otherStaffId: string;
  locationId: string;
  timezone: string;
  localDate: string;
  startInstant: string;
}

/** Store activated, a 30-minute service, two bookable staff members (one on 10%
 *  commission) both working 09:00-17:00 three days from now. */
async function commissionFixture(label: string): Promise<CommissionFixture> {
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
  const partyId = await created(fix, "/parties", { kind: "person", displayName: "Commission Barber" }, (b) => b.data.party.id as string);
  const staff = await created(fix, "/staff", { partyId, displayName: "Nadia", isBookable: true, commissionPercent: 10 }, (b) => b.data.staff as { id: string });
  const otherStaff = await created(fix, "/parties", { kind: "person", displayName: "No-Show Barber" }, (b) => b.data.party.id as string).then((partyId) =>
    created(fix, "/staff", { partyId, displayName: "Idle", isBookable: true }, (b) => b.data.staff as { id: string }),
  );

  const withServices = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}/services`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ services: [{ productId }] }) });
  if (withServices.status !== 200) throw new Error("Staff services failed");
  const withSchedule = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}/schedule`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ entries: [{ locationId, weekday, startTime: WORK_START, endTime: WORK_END }] }) });
  if (withSchedule.status !== 200) throw new Error("Staff schedule failed");

  const startInstant = new Date(localDateTimeToUtcMilliseconds(localDate, "10:00", timezone)).toISOString();
  return { ...fix, productId, staffId: staff.id, otherStaffId: otherStaff.id, locationId, timezone, localDate, startInstant };
}

function reserveBody(fix: CommissionFixture): Record<string, unknown> {
  return {
    store_id: fix.storeId,
    product_id: fix.productId,
    staff_id: fix.staffId,
    location_id: fix.locationId,
    starts_at: fix.startInstant,
    customer: { name: "Ada Lovelace", email: "ada@example.com" },
  };
}

async function statusFor(fix: BookingActor, bookingId: string, status: string): Promise<void> {
  const response = await request(server.baseUrl, `/api/store/bookings/${bookingId}/status`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ store_id: fix.storeId, status }) });
  if (response.status !== 200) throw new Error(`status ${status} failed: ${response.status}`);
}

/** Reservations hold a 0 price until the Phase 2 till resolves it, so the report
 *  is exercised against a priced item by seeding priceMinor directly. The seed
 *  runs as the migration role so it bypasses RLS on app.booking_items. */
async function setItemPriceMinor(bookingId: string, priceMinor: number): Promise<void> {
  const { loadEnvironment } = await import("@/shared/environment.js");
  const { Pool } = await import("pg");
  const environment = loadEnvironment();
  const pool = new Pool({ connectionString: environment.DATABASE_MIGRATE_URL, max: 1 });
  try {
    await pool.query('update app.booking_items set "priceMinor" = $1 where "bookingId" = $2', [priceMinor, bookingId]);
  } finally {
    await pool.end();
  }
}

describe("staff commission and reporting", () => {
  it("stores and validates a staff member's commission percentage", async () => {
    const fix = await actor("Commission Owner");
    const partyId = await created(fix, "/parties", { kind: "person", displayName: "Paid Barber" }, (b) => b.data.party.id as string);
    const staff = await created(fix, "/staff", { partyId, displayName: "Yusuf", isBookable: true, commissionPercent: 15 }, (b) => b.data.staff as { id: string; commissionPercent: number });
    expect(staff.commissionPercent).toBe(15);

    const updated = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ commissionPercent: 25 }) });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { staff: { commissionPercent: number } } }).data.staff.commissionPercent).toBe(25);

    const invalid = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff`, { method: "POST", cookie: fix.cookies, body: JSON.stringify({ partyId, displayName: "Too Much", isBookable: true, commissionPercent: 101 }) });
    expect(invalid.status).toBe(400);
  });

  it("reports per-staff service revenue and commission from completed bookings", async () => {
    const fix = await commissionFixture("Reporting Owner");

    const reservation = await request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify(reserveBody(fix)) });
    expect(reservation.status).toBe(201);
    const bookingId = (reservation.body as { data: { booking_id: string } }).data.booking_id;

    for (const status of ["confirmed", "arrived", "in_service", "completed"]) {
      await statusFor(fix, bookingId, status);
    }

    const list = await request(server.baseUrl, `/api/store/bookings?store_id=${fix.storeId}`, { cookie: fix.cookies });
    const completed = (list.body as { data: { data: { id: string; items: { status: string }[] }[] } }).data.data.find((booking) => booking.id === bookingId);
    expect(completed?.items[0]?.status).toBe("completed");

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const report = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/commission-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cookie: fix.cookies });
    expect(report.status).toBe(200);
    const rows = (report.body as { data: { report: { staffId: string; displayName: string; commissionPercent: number; revenueMinor: number; tipsMinor: number; commissionMinor: number; completedBookings: number }[] } }).data.report;
    // Two staff added here, plus the owner, who is bookable from the start.
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.staffId === fix.otherStaffId)).toMatchObject({ revenueMinor: 0, commissionMinor: 0, completedBookings: 0 });

    const nadia = rows.find((row) => row.staffId === fix.staffId)!;
    expect(nadia).toMatchObject({
      commissionPercent: 10,
      revenueMinor: 0,
      tipsMinor: 0,
      completedBookings: 1,
      commissionMinor: 0,
    });

    // Price the completed service so the revenue/commission math is exercised.
    await setItemPriceMinor(bookingId, 4945);
    const priced = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/commission-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cookie: fix.cookies });
    const pricedRow = (priced.body as { data: { report: typeof rows } }).data.report.find((row: { staffId: string }) => row.staffId === fix.staffId)!;
    expect(pricedRow).toMatchObject({
      revenueMinor: 4945,
      commissionMinor: Math.round((4945 * 10) / 100),
      completedBookings: 1,
    });
  });

  it("rejects the commission report for a tenant without team.read", async () => {
    const victim = await commissionFixture("Report Victim");
    const intruder = await actor("Report Intruder");
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const response = await request(server.baseUrl, `/api/businesses/${victim.businessId}/staff/commission-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cookie: intruder.cookies });
    expect(response.status).toBe(403);
  });
});