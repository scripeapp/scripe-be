import { getChannelProvider } from "../services/channel-provider";

const originalEnvironment = process.env;

describe("Termii channel provider", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = {
      ...originalEnvironment,
      NODE_ENV: "test",
      TERMII_API_KEY: "test-key",
      TERMII_SENDER_ID: "Hilaq",
      TERMII_BASE_URL: "https://termii.example",
      SMS_PROVIDER: "termii",
      WHATSAPP_PROVIDER: "termii",
    };
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it("uses the generic route for SMS", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message_id: "sms-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await getChannelProvider("sms").send({
      to: "2348031234567",
      body: "Hello",
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(request.channel).toBe("generic");
    expect(request.api_key).toBe("test-key");
    expect(result).toEqual({ accepted: true, providerMessageId: "sms-1" });
  });

  it("uses the WhatsApp channel for conversational messages", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message_id: "wa-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await getChannelProvider("whatsapp").send({
      to: "2348031234567",
      body: "Hello",
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(request.channel).toBe("whatsapp");
  });

  it("returns a provider rejection without throwing", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "err", message: "Invalid sender" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      getChannelProvider("sms").send({
        to: "2348031234567",
        body: "Hello",
      }),
    ).resolves.toEqual({ accepted: false, error: "Invalid sender" });
  });

  it("rejects a response that cannot be matched to delivery reports", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Message Sent" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      getChannelProvider("sms").send({
        to: "2348031234567",
        body: "Hello",
      }),
    ).resolves.toEqual({ accepted: false, error: "Message Sent" });
  });

  it("throws transient Termii failures so QStash can retry them", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Service unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      getChannelProvider("whatsapp").send({
        to: "2348031234567",
        body: "Hello",
      }),
    ).rejects.toThrow("Service unavailable");
  });
});
