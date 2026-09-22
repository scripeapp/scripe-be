import { randomUUID } from "node:crypto";

let mockVerificationCodes: { to: string; code: string }[];

jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => {
      mockVerificationCodes.push({ to, code });
    },
    sendPasswordResetEmail: () => {},
  },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";

let server: TestServer;

beforeAll(async () => {
  mockVerificationCodes = [];
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

async function signUpAndAuthenticate(email: string, name: string): Promise<string> {
  const signUp = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name, email, password: PASSWORD }),
  });
  expect(signUp.status).toBe(200);

  const message = mockVerificationCodes.find((entry) => entry.to === email);
  if (!message) {
    throw new Error(`No verification code was sent to ${email}`);
  }

  const verify = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: message.code }),
  });
  expect(verify.status).toBe(200);
  return verify.cookies;
}

describe("profiles domain", () => {
  it("rejects /api/me without a session", async () => {
    const response = await request(server.baseUrl, "/api/me");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: "AUTH_REQUIRED",
        message: "Authentication required",
      },
    });
  });

  it("rejects /api/me with a forged session cookie", async () => {
    const response = await request(server.baseUrl, "/api/me", {
      cookie: "better-auth.session_token=forged.value",
    });
    expect(response.status).toBe(401);
  });

  it("returns the current user for an authenticated session", async () => {
    const email = `me-${randomUUID()}@example.com`;
    const cookies = await signUpAndAuthenticate(email, "Profile User");

    const response = await request(server.baseUrl, "/api/me", { cookie: cookies });
    expect(response.status).toBe(200);

    const user = (
      response.body as {
        success: true;
        data: {
          user: {
            id: string;
            email: string;
            name: string;
            image: string | null;
            emailVerified: boolean;
            firstName: string;
            lastName: string;
            username: string | null;
            bio: string;
            website: string;
            location: string;
            phoneNumber: string;
            gender: string;
            socialLinks: Record<string, unknown>;
            accountStatus: string;
            accountType: string;
            preferences: Record<string, unknown>;
            createdAt: string;
            updatedAt: string;
          };
        };
      }
    ).data.user;
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.email).toBe(email);
    expect(user.name).toBe("Profile User");
    expect(user.image).toBeNull();
    expect(user.emailVerified).toBe(true);
    expect(user.firstName).toBe("");
    expect(user.lastName).toBe("");
    expect(user.username).toBeNull();
    expect(user.bio).toBe("");
    expect(user.website).toBe("");
    expect(user.location).toBe("");
    expect(user.phoneNumber).toBe("");
    expect(user.gender).toBe("");
    expect(user.socialLinks).toEqual({});
    expect(user.accountStatus).toBe("active");
    expect(user.accountType).toBe("personal");
    expect(user.preferences).toEqual({});
    expect(Date.parse(user.createdAt)).not.toBeNaN();
    expect(Date.parse(user.updatedAt)).not.toBeNaN();
  });

  it("rejects PATCH /api/me without a session", async () => {
    const response = await request(server.baseUrl, "/api/me", {
      method: "PATCH",
      body: JSON.stringify({ bio: "hi" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects an empty patch", async () => {
    const email = `me-patch-empty-${randomUUID()}@example.com`;
    const cookies = await signUpAndAuthenticate(email, "Patch Empty");

    const response = await request(server.baseUrl, "/api/me", {
      method: "PATCH",
      cookie: cookies,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a malformed website and an invalid username", async () => {
    const email = `me-patch-invalid-${randomUUID()}@example.com`;
    const cookies = await signUpAndAuthenticate(email, "Patch Invalid");

    const badWebsite = await request(server.baseUrl, "/api/me", {
      method: "PATCH",
      cookie: cookies,
      body: JSON.stringify({ website: "not-a-url" }),
    });
    expect(badWebsite.status).toBe(400);

    const badUsername = await request(server.baseUrl, "/api/me", {
      method: "PATCH",
      cookie: cookies,
      body: JSON.stringify({ username: "a" }),
    });
    expect(badUsername.status).toBe(400);
  });

  it("updates only the fields sent, leaving the rest untouched", async () => {
    const email = `me-patch-${randomUUID()}@example.com`;
    const cookies = await signUpAndAuthenticate(email, "Patch User");
    const username = `patchuser${randomUUID().slice(0, 8)}`;

    const first = await request(server.baseUrl, "/api/me", {
      method: "PATCH",
      cookie: cookies,
      body: JSON.stringify({
        bio: "Building things",
        username,
        website: "https://example.com",
        socialLinks: { twitter: "example" },
      }),
    });
    expect(first.status).toBe(200);
    const firstUser = (first.body as { data: { user: Record<string, unknown> } }).data.user;
    expect(firstUser.bio).toBe("Building things");
    expect(firstUser.username).toBe(username);
    expect(firstUser.website).toBe("https://example.com");
    expect(firstUser.socialLinks).toEqual({ twitter: "example" });
    expect(firstUser.name).toBe("Patch User");

    const second = await request(server.baseUrl, "/api/me", {
      method: "PATCH",
      cookie: cookies,
      body: JSON.stringify({ location: "Lagos" }),
    });
    expect(second.status).toBe(200);
    const secondUser = (second.body as { data: { user: Record<string, unknown> } }).data.user;
    expect(secondUser.location).toBe("Lagos");
    // Fields not sent in this second patch survive from the first.
    expect(secondUser.bio).toBe("Building things");
    expect(secondUser.username).toBe(username);
  });

  it("rejects a username already taken by another user", async () => {
    const usernameOwner = `me-patch-taken-a-${randomUUID()}@example.com`;
    const ownerCookies = await signUpAndAuthenticate(usernameOwner, "Owner");
    const takenUsername = `taken${randomUUID().slice(0, 8)}`;

    const claim = await request(server.baseUrl, "/api/me", {
      method: "PATCH",
      cookie: ownerCookies,
      body: JSON.stringify({ username: takenUsername }),
    });
    expect(claim.status).toBe(200);

    const contender = `me-patch-taken-b-${randomUUID()}@example.com`;
    const contenderCookies = await signUpAndAuthenticate(contender, "Contender");

    const conflict = await request(server.baseUrl, "/api/me", {
      method: "PATCH",
      cookie: contenderCookies,
      body: JSON.stringify({ username: takenUsername }),
    });
    expect(conflict.status).toBe(409);
  });
});
