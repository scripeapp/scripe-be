import { evaluateDownloadWindow } from "../services/digital-product.service";
import { DigitalCoreSchema } from "../types/store";

const issuedAt = "2026-08-01T00:00:00.000Z";

describe("digital entitlement download window", () => {
  it("is unlimited (never expires) when no expiry hours are configured", () => {
    const result = evaluateDownloadWindow({
      firstIssuedAt: issuedAt,
      expiryHours: null,
      now: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(result.expired).toBe(false);
    expect(result.expiresAt).toBeNull();
  });

  it("is active while the current time is inside the window", () => {
    const result = evaluateDownloadWindow({
      firstIssuedAt: issuedAt,
      expiryHours: 24,
      now: new Date("2026-08-01T12:00:00.000Z"),
    });

    expect(result.expired).toBe(false);
    expect(result.expiresAt?.toISOString()).toBe("2026-08-02T00:00:00.000Z");
  });

  it("is active exactly at the expiry boundary (expiry is exclusive)", () => {
    const result = evaluateDownloadWindow({
      firstIssuedAt: issuedAt,
      expiryHours: 24,
      now: new Date("2026-08-02T00:00:00.000Z"),
    });

    expect(result.expired).toBe(false);
  });

  it("is expired once the current time passes the window", () => {
    const result = evaluateDownloadWindow({
      firstIssuedAt: issuedAt,
      expiryHours: 24,
      now: new Date("2026-08-02T00:00:01.000Z"),
    });

    expect(result.expired).toBe(true);
  });

  it("is expired immediately when zero-hour access is configured", () => {
    const result = evaluateDownloadWindow({
      firstIssuedAt: issuedAt,
      expiryHours: 0,
      now: new Date("2026-08-01T00:00:00.001Z"),
    });

    expect(result.expired).toBe(true);
  });

  it("computes the window from the single first-issued timestamp (repeat issuance cannot extend it)", () => {
    // A repeat link request must not get a later window than the first one.
    const firstIssuedAt = "2026-08-01T00:00:00.000Z";
    const laterRequest = evaluateDownloadWindow({
      firstIssuedAt, // the authoritative value the DB returns on conflict
      expiryHours: 24,
      now: new Date("2026-08-01T18:00:00.000Z"),
    });
    const forgedLaterIssued = evaluateDownloadWindow({
      firstIssuedAt: "2026-08-01T12:00:00.000Z",
      expiryHours: 24,
      now: new Date("2026-08-01T18:00:00.000Z"),
    });

    expect(laterRequest.expiresAt?.toISOString()).toBe(
      "2026-08-02T00:00:00.000Z",
    );
    expect(forgedLaterIssued.expiresAt?.toISOString()).toBe(
      "2026-08-02T12:00:00.000Z",
    );
  });

  it("keeps the window anchored on the entitlement even when now is far earlier", () => {
    const result = evaluateDownloadWindow({
      firstIssuedAt: issuedAt,
      expiryHours: 24,
      now: new Date("2026-08-01T01:00:00.000Z"),
    });

    expect(result.expired).toBe(false);
  });
});

describe("digital / ebook download persistence schema", () => {
  it("accepts a legacy full public URL as the digital download reference", () => {
    const result = DigitalCoreSchema.safeParse({
      download_url:
        "https://pub-abc.r2.dev/stores/11111111-1111-4111-8111-111111111111/products/22222222-2222-4222-8222-222222222222/files/file.pdf",
    });

    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data.download_url).toContain("https://pub-abc.r2.dev/");
  });

  it("rejects a bare R2 key path as a digital download reference", () => {
    // The DTO requires a full URL: a bare storage key must never be
    // persisted as `download_url` (it encodes the durable-URL policy at the
    // boundary so no key path can silently take the place of a URL).
    const result = DigitalCoreSchema.safeParse({
      download_url:
        "stores/11111111-1111-4111-8111-111111111111/products/22222222-2222-4222-8222-222222222222/files/book.pdf",
    });

    expect(result.success).toBe(false);
  });

  it("accepts legacy per-format ebook file URLs in the unified digital shape", () => {
    const result = DigitalCoreSchema.safeParse({
      primary_format: "pdf",
      has_sample: false,
      files: {
        pdf_url:
          "https://pub-abc.r2.dev/stores/11111111-1111-4111-8111-111111111111/products/a/files/a.pdf",
        epub_url: null,
        mobi_url: null,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.files?.pdf_url).toContain("https://pub-abc.r2.dev/");
      expect(result.data.files?.epub_url).toBeNull();
    }
  });
});
