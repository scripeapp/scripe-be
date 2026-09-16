import axios, { AxiosError } from "axios";
import { z } from "zod";
import { createAIProvider } from "../services/ai/ai-providers";
import { AITool } from "../services/ai/ai-provider.types";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;
mockedAxios.isAxiosError.mockImplementation(
  (value): value is AxiosError =>
    Boolean(value && (value as AxiosError).isAxiosError),
);

function rateLimitError(): AxiosError {
  return {
    isAxiosError: true,
    response: { status: 429 },
    message: "Too Many Requests",
  } as AxiosError;
}

describe("OpenAI-compatible providers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockedAxios.post.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("isAvailable", () => {
    it("requires an API key for OpenAI", () => {
      delete process.env.OPENAI_API_KEY;
      expect(createAIProvider("openai").isAvailable()).toBe(false);

      process.env.OPENAI_API_KEY = "sk-test";
      expect(createAIProvider("openai").isAvailable()).toBe(true);
    });

    it("requires an API key for hosted Ollama by default", () => {
      delete process.env.OLLAMA_API_KEY;
      delete process.env.OLLAMA_BASE_URL;
      expect(createAIProvider("ollama").isAvailable()).toBe(false);

      process.env.OLLAMA_API_KEY = "ol-test";
      expect(createAIProvider("ollama").isAvailable()).toBe(true);
    });

    it("does not require an API key for explicitly local Ollama", () => {
      delete process.env.OLLAMA_API_KEY;
      process.env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
      expect(createAIProvider("ollama").isAvailable()).toBe(true);
    });
  });

  describe("model fallback", () => {
    it("retries the next model when the primary is rate-limited", async () => {
      process.env.GEMINI_AI_API_KEY = "gm-test";
      mockedAxios.post
        .mockRejectedValueOnce(rateLimitError())
        .mockResolvedValueOnce({
          data: { choices: [{ message: { content: "recovered" } }] },
        });

      const response = await createAIProvider("gemini").generateContent([
        { role: "user", content: "Hi" },
      ]);

      expect(response.text).toBe("recovered");
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      expect(mockedAxios.post.mock.calls[1][1]).toMatchObject({
        model: "gemini-2.5-flash",
      });
    });
  });

  describe("generateContent", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "sk-test";
    });

    it("parses assistant text and token usage", async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [{ message: { content: "Hello there" } }],
          usage: { total_tokens: 42 },
        },
      });

      const response = await createAIProvider("openai").generateContent([
        { role: "user", content: "Hi" },
      ]);

      expect(response.text).toBe("Hello there");
      expect(response.tokensUsed).toBe(42);
      expect(response.toolCalls).toEqual([]);
    });

    it("parses tool calls and decodes their arguments", async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    function: {
                      name: "lookupOrder",
                      arguments: '{"orderId":"abc"}',
                    },
                  },
                ],
              },
            },
          ],
        },
      });

      const tool: AITool = {
        name: "lookupOrder",
        description: "Look up an order",
        parameters: z.object({ orderId: z.string() }),
        execute: jest.fn(),
      };

      const response = await createAIProvider("openai").generateContent(
        [{ role: "user", content: "Where is order abc?" }],
        [tool],
      );

      expect(response.text).toBeUndefined();
      expect(response.toolCalls).toEqual([
        { id: "call_1", name: "lookupOrder", args: { orderId: "abc" } },
      ]);
    });

    it("posts to the configured chat completions endpoint", async () => {
      mockedAxios.post.mockResolvedValue({
        data: { choices: [{ message: { content: "ok" } }] },
      });

      await createAIProvider("openai").generateContent([
        { role: "user", content: "Hi" },
      ]);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://api.openai.com/v1/chat/completions",
        expect.objectContaining({ model: expect.any(String) }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
          }),
        }),
      );
    });

    it("uses hosted Ollama with the default cloud model", async () => {
      process.env.OLLAMA_API_KEY = "ol-test";
      delete process.env.OLLAMA_BASE_URL;
      delete process.env.OLLAMA_MODEL;
      mockedAxios.post.mockResolvedValue({
        data: { choices: [{ message: { content: "ok" } }] },
      });

      await createAIProvider("ollama").generateContent([
        { role: "user", content: "Hi" },
      ]);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://ollama.com/v1/chat/completions",
        expect.objectContaining({ model: "gpt-oss:20b-cloud" }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer ol-test",
          }),
        }),
      );
    });
  });
});
