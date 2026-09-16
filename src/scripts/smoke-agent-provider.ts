/**
 * Smoke test for the agent AI provider (Phase 0 of the dashboard AI panel).
 * Requires ANTHROPIC_API_KEY in .env.
 *
 *   npx ts-node src/scripts/smoke-agent-provider.ts
 *
 * Expected: the model calls the get_time tool, then answers with the time.
 */
import "dotenv/config";
import { z } from "zod";
import { getAgentAIProvider } from "../services/ai/ai-provider.factory";
import { AIMessage, AITool } from "../services/ai/ai-provider.types";

async function main() {
  const provider = getAgentAIProvider();
  console.log(`provider: ${provider.name}, available: ${provider.isAvailable()}`);
  if (!provider.isAvailable()) {
    console.error("Provider not configured — set ANTHROPIC_API_KEY in .env");
    process.exit(1);
  }

  const timeTool: AITool = {
    name: "get_time",
    description: "Returns the current server time as an ISO string.",
    parameters: z.object({}),
    execute: async () => ({ now: new Date().toISOString() }),
  };

  const messages: AIMessage[] = [
    { role: "system", content: "You are a test assistant. Use tools when relevant." },
    { role: "user", content: "What time is it right now? Use your tool." },
  ];

  // Turn 1 — expect a tool call
  const first = await provider.generateContent(messages, [timeTool]);
  console.log("turn 1:", JSON.stringify(first, null, 2));
  if (!first.toolCalls?.length) {
    console.error("FAIL: expected a tool call on turn 1");
    process.exit(1);
  }

  // Execute the tool and round-trip the result — exercises the
  // AIMessage.toolCalls history mapping both directions.
  const call = first.toolCalls[0];
  const result = await timeTool.execute(call.args);
  messages.push({
    role: "assistant",
    content: first.text ?? "",
    toolCalls: first.toolCalls,
  });
  messages.push({
    role: "tool",
    content: JSON.stringify(result),
    toolCallId: call.id,
  });

  const second = await provider.generateContent(messages, [timeTool]);
  console.log("turn 2:", JSON.stringify(second, null, 2));
  if (!second.text) {
    console.error("FAIL: expected a text answer on turn 2");
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
