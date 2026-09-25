/**
 * Presigned URL generation is pure local SigV4 signing — no network call —
 * so this can run for real, offline, unlike every other test in this
 * backend that needs a live Postgres. Deliberately uses fake credentials
 * set per test, never whatever a real .env happens to contain.
 */

const MINIMAL_ENV = {
  DATABASE_URL: "postgres://scripe_app@localhost:5432/scripe_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4000",
};

describe("objectStorage (R2)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...MINIMAL_ENV };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws SERVICE_UNAVAILABLE rather than pretending to work when R2 is not configured", async () => {
    const { objectStorage } = await import("./r2.js");
    await expect(objectStorage.createPresignedUploadUrl("uploads/test/key.jpg", "image/jpeg", 1024)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("generates a presigned upload URL", async () => {
    process.env.R2_ACCOUNT_ID = "test-account-id";
    process.env.R2_ACCESS_KEY_ID = "test-access-key-id";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-access-key";
    process.env.R2_BUCKET_NAME = "test-bucket";
    const { objectStorage } = await import("./r2.js");

    const result = await objectStorage.createPresignedUploadUrl("uploads/test/key.jpg", "image/jpeg", 1024);

    expect(result.uploadUrl).toContain("test-account-id.r2.cloudflarestorage.com");
    expect(result.uploadUrl).toContain("test-bucket");
    expect(result.uploadUrl).toContain("X-Amz-Signature=");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("generates a presigned download URL", async () => {
    process.env.R2_ACCOUNT_ID = "test-account-id";
    process.env.R2_ACCESS_KEY_ID = "test-access-key-id";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-access-key";
    process.env.R2_BUCKET_NAME = "test-bucket";
    const { objectStorage } = await import("./r2.js");

    const url = await objectStorage.createPresignedDownloadUrl("uploads/test/key.jpg");

    expect(url).toContain("test-account-id.r2.cloudflarestorage.com");
    expect(url).toContain("X-Amz-Signature=");
  });

  it("rejects a partially configured R2 at the environment-validation layer", async () => {
    process.env.R2_ACCOUNT_ID = "test-account-id";
    // R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME intentionally left unset —
    // caught by environment.ts's superRefine before r2.ts's own "not configured" check runs.
    const { objectStorage } = await import("./r2.js");
    await expect(objectStorage.createPresignedUploadUrl("uploads/test/key.jpg", "image/jpeg", 1024)).rejects.toThrow(/must be set together/);
  });
});
