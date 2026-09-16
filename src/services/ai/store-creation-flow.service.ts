/**
 * The store-creation flow — the one deterministic path in the agent's
 * otherwise open-ended loop. When the merchant asks to create a store and
 * a document is attached, the extraction shortcut runs the extraction
 * tool directly and resolves the turn to a preview draft, without burning
 * model iterations on intent detection. Approval then happens on the
 * separate draft endpoint, guarded by store-creation permission.
 */
import { AgentEmit } from "../../types/ai-agent.types";
import { AITool } from "./ai-provider.types";
import { aiContextStore } from "./context.store";
import { getDocument } from "./draft.store";

interface ExtractionTurnContext {
  sessionKey: string;
  message: string;
  extractionTool: AITool;
  emit: AgentEmit;
}

interface ExtractionSummary {
  storeName: string;
  itemCount: number;
  categoryCount: number;
  gaps?: string[];
}

const STORE_CREATION_VERBS = /\b(create|build|setup|set up|generate|make)\b/;
const STORE_CREATION_NOUNS = /\b(store|shop|menu|restaurant|catalogue|catalog)\b/;

const EXTRACTION_FAILED_MESSAGE =
  "Something went wrong while extracting the document. Please try again.";

const EXTRACTION_SUMMARY_FALLBACK =
  "I extracted the document and prepared a store draft for review.";

export class StoreCreationFlowService {
  hasStoreCreationIntent(message: string): boolean {
    const text = message.toLowerCase();
    return STORE_CREATION_VERBS.test(text) && STORE_CREATION_NOUNS.test(text);
  }

  /** Returns true when the extraction shortcut handled the turn; false
   *  when the generic agent loop should run instead. */
  async tryRunExtractionTurn(ctx: ExtractionTurnContext): Promise<boolean> {
    const { sessionKey, message, extractionTool, emit } = ctx;

    if (
      !this.hasStoreCreationIntent(message) ||
      !(await getDocument(sessionKey))
    ) {
      return false;
    }

    emit("tool_status", { tool: extractionTool.name, status: "started" });
    const result = await extractionTool.execute({
      merchant_instructions: message,
    });
    const failed = isExtractionFailure(result);
    emit("tool_status", {
      tool: extractionTool.name,
      status: failed ? "error" : "finished",
    });

    const responseText = failed
      ? getExtractionError(result)
      : summarizeExtractionResult(result);
    emit(failed ? "error" : "message", {
      message: responseText,
      text: responseText,
    });

    if (!failed) {
      await aiContextStore.addMessage(sessionKey, {
        role: "user",
        content: message,
      });
      await aiContextStore.addMessage(sessionKey, {
        role: "assistant",
        content: responseText,
      });
      emit("done", { tokensUsed: 0 });
    }
    return true;
  }
}

export const storeCreationFlow = new StoreCreationFlowService();

function isExtractionFailure(result: unknown): result is { error: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    typeof (result as Record<string, unknown>).error === "string"
  );
}

function getExtractionError(result: unknown): string {
  if (isExtractionFailure(result)) return result.error;
  return EXTRACTION_FAILED_MESSAGE;
}

function summarizeExtractionResult(result: unknown): string {
  const summary = extractSummary(result);
  if (!summary) {
    return EXTRACTION_SUMMARY_FALLBACK;
  }

  const gapText = summary.gaps?.length
    ? ` Gaps to review: ${summary.gaps.slice(0, 3).join("; ")}.`
    : "";
  const categoryLabel = summary.categoryCount === 1 ? "category" : "categories";
  return `I found ${summary.storeName} with ${summary.itemCount} item(s) across ${summary.categoryCount} ${categoryLabel}. Review the draft below, then approve it when it looks right.${gapText}`;
}

function extractSummary(result: unknown): ExtractionSummary | null {
  if (typeof result !== "object" || result === null || !("summary" in result)) {
    return null;
  }

  const summary = (result as Record<string, unknown>).summary;
  if (typeof summary !== "object" || summary === null) {
    return null;
  }

  const fields = summary as Record<string, unknown>;
  if (
    typeof fields.storeName !== "string" ||
    typeof fields.itemCount !== "number" ||
    typeof fields.categoryCount !== "number"
  ) {
    return null;
  }

  return {
    storeName: fields.storeName,
    itemCount: fields.itemCount,
    categoryCount: fields.categoryCount,
    gaps: Array.isArray(fields.gaps) ? fields.gaps.map(String) : undefined,
  };
}