/**
 * Google Calendar sync for bookings, with Google itself mocked: which calendar
 * an event lands on, that a reschedule moves it and a cancellation removes it,
 * the Meet preference, and that Google busy times hide slots.
 */
import { randomUUID } from "node:crypto";
import { localDateTimeToUtcMilliseconds } from "@/shared/tz.js";

let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
}));

const google = {
  findGoogleCalendarAccount: jest.fn(async (_userId: string) => ({ accountId: "account-1", email: "owner@gmail.com" }) as { accountId: string; email: string } | null),
  createCalendarEvent: jest.fn(async () => ({ eventId: "event-1", meetUrl: "https://meet.google.com/abc-defg-hij" })),
  moveCalendarEvent: jest.fn(async () => {}),
  deleteCalendarEvent: jest.fn(async () => {}),
  busyIntervals: jest.fn(async () => [] as { start: Date; end: Date }[]),
  disconnectGoogleCalendar: jest.fn(async (_userId: string) => {}),
};
jest.mock("@/integrations/google-calendar.js", () => ({
  GOOGLE_CALENDAR_SCOPES: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"],
  findGoogleCalendarAccount: (userId: string) => google.findGoogleCalendarAccount(userId),
  createCalendarEvent: (...args: unknown[]) => (google.createCalendarEvent as (...a: unknown[]) => unknown)(...args),
  moveCalendarEvent: (...args: unknown[]) => (google.moveCalendarEvent as (...a: unknown[]) => unknown)(...args),
  deleteCalendarEvent: (...args: unknown[]) => (google.deleteCalendarEvent as (...a: unknown[]) => unknown)(...args),
  busyIntervals: (...args: unknown[]) => (google.busyIntervals as (...a: unknown[]) => unknown)(...args),
  disconnectGoogleCalendar: (userId: string) => google.disconnectGoogleCalendar(userId),
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;
jest.setTimeout(30_000);

beforeAll(async () => {
  verificationMessages = [];
  server = await startTestServer();
});
afterAll(async () => server.close());
beforeEach(() => jest.clearAllMocks());

interface Fixture {
  cookies: string;
  ownerUserId: string;
  businessId: string;
  storeId: string;
  productId: string;
  staffId: string;
  locationId: string;
  localDate: string;
  startInstant: string;
}

async function call(path: string, cookies: string, method = "GET", body?: unknown) {
  return request(server.baseUrl, path, { method, cookie: cookies, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function post<T>(fix: { businessId: string; cookies: string }, path: string, body: unknown, pick: (response: any) => T): Promise<T> {
  const response = await call(`/api/businesses/${fix.businessId}${path}`, fix.cookies, "POST", body);
  if (response.status !== 201 && response.status !== 200) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(response.body)}`);
  return pick(response.body);
}

/** A business whose one bookable staff member is the owner's own login (so their calendar is the owner's). */
async function fixture(label: string): Promise<Fixture> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: PASSWORD }) });
  const code = verificationMessages.find((message) => message.to === email)!.code;
  const cookies = (await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) })).cookies;
  const ownerUserId = ((await call("/api/auth/get-session", cookies)).body as { user: { id: string } }).user.id;

  const business = ((await call("/api/businesses", cookies, "POST", { displayName: `${label} Studio` })).body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  const fix = { cookies, businessId: business.id };
  const storeId = business.defaultStore.id;
  await call(`/api/businesses/${business.id}/stores/${storeId}`, cookies, "PATCH", { status: "active" });
  const timezone = ((await call(`/api/businesses/${business.id}/stores/${storeId}`, cookies)).body as { data: { store: { timezone: string } } }).data.store.timezone;

  const today = new Date();
  const localDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3, 12).toISOString().slice(0, 10);
  const weekday = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();

  const productId = await post(fix, "/products", { storeId, name: "Consultation", productType: "service" }, (b) => b.data.product.id as string);
  await call(`/api/businesses/${business.id}/products/${productId}/service-settings`, cookies, "PUT", { durationMinutes: 30 });
  const locationId = await post(fix, `/stores/${storeId}/locations`, { name: "Studio A", kind: "branch" }, (b) => b.data.location.id as string);

  const members = ((await call(`/api/businesses/${business.id}/team/members`, cookies)).body as { data: { members: { id: string }[] } }).data.members;
  const staffId = await post(fix, "/staff", { membershipId: members[0]!.id, displayName: "Owner", isBookable: true }, (b) => b.data.staff.id as string);
  await call(`/api/businesses/${business.id}/staff/${staffId}/services`, cookies, "PUT", { services: [{ productId }] });
  await call(`/api/businesses/${business.id}/staff/${staffId}/schedule`, cookies, "PUT", { entries: [{ locationId, weekday, startTime: "09:00", endTime: "17:00" }] });

  const startInstant = new Date(localDateTimeToUtcMilliseconds(localDate, "10:00", timezone)).toISOString();
  return { cookies, ownerUserId, businessId: business.id, storeId, productId, staffId, locationId, localDate, startInstant };
}

function createBooking(fix: Fixture) {
  return call("/api/store/bookings", fix.cookies, "POST", {
    store_id: fix.storeId,
    location_id: fix.locationId,
    starts_at: fix.startInstant,
    customer: { name: "Ada Lovelace", email: "ada@example.com" },
    items: [{ product_id: fix.productId, staff_id: fix.staffId }],
  });
}

describe("bookings on Google Calendar", () => {
  it("adds a confirmed booking to the booked person's calendar, moves it on reschedule and removes it on cancel", async () => {
    const fix = await fixture("Calendar Owner");

    const created = await createBooking(fix);
    expect(created.status).toBe(201);
    const bookingId = (created.body as { data: { id: string } }).data.id;
    expect(google.createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(google.createCalendarEvent).toHaveBeenCalledWith(
      fix.ownerUserId,
      expect.objectContaining({ accountId: "account-1" }),
      expect.objectContaining({ attendeeEmail: "ada@example.com", withMeet: true, location: "Studio A", startsAt: new Date(fix.startInstant) }),
    );

    // A status change that doesn't move the time leaves the event (and the customer) alone.
    expect((await call(`/api/store/bookings/${bookingId}/status`, fix.cookies, "PATCH", { store_id: fix.storeId, status: "arrived" })).status).toBe(200);
    expect(google.moveCalendarEvent).not.toHaveBeenCalled();
    expect(google.createCalendarEvent).toHaveBeenCalledTimes(1);

    const later = new Date(Date.parse(fix.startInstant) + 60 * 60 * 1000).toISOString();
    expect((await call(`/api/store/bookings/${bookingId}/status`, fix.cookies, "PATCH", { store_id: fix.storeId, status: "arrived", starts_at: later })).status).toBe(200);
    expect(google.moveCalendarEvent).toHaveBeenCalledWith(fix.ownerUserId, expect.anything(), "event-1", expect.objectContaining({ startsAt: new Date(later) }));

    expect((await call(`/api/store/bookings/${bookingId}/status`, fix.cookies, "PATCH", { store_id: fix.storeId, status: "cancelled" })).status).toBe(200);
    expect(google.deleteCalendarEvent).toHaveBeenCalledWith(fix.ownerUserId, expect.anything(), "event-1");
  });

  it("follows the person's Meet preference and skips people who haven't connected", async () => {
    const fix = await fixture("Meet Owner");

    const status = await call("/api/me/integrations", fix.cookies);
    expect(status.status).toBe(200);
    expect((status.body as { data: { googleCalendar: { connected: boolean; meetEnabled: boolean; scopes: string[] } } }).data.googleCalendar).toMatchObject({
      connected: true,
      meetEnabled: true,
      email: "owner@gmail.com",
    });

    const turnedOff = await call("/api/me/integrations/google-calendar", fix.cookies, "PATCH", { meetEnabled: false });
    expect((turnedOff.body as { data: { googleCalendar: { meetEnabled: boolean } } }).data.googleCalendar.meetEnabled).toBe(false);
    expect((await createBooking(fix)).status).toBe(201);
    expect(google.createCalendarEvent).toHaveBeenCalledWith(fix.ownerUserId, expect.anything(), expect.objectContaining({ withMeet: false }));

    google.findGoogleCalendarAccount.mockResolvedValue(null);
    const another = await call("/api/store/bookings", fix.cookies, "POST", {
      store_id: fix.storeId,
      location_id: fix.locationId,
      starts_at: new Date(Date.parse(fix.startInstant) + 2 * 60 * 60 * 1000).toISOString(),
      customer: { name: "Grace Hopper" },
      items: [{ product_id: fix.productId, staff_id: fix.staffId }],
    });
    expect(another.status).toBe(201);
    expect(google.createCalendarEvent).toHaveBeenCalledTimes(1);
    google.findGoogleCalendarAccount.mockResolvedValue({ accountId: "account-1", email: "owner@gmail.com" });
  });

  it("hides slots when the staff member is busy in Google Calendar", async () => {
    const fix = await fixture("Busy Owner");
    const slotsPath = `/api/store/bookings/slots?store_id=${fix.storeId}&product_id=${fix.productId}&staff_id=${fix.staffId}&date=${fix.localDate}&days=1`;
    const startsAt = (response: Awaited<ReturnType<typeof call>>) =>
      (response.body as { data: { slots: { starts_at: string }[] } }).data.slots.map((slot) => slot.starts_at);

    expect(startsAt(await call(slotsPath, fix.cookies))).toContain(fix.startInstant);

    google.busyIntervals.mockResolvedValueOnce([{ start: new Date(fix.startInstant), end: new Date(Date.parse(fix.startInstant) + 30 * 60 * 1000) }]);
    const busy = startsAt(await call(slotsPath, fix.cookies));
    expect(busy).not.toContain(fix.startInstant);
    expect(busy.length).toBeGreaterThan(0);
  });
});
