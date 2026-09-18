import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";

let mockOutbox: {
  verification: { to: string; url: string }[];
  reset: { to: string; url: string }[];
};

jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationEmail: (to: string, url: string) => {
      mockOutbox.verification.push({ to, url });
    },
    sendPasswordResetEmail: (to: string, url: string) => {
      mockOutbox.reset.push({ to, url });
    },
  },
}));

import { sql } from "kysely";
import { createApp } from "@/app.js";
import {
  closeDatabase,
  configureDatabaseGateway,
  createDatabaseGateway,
  getDatabase,
} from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { withIdentity } from "@/db/principal.js";
import { configurePoolErrorHandling, createDatabasePool } from "@/db/pool.js";

interface Session {
  status: number;
  cookies: string;
  body: unknown;
}

const PASSWORD = "Sup3rSecret!pass";
const NEXT_PASSWORD = "N3wSup3rSecret!pass";

let server: Server;
let baseUrl: string;

function signUpBody(email: string, name = "Integration User") {
  return JSON.stringify({ name, email, password: PASSWORD });
}

async function api(
  path: string,
  init: {
    method?: string;
    body?: string;
    cookie?: string;
    origin?: string | null;
  } = {},
): Promise<Session> {
  const target = new URL(baseUrl);
  const headers: Record<string, string> = {};
  if (init.body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(init.body));
  }
  if (init.cookie) {
    headers.cookie = init.cookie;
  }
  const origin = init.origin === undefined ? baseUrl : init.origin;
  if (origin) {
    headers.origin = origin;
  }

  return new Promise<Session>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: init.method ?? "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          const cookies = (response.headers["set-cookie"] ?? [])
            .map((value) => value.split(";")[0])
            .join("; ");
          resolve({ status: response.statusCode ?? 0, cookies, body });
        });
      },
    );
    request.on("error", reject);
    if (init.body) {
      request.write(init.body);
    }
    request.end();
  });
}

async function emailVerified(userId: string): Promise<boolean> {
  const result = await sql<{ emailVerified: boolean }>`
    select "emailVerified" from auth.user where id = ${userId}
  `.execute(getDatabase());
  return result.rows[0]?.emailVerified ?? false;
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

beforeAll(async () => {
  mockOutbox = { verification: [], reset: [] };

  // The test server binds an ephemeral port; trust loopback so fetch's
  // automatic Origin header is accepted while untrusted origins still fail.
  process.env.AUTH_TRUSTED_ORIGINS =
    "http://127.0.0.1:*,http://localhost:*";

  const pool = createDatabasePool();
  configurePoolErrorHandling(pool);
  configureDatabaseGateway(createDatabaseGateway(pool));

  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  await closeDatabase();
});

describe("auth domain", () => {
  const email = `it-${randomUUID()}@example.com`;
  let userId = "";

  it("signs up, creates the profile transactionally, and withholds a session until verified", async () => {
    const response = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: signUpBody(email),
    });

    expect(response.status).toBe(200);
    const user = (response.body as { user: { id: string; emailVerified: boolean } })
      .user;
    userId = user.id;
    expect(user.emailVerified).toBe(false);
    expect(response.cookies).toBe("");

    const message = mockOutbox.verification.find((entry) => entry.to === email);
    expect(message).toBeDefined();
    expect(new URL(message!.url).searchParams.get("token")).toBeTruthy();

    const profile = await profileFor(userId);
    expect(profile).toEqual({ userId, email, name: "Integration User" });
  });

  it("rejects sign-in before the email is verified", async () => {
    const response = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(403);
  });

  it("verifies the email with the emitted token", async () => {
    const message = mockOutbox.verification.find((entry) => entry.to === email)!;
    const token = new URL(message.url).searchParams.get("token")!;

    const response = await api(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect([200, 302]).toContain(response.status);
    expect(await emailVerified(userId)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const response = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: "definitely-wrong" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a state-changing request from an untrusted origin", async () => {
    const response = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: signUpBody(`it-origin-${randomUUID()}@example.com`),
      origin: "http://evil.example",
    });
    expect(response.status).toBe(403);
  });

  it("signs in, serves the session, and revokes it on sign-out", async () => {
    const login = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    expect(login.cookies).toContain("better-auth.session_token");

    const session = await api("/api/auth/get-session", { cookie: login.cookies });
    expect(session.status).toBe(200);
    expect((session.body as { user: { id: string } }).user.id).toBe(userId);

    const logout = await api("/api/auth/sign-out", {
      method: "POST",
      cookie: login.cookies,
    });
    expect(logout.status).toBe(200);

    const after = await api("/api/auth/get-session", { cookie: login.cookies });
    expect(after.body).toBeNull();

    const remaining = await sql<{ count: string }>`
      select count(*)::text as count from auth.session where "userId" = ${userId}
    `.execute(getDatabase());
    expect(remaining.rows[0]?.count).toBe("0");
  });

  it("ignores a tampered session cookie", async () => {
    const login = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const tampered = login.cookies.replace(
      /better-auth\.session_token=(.)/,
      (_match, first: string) =>
        `better-auth.session_token=${first === "A" ? "B" : "A"}`,
    );

    const session = await api("/api/auth/get-session", { cookie: tampered });
    expect(session.body).toBeNull();
  });

  it("resets the password and accepts only the new one", async () => {
    const request = await api("/api/auth/request-password-reset", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    expect(request.status).toBe(200);

    const message = mockOutbox.reset.find((entry) => entry.to === email)!;
    const token = message.url.split("/reset-password/")[1]!.split("?")[0]!;

    const reset = await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ newPassword: NEXT_PASSWORD, token }),
    });
    expect(reset.status).toBe(200);

    const oldPassword = await api("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(oldPassword.status).toBe(401);

    const newPassword = await api("/api/auth/sign-in/email", {
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
