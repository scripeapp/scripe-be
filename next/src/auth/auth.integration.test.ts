import { randomUUID } from "node:crypto";

let mockOutbox: {
  verification: { to: string; code: string }[];
  reset: { to: string; url: string }[];
};

jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => {
      mockOutbox.verification.push({ to, code });
    },
    sendPasswordResetEmail: (to: string, url: string) => {
      mockOutbox.reset.push({ to, url });
    },
  },
}));

import { sql } from "kysely";
import {
  closeDatabase,
  configureDatabaseGateway,
  createDatabaseGateway,
  getDatabase,
} from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { withIdentity } from "@/db/principal.js";
import { configurePoolErrorHandling, createDatabasePool } from "@/db/pool.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
const NEXT_PASSWORD = "N3wSup3rSecret!pass";

let server: TestServer;

function signUpBody(email: string, name = "Integration User") {
  return JSON.stringify({ name, email, password: PASSWORD });
}

async function emailVerified(userId: string): Promise<boolean> {
  const result = await sql<{ emailVerified: boolean }>`
    select "emailVerified" from auth.user where id = ${userId}
  `.execute(getDatabase());
  return result.rows[0]?.emailVerified ?? false;
}

async function sessionCount(userId: string): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as count from auth.session where "userId" = ${userId}
  `.execute(getDatabase());
  return Number(result.rows[0]?.count ?? 0);
}

async function profileFor(userId: string) {
  return withDatabaseContext(
    getDatabase(),
    withIdentity(randomUUID(), userId, null),
    async ({ transaction }) =>
      transaction
        .selectFrom("user_profiles")
        .select(["userId", "email", "name"])
        .where("userId", "=", userId)
        .executeTakeFirst(),
  );
}

function verificationCodeFor(email: string): string {
  const message = mockOutbox.verification.find((entry) => entry.to === email);
  if (!message) {
    throw new Error(`No verification code was sent to ${email}`);
  }
  return message.code;
}

beforeAll(async () => {
  mockOutbox = { verification: [], reset: [] };

  // Reachability also exercises the pool/gateway wiring before the suite runs.
  const pool = createDatabasePool();
  configurePoolErrorHandling(pool);
  configureDatabaseGateway(createDatabaseGateway(pool));
  await closeDatabase();

  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

describe("auth domain", () => {
  const email = `it-${randomUUID()}@example.com`;
  let userId = "";
  let verificationCode = "";

  it("signs up, creates the profile transactionally, and withholds a session until verified", async () => {
    const response = await request(server.baseUrl, "/api/auth/sign-up/email", {
      method: "POST",
      body: signUpBody(email),
    });

    expect(response.status).toBe(200);
    const user = (
      response.body as { user: { id: string; emailVerified: boolean } }
    ).user;
    userId = user.id;
    expect(user.emailVerified).toBe(false);
    expect(response.cookies).toBe("");

    verificationCode = verificationCodeFor(email);
    expect(verificationCode).toMatch(/^\d{6}$/);

    const profile = await profileFor(userId);
    expect(profile).toEqual({ userId, email, name: "Integration User" });
  });

  it("rejects sign-in before the email is verified", async () => {
    const response = await request(server.baseUrl, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects an incorrect verification code", async () => {
    const incorrectCode =
      verificationCode[0] === "0" ? `1${verificationCode.slice(1)}` : `0${verificationCode.slice(1)}`;

    const response = await request(
      server.baseUrl,
      "/api/auth/email-otp/verify-email",
      {
        method: "POST",
        body: JSON.stringify({ email, otp: incorrectCode }),
      },
    );
    expect(response.status).toBe(400);
    expect(await emailVerified(userId)).toBe(false);
  });

  it("verifies the email with the emailed code and starts a session", async () => {
    const response = await request(
      server.baseUrl,
      "/api/auth/email-otp/verify-email",
      {
        method: "POST",
        body: JSON.stringify({ email, otp: verificationCode }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.cookies).toContain("better-auth.session_token");
    expect(await emailVerified(userId)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const response = await request(server.baseUrl, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: "definitely-wrong" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a state-changing request from an untrusted origin", async () => {
    const response = await request(server.baseUrl, "/api/auth/sign-up/email", {
      method: "POST",
      body: signUpBody(`it-origin-${randomUUID()}@example.com`),
      origin: "http://evil.example",
    });
    expect(response.status).toBe(403);
  });

  it("signs in, serves the session, and revokes it on sign-out", async () => {
    const login = await request(server.baseUrl, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    expect(login.cookies).toContain("better-auth.session_token");

    const session = await request(server.baseUrl, "/api/auth/get-session", {
      cookie: login.cookies,
    });
    expect(session.status).toBe(200);
    expect((session.body as { user: { id: string } }).user.id).toBe(userId);

    const before = await sessionCount(userId);

    const logout = await request(server.baseUrl, "/api/auth/sign-out", {
      method: "POST",
      cookie: login.cookies,
    });
    expect(logout.status).toBe(200);

    const after = await request(server.baseUrl, "/api/auth/get-session", {
      cookie: login.cookies,
    });
    expect(after.body).toBeNull();
    expect(await sessionCount(userId)).toBe(before - 1);
  });

  it("ignores a tampered session cookie", async () => {
    const login = await request(server.baseUrl, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const tampered = login.cookies.replace(
      /better-auth\.session_token=(.)/,
      (_match, first: string) =>
        `better-auth.session_token=${first === "A" ? "B" : "A"}`,
    );

    const session = await request(server.baseUrl, "/api/auth/get-session", {
      cookie: tampered,
    });
    expect(session.body).toBeNull();
  });

  it("resets the password and accepts only the new one", async () => {
    const resetRequest = await request(
      server.baseUrl,
      "/api/auth/request-password-reset",
      {
        method: "POST",
        body: JSON.stringify({ email }),
      },
    );
    expect(resetRequest.status).toBe(200);

    const message = mockOutbox.reset.find((entry) => entry.to === email)!;
    const token = message.url.split("/reset-password/")[1]!.split("?")[0]!;

    const reset = await request(server.baseUrl, "/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ newPassword: NEXT_PASSWORD, token }),
    });
    expect(reset.status).toBe(200);

    const oldPassword = await request(server.baseUrl, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(oldPassword.status).toBe(401);

    const newPassword = await request(server.baseUrl, "/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: NEXT_PASSWORD }),
    });
    expect(newPassword.status).toBe(200);
  });

  it("cascades the profile when the user is deleted", async () => {
    await sql`delete from auth.user where id = ${userId}`.execute(getDatabase());
    expect(await profileFor(userId)).toBeUndefined();
  });
});
