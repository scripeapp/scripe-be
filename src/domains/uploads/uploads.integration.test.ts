import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

// Never hit real object storage from a test — mocked the same way
// shared/email.js is mocked everywhere else in this suite, regardless of
// what credentials a local .env happens to contain.
const headResults = new Map<string, { exists: boolean; sizeBytes?: number }>();
const deletedKeys: string[] = [];
jest.mock("@/integrations/r2.js", () => ({
  objectStorage: {
    createPresignedUploadUrl: (key: string) => Promise.resolve({ uploadUrl: `https://mock-r2.test/${key}`, expiresAt: new Date(Date.now() + 600_000) }),
    createPresignedDownloadUrl: (key: string) => Promise.resolve(`https://mock-r2.test/${key}?download`),
    headObject: (key: string) => Promise.resolve(headResults.get(key) ?? { exists: false }),
    deleteObject: (key: string) => {
      deletedKeys.push(key);
      return Promise.resolve();
    },
  },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());

async function authenticate(label: string): Promise<{ cookies: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return { cookies: verified.cookies };
}

describe("uploads domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/uploads")).status).toBe(401);
  });

  it("creates a personal upload, confirms it against the mocked object storage, and lists it", async () => {
    const user = await authenticate("Upload User");

    const created = await request(server.baseUrl, "/api/uploads", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ purpose: "avatar", mimeType: "image/png", sizeBytes: "2048" }),
    });
    expect(created.status).toBe(201);
    const body = created.body as { data: { upload: { id: string; objectKey: string; status: string }; uploadUrl: string } };
    expect(body.data.upload.status).toBe("pending");
    expect(body.data.uploadUrl).toContain(body.data.upload.objectKey);

    // Simulate the client having actually PUT the file to the presigned URL.
    headResults.set(body.data.upload.objectKey, { exists: true, sizeBytes: 2048 });

    const confirmed = await request(server.baseUrl, `/api/uploads/${body.data.upload.id}/confirm`, { method: "POST", cookie: user.cookies });
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as { data: { upload: { status: string } } }).data.upload.status).toBe("confirmed");

    const fetched = await request(server.baseUrl, `/api/uploads/${body.data.upload.id}`, { cookie: user.cookies });
    expect(fetched.status).toBe(200);
    expect((fetched.body as { data: { upload: { downloadUrl: string | null } } }).data.upload.downloadUrl).toContain("download");

    const list = await request(server.baseUrl, "/api/uploads", { cookie: user.cookies });
    expect((list.body as { data: { uploads: { id: string }[] } }).data.uploads.map((u) => u.id)).toContain(body.data.upload.id);
  });

  it("fails confirmation when the object was never actually uploaded", async () => {
    const user = await authenticate("Never Uploaded User");
    const created = await request(server.baseUrl, "/api/uploads", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ purpose: "other", mimeType: "application/pdf", sizeBytes: "4096" }),
    });
    const uploadId = (created.body as { data: { upload: { id: string } } }).data.upload.id;

    // headResults has no entry for this key -> objectStorage reports exists:false.
    const confirmed = await request(server.baseUrl, `/api/uploads/${uploadId}/confirm`, { method: "POST", cookie: user.cookies });
    expect(confirmed.status).toBe(409);

    const fetched = await request(server.baseUrl, `/api/uploads/${uploadId}`, { cookie: user.cookies });
    expect((fetched.body as { data: { upload: { status: string } } }).data.upload.status).toBe("failed");
  });

  it("deletes an upload and calls through to object storage", async () => {
    const user = await authenticate("Delete Upload User");
    const created = await request(server.baseUrl, "/api/uploads", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ purpose: "avatar", mimeType: "image/jpeg", sizeBytes: "1024" }),
    });
    const upload = (created.body as { data: { upload: { id: string; objectKey: string } } }).data.upload;

    const removed = await request(server.baseUrl, `/api/uploads/${upload.id}`, { method: "DELETE", cookie: user.cookies });
    expect(removed.status).toBe(200);
    expect(deletedKeys).toContain(upload.objectKey);

    const fetched = await request(server.baseUrl, `/api/uploads/${upload.id}`, { cookie: user.cookies });
    expect((fetched.body as { data: { upload: { status: string } } }).data.upload.status).toBe("deleted");
  });

  it("rejects a mime type outside the allowlist", async () => {
    const user = await authenticate("Bad Mime User");
    const response = await request(server.baseUrl, "/api/uploads", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ purpose: "other", mimeType: "application/x-msdownload", sizeBytes: "1024" }),
    });
    expect(response.status).toBe(400);
  });

  it("isolates personal uploads between users", async () => {
    const owner = await authenticate("Isolated Upload Owner");
    const outsider = await authenticate("Isolated Upload Outsider");
    const created = await request(server.baseUrl, "/api/uploads", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ purpose: "avatar", mimeType: "image/png", sizeBytes: "1024" }),
    });
    const uploadId = (created.body as { data: { upload: { id: string } } }).data.upload.id;

    const outsiderGet = await request(server.baseUrl, `/api/uploads/${uploadId}`, { cookie: outsider.cookies });
    expect(outsiderGet.status).toBe(404);
  });
});
