/**
 * Mocks `fetch` and verifies request shaping + response mapping offline —
 * same approach as checkout-gateways.test.ts / payment-providers.test.ts.
 */
import { DevMessageProvider } from "./dev-message-provider.js";
import { MetaCloudMessageProvider } from "./meta-cloud-message-provider.js";
import { TermiiMessageProvider } from "./termii-message-provider.js";
import { TwilioMessageProvider } from "./twilio-message-provider.js";

const MINIMAL_ENV = {
  DATABASE_URL: "postgres://surge_app@localhost:5432/surge_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4000",
};

describe("DevMessageProvider", () => {
  it("accepts every message without calling out", async () => {
    const result = await new DevMessageProvider().send({ to: "+15551234567", body: "hi" });
    expect(result.accepted).toBe(true);
    expect(result.providerMessageId).toMatch(/^dev-/);
  });
});

describe("TermiiMessageProvider", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...MINIMAL_ENV, TERMII_API_KEY: "key", TERMII_SENDER_ID: "Surge", TERMII_BASE_URL: "https://api.ng.termii.com" };
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws SERVICE_UNAVAILABLE when not configured", async () => {
    process.env = { ...MINIMAL_ENV };
    await expect(new TermiiMessageProvider("sms").send({ to: "+15551234567", body: "hi" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("sends sms with channel=generic and maps a successful response", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ code: "ok", message_id: "msg-1" }) });
    global.fetch = fetchMock;

    const result = await new TermiiMessageProvider("sms").send({ to: "+15551234567", body: "hi" });
    expect(result).toEqual({ accepted: true, providerMessageId: "msg-1", errorMessage: null });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.ng.termii.com/api/sms/send");
    const body = JSON.parse(options.body as string) as { channel: string; to: string };
    expect(body.channel).toBe("generic");
    expect(body.to).toBe("+15551234567");
  });

  it("uses channel=whatsapp for the whatsapp channel", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ code: "ok", message_id: "msg-2" }) });
    global.fetch = fetchMock;

    await new TermiiMessageProvider("whatsapp").send({ to: "+15551234567", body: "hi" });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(options.body as string) as { channel: string }).channel).toBe("whatsapp");
  });

  it("treats a rejected code as a non-accepted result, not a thrown error", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ code: "err", message: "invalid number" }) });
    global.fetch = fetchMock;

    const result = await new TermiiMessageProvider("sms").send({ to: "bad", body: "hi" });
    expect(result).toEqual({ accepted: false, providerMessageId: null, errorMessage: "invalid number" });
  });

  it("throws on a transient 5xx so the caller can distinguish it from a rejection", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
    global.fetch = fetchMock;

    await expect(new TermiiMessageProvider("sms").send({ to: "+15551234567", body: "hi" })).rejects.toThrow(/transiently/);
  });
});

describe("TwilioMessageProvider", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...MINIMAL_ENV, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "token", TWILIO_FROM_NUMBER: "+15550000000" };
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws SERVICE_UNAVAILABLE when not configured", async () => {
    process.env = { ...MINIMAL_ENV };
    await expect(new TwilioMessageProvider().send({ to: "+15551234567", body: "hi" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("sends with basic auth and form-encoded body, mapping the sid", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ sid: "SM123", status: "queued" }) });
    global.fetch = fetchMock;

    const result = await new TwilioMessageProvider().send({ to: "+15551234567", body: "hi" });
    expect(result).toEqual({ accepted: true, providerMessageId: "SM123", errorMessage: null });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect((options.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });
});

describe("MetaCloudMessageProvider", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...MINIMAL_ENV, META_WA_TOKEN: "token", META_WA_PHONE_NUMBER_ID: "12345" };
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it("sends a text session message and maps the message id", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ messages: [{ id: "wamid.123" }] }) });
    global.fetch = fetchMock;

    const result = await new MetaCloudMessageProvider().send({ to: "+15551234567", body: "hi" });
    expect(result).toEqual({ accepted: true, providerMessageId: "wamid.123", errorMessage: null });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v22.0/12345/messages");
  });
});
