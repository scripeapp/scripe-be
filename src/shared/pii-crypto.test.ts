import { decryptPii, encryptPii, maskIdentifier } from "./pii-crypto.js";

describe("pii-crypto", () => {
  it("round-trips and never stores the plain value", () => {
    const encrypted = encryptPii("22222222226");
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain("22222222226");
    expect(decryptPii(encrypted)).toBe("22222222226");
    expect(encryptPii("22222222226")).not.toBe(encrypted);
  });

  it("reads legacy plain-text values unchanged and passes nulls through", () => {
    expect(decryptPii("12345678901")).toBe("12345678901");
    expect(decryptPii(null)).toBeNull();
    expect(encryptPii(undefined)).toBeNull();
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptPii("12345678901");
    const tampered = `${encrypted.slice(0, -4)}AAAA`;
    expect(() => decryptPii(tampered)).toThrow();
  });

  it("masks all but the last four characters", () => {
    expect(maskIdentifier("22222222226")).toBe("*******2226");
    expect(maskIdentifier(null)).toBeNull();
  });
});
