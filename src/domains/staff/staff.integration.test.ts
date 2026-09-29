import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
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

async function authenticate(label: string): Promise<string> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: PASSWORD }) });
  const code = verificationMessages.find((message) => message.to === email)?.code;
  if (signup.status !== 200 || !code) throw new Error("Unable to authenticate staff test actor");
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return verified.cookies;
}

interface Fixture {
  cookies: string;
  businessId: string;
  storeId: string;
}

async function fixture(label: string): Promise<Fixture> {
  const cookies = await authenticate(label);
  const response = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `${label} Salon` }) });
  const business = (response.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  return { cookies, businessId: business.id, storeId: business.defaultStore.id };
}

async function created<T>(fix: Fixture, path: string, body: unknown, pick: (body: any) => T): Promise<T> {
  const response = await request(server.baseUrl, `/api/businesses/${fix.businessId}${path}`, { method: "POST", cookie: fix.cookies, body: JSON.stringify(body) });
  if (response.status !== 201 && response.status !== 200) throw new Error(`${path} failed: ${response.status}`);
  return pick(response.body);
}

describe("staff domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/staff`)).status).toBe(401);
  });

  it("makes a new business's owner bookable on weekdays at the default branch", async () => {
    const fix = await fixture("Solo Owner");
    const staff = ((await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff`, { cookie: fix.cookies })).body as { data: { staff: { displayName: string; isBookable: boolean; membershipId: string | null; schedule: { weekday: number; startTime: string; endTime: string; locationId: string }[] }[] } }).data.staff;
    const branches = ((await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}/locations`, { cookie: fix.cookies })).body as { data: { locations: { id: string; isDefault: boolean }[] } }).data.locations;
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ displayName: "Solo Owner", isBookable: true, membershipId: expect.any(String) });
    expect(staff[0]!.schedule.map((entry) => [entry.weekday, entry.startTime, entry.endTime])).toEqual([1, 2, 3, 4, 5].map((weekday) => [weekday, "09:00", "17:00"]));
    expect(new Set(staff[0]!.schedule.map((entry) => entry.locationId))).toEqual(new Set([branches.find((branch) => branch.isDefault)!.id]));
  });

  it("manages a payroll staff member end to end", async () => {
    const fix = await fixture("Team Owner");
    const partyId = await created(fix, "/parties", { kind: "person", displayName: "Dami the Barber" }, (b) => b.data.party.id as string);
    const productId = await created(fix, "/products", { storeId: fix.storeId, name: "Fade Cut", productType: "service" }, (b) => b.data.product.id as string);
    const locationId = await created(fix, `/stores/${fix.storeId}/locations`, { name: "Chair 1", kind: "branch" }, (b) => b.data.location.id as string);

    const staff = await created(fix, "/staff", { partyId, displayName: "Dami", isBookable: true }, (b) => b.data.staff as { id: string });
    expect(staff.id).toBeTruthy();

    const list = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff`, { cookie: fix.cookies });
    // The owner is bookable from the start, so Dami is the second staff member.
    const listed = (list.body as { data: { staff: { id: string }[] } }).data.staff;
    expect(listed).toHaveLength(2);
    expect(listed.map((member) => member.id)).toContain(staff.id);

    const withServices = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}/services`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ services: [{ productId }] }) });
    expect(withServices.status).toBe(200);
    expect((withServices.body as { data: { staff: { services: unknown[] } } }).data.staff.services).toHaveLength(1);

    const withSchedule = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}/schedule`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ entries: [{ locationId, weekday: 1, startTime: "09:00", endTime: "17:00" }] }) });
    expect(withSchedule.status).toBe(200);
    expect((withSchedule.body as { data: { staff: { schedule: unknown[] } } }).data.staff.schedule).toHaveLength(1);

    const exception = await request(server.baseUrl, `/api/businesses/${fix.businessId}/schedule-exceptions`, { method: "POST", cookie: fix.cookies, body: JSON.stringify({ staffId: staff.id, startsAt: "2026-12-25T00:00:00.000Z", endsAt: "2026-12-26T00:00:00.000Z", kind: "off", reason: "Christmas" }) });
    expect(exception.status).toBe(201);
    const exceptions = await request(server.baseUrl, `/api/businesses/${fix.businessId}/schedule-exceptions?staffId=${staff.id}`, { cookie: fix.cookies });
    expect((exceptions.body as { data: { exceptions: { id: string }[] } }).data.exceptions).toHaveLength(1);
    const exceptionId = (exceptions.body as { data: { exceptions: { id: string }[] } }).data.exceptions[0]!.id;
    expect((await request(server.baseUrl, `/api/businesses/${fix.businessId}/schedule-exceptions/${exceptionId}`, { method: "DELETE", cookie: fix.cookies })).status).toBe(200);

    const patched = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}`, { method: "PATCH", cookie: fix.cookies, body: JSON.stringify({ isBookable: false }) });
    expect((patched.body as { data: { staff: { isBookable: boolean } } }).data.staff.isBookable).toBe(false);
    expect((await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}`, { method: "DELETE", cookie: fix.cookies })).status).toBe(200);
  });

  it("rejects a staff member with neither membership nor party", async () => {
    const fix = await fixture("Empty Owner");
    const response = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff`, { method: "POST", cookie: fix.cookies, body: JSON.stringify({ displayName: "Nobody" }) });
    expect(response.status).toBe(400);
  });

  it("rejects services that reference another business's product", async () => {
    const fix = await fixture("Guard Owner");
    const partyId = await created(fix, "/parties", { kind: "person", displayName: "Guard Staff" }, (b) => b.data.party.id as string);
    const staff = await created(fix, "/staff", { partyId, displayName: "Guard" }, (b) => b.data.staff as { id: string });
    const response = await request(server.baseUrl, `/api/businesses/${fix.businessId}/staff/${staff.id}/services`, { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ services: [{ productId: randomUUID() }] }) });
    expect(response.status).toBe(400);
  });
});
