import { loadEnvironment } from "@/shared/environment.js";

const MINIMAL_VALID = {
  DATABASE_URL: "postgres://surge_app@localhost:5432/surge_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4000",
};

describe("loadEnvironment", () => {
  it("accepts the minimal valid configuration with defaults", () => {
    const env = loadEnvironment({ ...MINIMAL_VALID });

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.DATABASE_SSL_MODE).toBe("disable");
    expect(env.ALLOW_DATABASE_RESET).toBe(false);
    expect(env.AUTH_COOKIE_DOMAIN).toBe("localhost");
    expect(env.AUTH_TRUSTED_ORIGINS).toEqual([]);
  });

  it("requires an explicit boolean string before enabling database reset", () => {
    expect(
      loadEnvironment({ ...MINIMAL_VALID, ALLOW_DATABASE_RESET: "true" })
        .ALLOW_DATABASE_RESET,
    ).toBe(true);
    expect(() =>
      loadEnvironment({ ...MINIMAL_VALID, ALLOW_DATABASE_RESET: "yes" }),
    ).toThrow(/Invalid environment configuration/);
  });

  it("rejects a missing required database URL", () => {
    const { BETTER_AUTH_SECRET, BETTER_AUTH_URL } = MINIMAL_VALID;
    expect(() => loadEnvironment({ BETTER_AUTH_SECRET, BETTER_AUTH_URL })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("rejects a short BETTER_AUTH_SECRET", () => {
    expect(() =>
      loadEnvironment({ ...MINIMAL_VALID, BETTER_AUTH_SECRET: "too-short" }),
    ).toThrow(/Invalid environment configuration/);
  });

  it("refuses a superuser migration URL", () => {
    expect(() =>
      loadEnvironment({
        ...MINIMAL_VALID,
        DATABASE_MIGRATE_URL: "postgres://postgres@localhost:5432/surge_test",
      }),
    ).toThrow(/Migrations must never connect as the postgres superuser/);
  });

  it("parses AUTH_TRUSTED_ORIGINS into a trimmed list", () => {
    const env = loadEnvironment({
      ...MINIMAL_VALID,
      AUTH_TRUSTED_ORIGINS: " https://app.example.com ,https://admin.example.com",
    });

    expect(env.AUTH_TRUSTED_ORIGINS).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });
});
