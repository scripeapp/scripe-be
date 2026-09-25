import { createHmac } from "node:crypto";
import { verifyAnchorSignature, verifyBrailsSignature, verifyFlutterwaveSignature, verifyPaystackSignature } from "./provider-events.signatures.js";

const MINIMAL_ENV = {
  DATABASE_URL: "postgres://scripe_app@localhost:5432/scripe_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4000",
};

describe("provider-events signature verification", () => {
  const originalEnv = process.env;

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("verifyPaystackSignature", () => {
    it("accepts a correctly computed HMAC-SHA512 signature and rejects a wrong one", () => {
      process.env = { ...MINIMAL_ENV, PAYSTACK_SECRET_KEY: "sk_test_123" };
      const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { reference: "ref1" } }));
      const validSignature = createHmac("sha512", "sk_test_123").update(body).digest("hex");

      expect(verifyPaystackSignature(body, validSignature)).toBe(true);
      expect(verifyPaystackSignature(body, "wrong-signature")).toBe(false);
      expect(verifyPaystackSignature(body, undefined)).toBe(false);
    });

    it("rejects when PAYSTACK_SECRET_KEY isn't configured", () => {
      process.env = { ...MINIMAL_ENV };
      const body = Buffer.from("{}");
      expect(verifyPaystackSignature(body, "anything")).toBe(false);
    });
  });

  describe("verifyFlutterwaveSignature", () => {
    it("compares the header directly against the static webhook hash", () => {
      process.env = { ...MINIMAL_ENV, FLW_WEBHOOK_HASH: "my-static-hash" };
      expect(verifyFlutterwaveSignature("my-static-hash")).toBe(true);
      expect(verifyFlutterwaveSignature("wrong-hash")).toBe(false);
      expect(verifyFlutterwaveSignature(undefined)).toBe(false);
    });
  });

  describe("verifyAnchorSignature", () => {
    it("accepts a correctly computed Base64(HMAC-SHA1) signature and rejects a wrong one", () => {
      process.env = { ...MINIMAL_ENV, ANCHOR_WEBHOOK_TOKEN: "anchor-token" };
      const body = Buffer.from(JSON.stringify({ type: "customer.identification.approved", data: { id: "cust_1" } }));
      const validSignature = createHmac("sha1", "anchor-token").update(body).digest("base64");

      expect(verifyAnchorSignature(body, validSignature)).toBe(true);
      expect(verifyAnchorSignature(body, "d29uZw==")).toBe(false);
      expect(verifyAnchorSignature(body, undefined)).toBe(false);
    });
  });

  describe("verifyBrailsSignature", () => {
    it("accepts a correctly computed HMAC-SHA512 signature and rejects a wrong one", () => {
      process.env = { ...MINIMAL_ENV, BRAILS_WEBHOOK_SECRET: "brails-secret" };
      const body = Buffer.from(JSON.stringify({ event: "payout.transfer.success", data: { id: "payout_1" } }));
      const validSignature = createHmac("sha512", "brails-secret").update(body).digest("hex");

      expect(verifyBrailsSignature(body, validSignature)).toBe(true);
      expect(verifyBrailsSignature(body, "wrong")).toBe(false);
      expect(verifyBrailsSignature(body, undefined)).toBe(false);
    });
  });
});
