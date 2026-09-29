import { randomUUID } from "node:crypto";
import { localDateTimeToUtcMilliseconds, utcToLocalDateTime } from "@/shared/tz.js";

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
  if (signup.status !== 200 || !code) throw new Error(`Unable to authenticate POS test actor for ${label}`);
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return verified.cookies;
}

interface PosActor {
  cookies: string;
  businessId: string;
  storeId: string;
}

async function actor(label: string): Promise<PosActor> {
  const cookies = await authenticate(label);
  const response = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `${label} Salon` }) });
  const business = (response.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  return { cookies, businessId: business.id, storeId: business.defaultStore.id };
}

async function created<T>(fix: PosActor, path: string, body: unknown, pick: (response: any) => T): Promise<T> {
  const response = await request(server.baseUrl, `/api/businesses/${fix.businessId}${path}`, { method: "POST", cookie: fix.cookies, body: JSON.stringify(body) });
  if (response.status !== 201 && response.status !== 200) throw new Error(`${path} failed: ${response.status}`);
  return pick(response.body);
}

interface PosFixture {
  cookies: string;
  businessId: string;
  storeId: string;
  productId: string;
  variantId: string;
  staffId: string;
  locationId: string;
  timezone: string;
  startInstant: string;
  startLocalDate: string;
  assetCode: string;
}

/**
 * Active store with a 30-minute service, one bookable staff member, and a
 * branch priced at ₦4,945 with 7.5% VAT and a 2.5% service charge. The
 * booking starts ~90 minutes from now so it appears on today's till.
 */
async function posFixture(label: string): Promise<PosFixture> {
  const fix = await actor(label);
  const activated = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ status: "active" }) });
  if (activated.status !== 200) throw new Error("Unable to activate store");

  const store = (await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}`, { cookie: fix.cookies })).body as { data: { store: { timezone: string } } };
  const timezone = store.data.store.timezone;

  const startInstant = new Date(Math.ceil((Date.now() + 90 * 60_000) / 60_000) * 60_000).toISOString();
  const startLocalDate = utcToLocalDateTime(new Date(startInstant).getTime(), timezone).date;
  const weekday = new Date(`${startLocalDate}T00:00:00.000Z`).getUTCDay();

  const product = await created(fix, "/products", { storeId: fix.storeId, name: "Balayage", productType: "service" }, (b) => {
    const product = b.data.product as { id: string; variants: { id: string; isDefault: boolean }[] };
    const variant = product.variants.find((entry) => entry.isDefault) ?? product.variants[0];
    return { id: product.id, variantId: variant?.id };
  });
  const settings = await request(server.baseUrl, `/api/businesses/${fix.businessId}/products/${product.id}/service-settings`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ durationMinutes: 30 }) });
  if (settings.status !== 200) throw new Error("Service settings upsert failed");

  const locationId = await created(fix, `/stores/${fix.storeId}/locations`, { name: "Chair 1", kind: "branch", taxRate: 7.5, serviceChargeRates: { dine_in: 2.5 } }, (b) => b.data.location.id as string);
  const partyId = await created(fix, "/parties", { kind: "person", displayName: "Till Barber" }, (b) => b.data.party.id as string);
  const staffId = await created(fix, "/staff", { partyId, displayName: "Zainab", isBookable: true, commissionPercent: 10 }, (b) => (b.data.staff as { id: string }).id);

  const withServices = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staffId}/services`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ services: [{ productId: product.id }] }) });
  if (withServices.status !== 200) throw new Error("Staff services failed");
  const withSchedule = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staffId}/schedule`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ entries: [{ locationId, weekday, startTime: WORK_START, endTime: WORK_END }] }) });
  if (withSchedule.status !== 200) throw new Error("Staff schedule failed");

  const price = await request(server.baseUrl, `/api/businesses/${fix.businessId}/prices`, { method: "POST", cookie: fix.cookies, body: JSON.stringify({ productVariantId: product.variantId ?? null, assetCode: "NGN", amountMinor: 4945 }) });
  if (price.status !== 201) throw new Error(`Pricing failed: ${price.status}`);

  return { ...fix, productId: product.id, variantId: product.variantId ?? "", staffId, locationId, timezone, startInstant, startLocalDate, assetCode: "NGN" };
}

async function statusFor(fix: PosActor, bookingId: string, status: string): Promise<void> {
  const response = await request(server.baseUrl, `/api/store/bookings/${bookingId}/status`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ store_id: fix.storeId, status }) });
  if (response.status !== 200) throw new Error(`status ${status} failed: ${response.status}`);
}

function tickets(fix: PosFixture): { product_id: string; variant_id: string; quantity: number }[] {
  return [{ product_id: fix.productId, variant_id: fix.variantId, quantity: 1 }];
}

// 4945 subtotal, 7.5% VAT → 371, 2.5% service charge → 124, total 5440.
const EXPECTED_PREVIEW = { subtotal: 4945, discount: 0, taxAmount: 371, serviceChargeAmount: 124, total: 5440 };

describe("point-of-sale till", () => {
  it("previews and charges a booking at the till, netting the tip into commission", async () => {
    const fix = await posFixture("Till Owner");

    const reservation = await request(server.baseUrl, "/api/store/bookings/reserve", { method: "POST", body: JSON.stringify({
      store_id: fix.storeId,
      product_id: fix.productId,
      staff_id: fix.staffId,
      location_id: fix.locationId,
      starts_at: fix.startInstant,
      customer: { name: "Ada Lovelace", email: "ada@example.com" },
    }) });
    expect(reservation.status).toBe(201);
    const bookingId = (reservation.body as { data: { booking_id: string } }).data.booking_id;

    for (const status of ["confirmed", "arrived"]) {
      await statusFor(fix, bookingId, status);
    }

    // Today's till — the booking is arrived and its local day matches today
    // unless the run straddles midnight (in which case the day window shifted).
    if (fix.startLocalDate === utcToLocalDateTime(Date.now(), fix.timezone).date) {
      const till = await request(server.baseUrl, `/api/store/pos/bookings?store_id=${fix.storeId}`, { cookie: fix.cookies });
      expect(till.status).toBe(200);
      const bookings = till.body as { data: { id: string; order_id: string | null; status: string; items: { variant_id: string | null }[] }[] };
      expect(bookings.data.map((booking) => booking.id)).toContain(bookingId);
      expect(bookings.data.find((booking) => booking.id === bookingId)?.order_id).toBeNull();
    }

    const preview = await request(server.baseUrl, "/api/store/pos/order/preview", { method: "POST", cookie: fix.cookies, body: JSON.stringify({ store_id: fix.storeId, branch_id: fix.locationId, items: tickets(fix) }) });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ data: EXPECTED_PREVIEW });

    const charge = await request(server.baseUrl, "/api/store/pos/order", { method: "POST", cookie: fix.cookies, body: JSON.stringify({
      store_id: fix.storeId,
      branch_id: fix.locationId,
      booking_id: bookingId,
      payment_method: "cash",
      tip: { amount_minor: 500, staff_id: fix.staffId },
    }) });
    expect(charge.status).toBe(200);
    const summary = (charge.body as { data: {
      order_id: string; order_number: string; currency: string; total_minor: number; tax_minor: number;
      service_charge_minor: number; deposit_paid_minor: number; balance_due_minor: number;
      tip: { amount_minor: number; staff_id: string | null } | null; booking_id: string | null; booking_status: string | null;
      lines: { product_variant_id: string }[];
    } }).data;
    expect(summary.currency).toBe("NGN");
    expect(summary.total_minor).toBe(5440);
    expect(summary.tax_minor).toBe(371);
    expect(summary.service_charge_minor).toBe(124);
    expect(summary.tip).toMatchObject({ amount_minor: 500, staff_id: fix.staffId });
    expect(summary.deposit_paid_minor).toBe(0);
    expect(summary.balance_due_minor).toBe(0);
    expect(summary.booking_id).toBe(bookingId);
    expect(summary.booking_status).toBe("completed");
    expect(summary.lines).toHaveLength(1);

    // Booking pricing was backfilled and the booking captured the order.
    const bookings = await request(server.baseUrl, `/api/store/bookings?store_id=${fix.storeId}`, { cookie: fix.cookies });
    const completed = (bookings.body as { data: { data: { id: string; order_id: string | null; items: { status: string; price_minor: string }[] }[] } }).data.data.find((booking) => booking.id === bookingId);
    expect(completed?.order_id).toBe(summary.order_id);
    expect(completed?.items[0]).toMatchObject({ status: "completed", price_minor: "4945" });

    // Re-charging the same booking is idempotent — the same order surfaces.
    const replay = await request(server.baseUrl, "/api/store/pos/order", { method: "POST", cookie: fix.cookies, body: JSON.stringify({
      store_id: fix.storeId,
      branch_id: fix.locationId,
      booking_id: bookingId,
      payment_method: "cash",
    }) });
    const replayed = (replay.body as { data: { order_id: string; booking_status: string | null } }).data;
    expect(replay.status).toBe(200);
    expect(replayed.order_id).toBe(summary.order_id);
    expect(replayed.booking_status).toBe("completed");

    // Commission report now carries the tip for the performer.
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const report = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/commission-report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { cookie: fix.cookies });
    const row = (report.body as { data: { report: { staffId: string; revenueMinor: number; tipsMinor: number; commissionMinor: number; completedBookings: number }[] } }).data.report.find((entry) => entry.staffId === fix.staffId)!;
    expect(row).toMatchObject({ revenueMinor: 4945, tipsMinor: 500, commissionMinor: Math.round((4945 * 10) / 100), completedBookings: 1 });

    // Without a shift or booking the retail charge still works.
    const retail = await request(server.baseUrl, "/api/store/pos/order", { method: "POST", cookie: fix.cookies, body: JSON.stringify({
      store_id: fix.storeId,
      branch_id: fix.locationId,
      items: tickets(fix),
      payment_method: "card",
    }) });
    expect(retail.status).toBe(200);
    expect((retail.body as { data: { booking_id: string | null; balance_due_minor: number } }).data).toMatchObject({
      booking_id: null,
      balance_due_minor: 0,
    });
  });

  it("rejects charging a shift from a different branch", async () => {
    const fix = await posFixture("Shift Owner");
    const otherLocationId = await created(fix, `/stores/${fix.storeId}/locations`, { name: "Chair 2", kind: "branch" }, (b) => b.data.location.id as string);

    const register = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}/registers`, { method: "POST", cookie: fix.cookies, body: JSON.stringify({ locationId: fix.locationId, name: "Front Till" }) });
    expect(register.status).toBe(201);
    const registerId = (register.body as { data: { register: { id: string } } }).data.register.id;

    const opened = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}/registers/${registerId}/shifts`, { method: "POST", cookie: fix.cookies, body: JSON.stringify({ openingCashMinor: "0" }) });
    expect(opened.status).toBe(201);
    const shiftId = (opened.body as { data: { shift: { id: string } } }).data.shift.id;

    const response = await request(server.baseUrl, "/api/store/pos/order", { method: "POST", cookie: fix.cookies, body: JSON.stringify({
      store_id: fix.storeId,
      branch_id: otherLocationId,
      items: tickets(fix),
      payment_method: "cash",
      register_shift_id: shiftId,
    }) });
    expect(response.status).toBe(409);
  });

  it("counts cash sales rung up on a shift in its expected cash", async () => {
    const fix = await posFixture("Drawer Owner");
    const register = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}/registers`, { method: "POST", cookie: fix.cookies, body: JSON.stringify({ locationId: fix.locationId, name: "Front Till" }) });
    const registerId = (register.body as { data: { register: { id: string } } }).data.register.id;
    const opened = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}/registers/${registerId}/shifts`, { method: "POST", cookie: fix.cookies, body: JSON.stringify({ openingCashMinor: "10000" }) });
    const shiftId = (opened.body as { data: { shift: { id: string } } }).data.shift.id;

    const charge = (method: string) =>
      request(server.baseUrl, "/api/store/pos/order", { method: "POST", cookie: fix.cookies, body: JSON.stringify({
        store_id: fix.storeId,
        branch_id: fix.locationId,
        items: tickets(fix),
        payment_method: method,
        register_shift_id: shiftId,
      }) });
    const cashSale = await charge("cash");
    expect(cashSale.status).toBe(200);
    expect((await charge("card")).status).toBe(200);
    const cashTotal = (cashSale.body as { data: { total_minor: number } }).data.total_minor;

    const closed = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}/shifts/${shiftId}/close`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ countedCashMinor: String(10000 + cashTotal) }) });
    expect(closed.status).toBe(200);
    const shift = (closed.body as { data: { shift: { expectedCashMinor: string; varianceMinor: string } } }).data.shift;
    expect(shift.expectedCashMinor).toBe(String(10000 + cashTotal));
    expect(shift.varianceMinor).toBe("0");
  });
});
