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
        }),
      },
    );
    expect(locationResponse.status).toBe(201);
    const location = entity<{ id: string; isDefault: boolean }>(
      locationResponse,
      "location",
    );
    expect(location.isDefault).toBe(true);

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
});
