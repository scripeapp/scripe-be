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
});
