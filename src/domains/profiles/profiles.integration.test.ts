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

// Never hit real object storage from a test — mocked the same way uploads.integration.test.ts does.
const headResults = new Map<string, { exists: boolean; sizeBytes?: number }>();
jest.mock("@/integrations/r2.js", () => ({
  objectStorage: {
    createPresignedUploadUrl: (key: string) => Promise.resolve({ uploadUrl: `https://mock-r2.test/${key}`, expiresAt: new Date(Date.now() + 600_000) }),
    createPresignedDownloadUrl: (key: string) => Promise.resolve(`https://mock-r2.test/${key}?download`),
    headObject: (key: string) => Promise.resolve(headResults.get(key) ?? { exists: false }),
    deleteObject: () => Promise.resolve(),
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

  async function createConfirmedUpload(cookies: string, purpose: string): Promise<string> {
    const created = await request(server.baseUrl, "/api/uploads", {
      method: "POST",
      cookie: cookies,
      body: JSON.stringify({ purpose, mimeType: "image/png", sizeBytes: "1024" }),
    });
    expect(created.status).toBe(201);
    const upload = (created.body as { data: { upload: { id: string; objectKey: string } } }).data.upload;
    headResults.set(upload.objectKey, { exists: true, sizeBytes: 1024 });

    const confirmed = await request(server.baseUrl, `/api/uploads/${upload.id}/confirm`, {
      method: "POST",
      cookie: cookies,
    });
    expect(confirmed.status).toBe(200);
    return upload.id;
  }

  it("has no avatar until one is set", async () => {
    const email = `me-avatar-none-${randomUUID()}@example.com`;
    const cookies = await signUpAndAuthenticate(email, "No Avatar");

    const profile = await request(server.baseUrl, "/api/me", { cookie: cookies });
    const user = (profile.body as { data: { user: { id: string; avatarUrl: string | null } } }).data.user;
    expect(user.avatarUrl).toBeNull();

    const missing = await request(server.baseUrl, `/api/users/${user.id}/avatar`);
    expect(missing.status).toBe(404);
  });

  it("sets an avatar from a confirmed upload and serves it publicly, unauthenticated", async () => {
    const email = `me-avatar-${randomUUID()}@example.com`;
    const cookies = await signUpAndAuthenticate(email, "Avatar User");
    const uploadId = await createConfirmedUpload(cookies, "avatar");

    const set = await request(server.baseUrl, "/api/me/avatar", {
      method: "PATCH",
      cookie: cookies,
      body: JSON.stringify({ uploadId }),
    });
    expect(set.status).toBe(200);
    const setUser = (set.body as { data: { user: { id: string; avatarUrl: string | null } } }).data.user;
    expect(setUser.avatarUrl).toBe(`/api/users/${setUser.id}/avatar`);

    // Anonymous — no cookie — because a confirmed avatar is public.
    const served = await request(server.baseUrl, `/api/users/${setUser.id}/avatar`);
    expect(served.status).toBe(302);
  });

  it("rejects setting an avatar from an unconfirmed upload", async () => {
    const email = `me-avatar-unconfirmed-${randomUUID()}@example.com`;
    const cookies = await signUpAndAuthenticate(email, "Unconfirmed Avatar");

    const created = await request(server.baseUrl, "/api/uploads", {
      method: "POST",
      cookie: cookies,
      body: JSON.stringify({ purpose: "avatar", mimeType: "image/png", sizeBytes: "1024" }),
    });
    const uploadId = (created.body as { data: { upload: { id: string } } }).data.upload.id;

    const set = await request(server.baseUrl, "/api/me/avatar", {
      method: "PATCH",
      cookie: cookies,
      body: JSON.stringify({ uploadId }),
    });
    expect(set.status).toBe(409);
  });

  it("rejects setting an avatar from a wrong-purpose upload", async () => {
    const email = `me-avatar-wrong-purpose-${randomUUID()}@example.com`;
    const cookies = await signUpAndAuthenticate(email, "Wrong Purpose");
    const uploadId = await createConfirmedUpload(cookies, "other");

    const set = await request(server.baseUrl, "/api/me/avatar", {
      method: "PATCH",
      cookie: cookies,
      body: JSON.stringify({ uploadId }),
    });
    expect(set.status).toBe(409);
  });

  it("rejects setting an avatar from another user's upload", async () => {
    const ownerEmail = `me-avatar-owner-${randomUUID()}@example.com`;
    const ownerCookies = await signUpAndAuthenticate(ownerEmail, "Upload Owner");
    const uploadId = await createConfirmedUpload(ownerCookies, "avatar");

    const otherEmail = `me-avatar-other-${randomUUID()}@example.com`;
    const otherCookies = await signUpAndAuthenticate(otherEmail, "Other User");

    const set = await request(server.baseUrl, "/api/me/avatar", {
      method: "PATCH",
      cookie: otherCookies,
      body: JSON.stringify({ uploadId }),
    });
    expect(set.status).toBe(404);
  });
});
