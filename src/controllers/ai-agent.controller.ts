/**
 * Dashboard AI agent controller (Command Center panel).
 *
 * The chat handler speaks SSE: it takes over the response after auth
 * middleware runs, so errors past that point are emitted as `error`
 * events on the stream — never thrown into the JSON error middleware.
 */
import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { runAgentTurn } from "../services/ai/agent-runner";
import { buildQaTools } from "../services/ai/tools/qa.tools";
import { buildExtractionTool } from "../services/ai/tools/store-creation.tool";
import { buildMerchantCapabilityTool } from "../services/ai/tools/merchant-capability.tool";
import { buildCreateEventTool } from "../services/ai/tools/create-event.tool";
import { buildCreateEventTypeTool } from "../services/ai/tools/create-event-type.tool";
import { buildCreateProductTool } from "../services/ai/tools/create-product.tool";
import { buildUpdateEventTool } from "../services/ai/tools/update-event.tool";
import { buildUpdateEventTypeTool } from "../services/ai/tools/update-event-type.tool";
import { buildUpdateProductTool } from "../services/ai/tools/update-product.tool";
import { buildFindPagesTool } from "../services/ai/tools/find-pages.tool";
import { AITool } from "../services/ai/ai-provider.types";
import {
  getQuestionSet,
  getAction,
  saveAction,
} from "../services/ai/pending-action.store";
import { executePendingAction } from "../services/ai/action-executor.service";
import { publicWebUrl } from "../services/ai/page-registry.service";
import { MERCHANT_CAPABILITIES } from "../services/ai/merchant-capabilities";
import { isAgentPanelEnabled } from "../services/ai/agent-settings.service";
import { aiContextStore } from "../services/ai/context.store";
import { storeCreationFlow } from "../services/ai/store-creation-flow.service";
import { cacheDel, acquireLock } from "../config/redis";
import {
  extractText,
  DocumentParsingError,
} from "../services/ai/document-parsing.service";
import {
  saveDocument,
  getDraft,
  saveDraft,
} from "../services/ai/draft.store";
import { provisionStoreFromKitchenJson } from "../services/ai/store-provisioning.service";
import {
  AgentEmit,
  AgentEventName,
  AgentQuestionSet,
  KitchenJson,
  agentSessionKey,
  agentDocKey,
  agentSessionDraftKey,
  agentSessionActionKey,
  agentInflightKey,
  sanitizeThreadId,
} from "../types/ai-agent.types";

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB (multer's global cap is 50MB)

const HEARTBEAT_MS = 15_000;

/**
 * Turns a raw provider error into something a merchant can actually act
 * on. Rate-limit and billing failures are common (free-tier quotas,
 * out-of-credit accounts) and otherwise all collapse into an opaque
 * "something went wrong" — worth telling apart from a genuine bug.
 */
function describeAgentError(err: unknown): string {
  const status =
    (err as any)?.response?.status ?? (err as any)?.status ?? null;
  const raw =
    (err as any)?.response?.data?.error?.message ||
    (err as any)?.error?.message ||
    (err instanceof Error ? err.message : String(err));
  const text = `${raw}`.toLowerCase();

  if (status === 429 || /rate.?limit|quota|resource_exhausted/.test(text)) {
    return "Rate limit hit. Please try again in a moment.";
  }
  if (
    /credit balance|insufficient.*(credit|balance)|billing/.test(text)
  ) {
    return "The assistant is temporarily unavailable. Please try again later.";
  }
  // In non-production, surface the real provider error so failures like a
  // retired model or a missing tool schema are debuggable instead of being
  // collapsed into an opaque "something went wrong".
  if (process.env.NODE_ENV !== "production") {
    return `Something went wrong. Please try again. (${raw})`;
  }
  return "Something went wrong. Please try again.";
}

/** Extracts Postgres NOT-NULL violations ("null value in column X of
 *  relation Y") from an execution error, so a failed action can ask the
 *  merchant for the missing detail instead of dead-ending. */
function missingFieldsFromError(
  message: string,
): Array<{ column: string; table: string }> {
  return [
    ...message.matchAll(
      /null value in column "([^"]+)" of relation "([^"]+)" violates not-null constraint/g,
    ),
  ].map((match) => ({ column: match[1], table: match[2] }));
}

/** Env master switch + admin DB toggle + provider readiness — the FE's
 *  gate signal. (Delegates to agent-settings.service.) */
/** Turns a question set + merchant answers into the user message the
 *  continuation turn sees, so the model can merge them into the tool call
 *  it was preparing. Answers not present in the set are ignored. */
function formatAnswerMessage(
  questionSet: AgentQuestionSet,
  answers: Array<{ key: string; values: string[] }>,
): string {
  const byKey = new Map(answers.map((a) => [a.key, a.values]));
  const lines = questionSet.questions.map((q) => {
    const values = byKey.get(q.key);
    if (!values || values.length === 0) {
      return `- ${q.question}: (no answer)`;
    }
    return `- ${q.question}: ${values.join(", ")}`;
  });
  return `I answered your detail questions:\n${lines.join("\n")}`;
}

/** Context line anchoring "here"-relative questions to the page the
 *  merchant is currently viewing; empty when the client sent none. */
function currentPageNote(currentPage?: string): string | undefined {
  if (!currentPage) return undefined;
  return `System: the merchant is currently viewing ${currentPage}. Use this to anchor "here" and "on this page" questions.`;
}

export const isAgentEnabled = isAgentPanelEnabled;

export class AIAgentController {
  /** SSE scaffold shared by chat and submitAnswers: headers, emit helper,
   *  heartbeat, and abort-on-disconnect. Returns a close() that ends the
   *  response exactly once. */
  private startAgentStream(
    req: SupabaseRequest,
    res: Response,
  ): { emit: AgentEmit; signal: AbortSignal; close: () => void } {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    req.setTimeout(0);

    const emit: AgentEmit = (event: AgentEventName, data: unknown) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`:ping\n\n`);
    }, HEARTBEAT_MS);

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    return {
      emit,
      signal: abortController.signal,
      close: () => {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      },
    };
  }

  private buildTools(
    req: SupabaseRequest,
    sessionKey: string,
    emit: AgentEmit,
  ): AITool[] {
    const userId = req.user_id!;
    const businessId = (req as any).businessId as string;
    return [
      ...buildQaTools({
        userId,
        businessId,
        supabase: req.supabase!,
      }),
      buildMerchantCapabilityTool({
        businessId,
        supabase: req.supabase!,
      }),
      buildExtractionTool({ sessionKey, businessId, userId, emit }),
      buildCreateEventTool({ sessionKey, businessId, userId, emit }),
      buildCreateEventTypeTool({ sessionKey, businessId, userId, emit }),
      buildCreateProductTool({ sessionKey, businessId, userId, emit }),
      buildUpdateEventTool({ sessionKey, businessId, userId, emit }),
      buildUpdateEventTypeTool({ sessionKey, businessId, userId, emit }),
      buildUpdateProductTool({ sessionKey, businessId, userId, emit }),
      buildFindPagesTool({
        businessId,
        supabase: req.supabase!,
      }),
    ];
  }

  /**
   * POST /api/ai/agent/chat — SSE stream of one agent turn.
   * Events: tool_status | questions | action | message | preview | done | error.
   */
  async chat(req: SupabaseRequest, res: Response): Promise<void> {
    const userId = req.user_id!;
    const businessId = (req as any).businessId as string;
    const { message, thread_id, current_page } = req.body as {
      message: string;
      thread_id?: string;
      current_page?: string;
    };
    const sessionKey = agentSessionKey(businessId, userId, thread_id);

    const { emit, signal, close } = this.startAgentStream(req, res);

    try {
      const tools = this.buildTools(req, sessionKey, emit);

      const extractionTool = tools.find(
        (tool) => tool.name === "extract_store_from_document",
      );
      if (extractionTool) {
        const handled = await storeCreationFlow.tryRunExtractionTurn({
          sessionKey,
          message,
          extractionTool,
          emit,
        });
        if (handled) return;
      }

      await runAgentTurn({
        sessionKey,
        userText: message,
        systemNote: currentPageNote(current_page),
        tools,
        emit,
        signal: signal,
      });
    } catch (err) {
      console.error("[AIAgent] chat turn failed:", err);
      emit("error", { message: describeAgentError(err) });
    } finally {
      close();
    }
  }

  /**
   * POST /api/ai/agent/answers — SSE continuation of one agent turn with
   * the merchant's detail-card answers injected as the user message. The
   * agent re-invokes the tool it was preparing (e.g. create_event) with
   * the completed payload.
   */
  async submitAnswers(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response | void> {
    const userId = req.user_id!;
    const businessId = (req as any).businessId as string;
    const { question_set_id, answers, thread_id, current_page } = req.body as {
      question_set_id: string;
      answers: Array<{ key: string; values: string[] }>;
      thread_id?: string;
      current_page?: string;
    };
    const sessionKey = agentSessionKey(businessId, userId, thread_id);

    const questionSet = await getQuestionSet(question_set_id);
    if (!questionSet || questionSet.sessionKey !== sessionKey) {
      return res.status(404).json({
        success: false,
        error: "question_set_not_found",
        message: "These questions are no longer available.",
      });
    }

    const { emit, signal, close } = this.startAgentStream(req, res);

    try {
      const answerText = formatAnswerMessage(questionSet, answers);
      const tools = this.buildTools(req, sessionKey, emit);
      const systemNote = [
        "The merchant answered the detail questions shown as the user message. If you were preparing an action (e.g. create_event), call that tool again now with the complete details — merge their answers into the payload you already had.",
        currentPageNote(current_page),
      ]
        .filter(Boolean)
        .join("\n");
      await runAgentTurn({
        sessionKey,
        userText: answerText,
        systemNote,
        tools,
        emit,
        signal,
      });
    } catch (err) {
      console.error("[AIAgent] answers turn failed:", err);
      emit("error", { message: describeAgentError(err) });
    } finally {
      close();
    }
  }

  /**
   * POST /api/ai/agent/actions/:actionId/approve — the ONLY path that
   * executes a pending action. Idempotent: a lock + status machine make
   * double-clicks and retries safe. Permission is checked per action type
   * in the route middleware.
   */
  async approveAction(req: SupabaseRequest, res: Response): Promise<Response> {
    const userId = req.user_id!;
    const { actionId } = req.params as { actionId: string };

    const action = await getAction(actionId);
    if (!action || action.userId !== userId) {
      return res.status(404).json({
        success: false,
        error: "action_not_found",
        message: "This action no longer exists — it may have expired.",
      });
    }
    if (action.businessId !== (req as any).businessId) {
      return res.status(403).json({
        success: false,
        error: "action_business_mismatch",
        message: "This action belongs to a different business.",
      });
    }
    if (action.status === "executed" && action.result) {
      return res.json({ success: true, data: action.result });
    }
    if (action.status === "rejected") {
      return res.status(409).json({
        success: false,
        error: "action_rejected",
        message: "This action was discarded. Ask the assistant to re-plan it.",
      });
    }

    const gotLock = await acquireLock(`ai:action:lock:${actionId}`, 300);
    if (!gotLock) {
      return res.status(409).json({
        success: false,
        error: "action_in_progress",
        message: "This action is already being executed.",
      });
    }

    action.status = "executing";
    await saveAction(action);

    try {
      const outcome = await executePendingAction(req.supabase!, action);
      action.status = "executed";
      action.result = outcome.result;
      await saveAction(action);

      const sessionKey = agentSessionKey(
        action.businessId,
        userId,
        sanitizeThreadId(req.body?.thread_id),
      );
      await aiContextStore.addMessage(sessionKey, {
        role: "system",
        content: `System: the merchant approved the "${action.type}" action and it completed successfully: ${JSON.stringify(
          outcome.result,
        )}.`,
      });

      return res.json({ success: true, data: outcome.result });
    } catch (err: any) {
      console.error("[AIAgent] action execution failed:", err);
      action.status = "failed";
      action.error = err?.message || "Action failed";
      await saveAction(action);
      await cacheDel(`ai:action:lock:${actionId}`);

      const failureReason = err?.message || "Action failed";
      const missingFields = missingFieldsFromError(failureReason);

      const sessionKey = agentSessionKey(
        action.businessId,
        userId,
        sanitizeThreadId(req.body?.thread_id),
      );
      await aiContextStore.addMessage(sessionKey, {
        role: "system",
        content: missingFields.length > 0
          ? `System: the merchant approved the "${action.type}" action but it failed because required details are missing: ${missingFields.map((f) => `${f.table}.${f.column}`).join(", ")}. Ask the merchant to provide each missing detail, then prepare a new "${action.type}" action with the complete details.`
          : `System: the merchant approved the "${action.type}" action but it failed: ${failureReason}. Offer to retry or adjust the details.`,
      });

      if (missingFields.length > 0) {
        return res.status(422).json({
          success: false,
          error: "action_needs_fields",
          // Generic copy for the merchant; the specific missing fields go
          // to the agent's context so it can ask naturally.
          message: "Something went wrong. Please try again.",
          fields: missingFields,
        });
      }

      return res.status(500).json({
        success: false,
        error: "action_failed",
        message: "Something went wrong. Please try again.",
      });
    }
  }

  /**
   * POST /api/ai/agent/actions/:actionId/reject — discard a pending action.
   */
  async rejectAction(req: SupabaseRequest, res: Response): Promise<Response> {
    const userId = req.user_id!;
    const { actionId } = req.params as { actionId: string };

    const action = await getAction(actionId);
    if (action && action.userId === userId && action.status === "pending") {
      action.status = "rejected";
      await saveAction(action);
      const sessionKey = agentSessionKey(
        action.businessId,
        userId,
        sanitizeThreadId(req.body?.thread_id),
      );
      await aiContextStore.addMessage(sessionKey, {
        role: "system",
        content:
          "System: the merchant discarded the action. Ask what they'd like to change before re-planning it.",
      });
    }
    return res.json({ success: true });
  }

  async getCapabilities(
    _req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    return res.json({
      success: true,
      data: MERCHANT_CAPABILITIES,
    });
  }

  /**
   * POST /api/ai/agent/documents — attach a document to the caller's
   * session. Parses text server-side; the raw file is not retained.
   */
  async uploadDocument(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    const userId = req.user_id!;
    const businessId =
      ((req as any).businessId as string) || req.body?.business_id;
    const file = (req as any).file as Express.Multer.File | undefined;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: "file_required",
        message: "Attach a file under the 'file' field.",
      });
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      return res.status(400).json({
        success: false,
        error: "file_too_large",
        message: "Documents are limited to 10MB.",
      });
    }

    try {
      const parsed = await extractText(
        file.buffer,
        file.mimetype,
        file.originalname,
      );
      const sessionKey = agentSessionKey(
        businessId,
        userId,
        sanitizeThreadId(req.body?.thread_id),
      );
      await saveDocument(sessionKey, {
        filename: file.originalname,
        text: parsed.text,
        truncated: parsed.truncated,
        uploadedAt: new Date().toISOString(),
      });
      return res.json({
        success: true,
        data: {
          filename: file.originalname,
          characters: parsed.text.length,
          truncated: parsed.truncated,
        },
      });
    } catch (err) {
      if (err instanceof DocumentParsingError) {
        return res.status(400).json({
          success: false,
          error: "unreadable_document",
          message: err.message,
        });
      }
      console.error("[AIAgent] document parsing failed:", err);
      return res.status(500).json({
        success: false,
        error: "document_parse_failed",
        message: "Could not read this document. Please try another file.",
      });
    }
  }

  /**
   * POST /api/ai/agent/drafts/:draftId/approve — the ONLY path that
   * provisions a store from a draft. Idempotent: a lock + status machine
   * make double-clicks and retries safe.
   */
  async approveDraft(req: SupabaseRequest, res: Response): Promise<Response> {
    const userId = req.user_id!;
    const businessId = (req as any).businessId as string;
    const { draftId } = req.params as { draftId: string };

    const draft = await getDraft(draftId);
    if (!draft || draft.businessId !== businessId || draft.userId !== userId) {
      return res.status(404).json({
        success: false,
        error: "draft_not_found",
        message: "This draft no longer exists — it may have expired.",
      });
    }

    if (draft.status === "provisioned" && draft.provisionResult) {
      return res.json({ success: true, data: draft.provisionResult });
    }
    if (draft.status === "rejected") {
      return res.status(409).json({
        success: false,
        error: "draft_rejected",
        message: "This draft was discarded. Ask the assistant to re-extract.",
      });
    }

    const gotLock = await acquireLock(`ai:draft:lock:${draftId}`, 300);
    if (!gotLock) {
      return res.status(409).json({
        success: false,
        error: "provisioning_in_progress",
        message: "This store is already being created.",
      });
    }

    draft.status = "provisioning";
    await saveDraft(draft);

    try {
      const result = await provisionStoreFromKitchenJson(
        req.supabase!,
        draft.json as KitchenJson,
        userId,
        businessId,
      );

      draft.status = "provisioned";
      draft.provisionResult = {
        storeId: result.storeId,
        counts: result.counts as unknown as Record<string, number>,
      };
      await saveDraft(draft);

      // Let the agent's next turn know provisioning happened.
      const sessionKey = agentSessionKey(
        businessId,
        userId,
        sanitizeThreadId(req.body?.thread_id),
      );
      await aiContextStore.addMessage(sessionKey, {
        role: "system",
        content: `System: the merchant approved the draft and store "${result.storeName}" (id ${result.storeId}) was provisioned successfully with ${result.counts.items} items. Its public page will be at ${publicWebUrl(`/s/${result.slug}`)}.`,
      });

      return res.json({
        success: true,
        data: {
          storeId: result.storeId,
          storeName: result.storeName,
          slug: result.slug,
          counts: result.counts,
          gaps: result.gaps,
        },
      });
    } catch (err: any) {
      console.error("[AIAgent] provisioning failed:", err);
      draft.status = "failed";
      draft.error = err?.message || "Provisioning failed";
      await saveDraft(draft);
      await cacheDel(`ai:draft:lock:${draftId}`);
      return res.status(500).json({
        success: false,
        error: "provisioning_failed",
        message:
          "Store creation failed partway. Check your stores list before retrying — a partial store may need deleting.",
      });
    }
  }

  /**
   * POST /api/ai/agent/drafts/:draftId/reject — discard a draft.
   */
  async rejectDraft(req: SupabaseRequest, res: Response): Promise<Response> {
    const userId = req.user_id!;
    const { draftId } = req.params as { draftId: string };

    const draft = await getDraft(draftId);
    if (draft && draft.userId === userId && draft.status === "pending") {
      draft.status = "rejected";
      await saveDraft(draft);
      const sessionKey = agentSessionKey(
        draft.businessId,
        userId,
        sanitizeThreadId(req.body?.thread_id),
      );
      await aiContextStore.addMessage(sessionKey, {
        role: "system",
        content:
          "System: the merchant discarded the store draft. Ask what they'd like to change before re-extracting.",
      });
    }
    return res.json({ success: true });
  }

  /**
   * DELETE /api/ai/agent/session — clear conversation + attached doc +
   * draft pointer for the caller's session.
   */
  async resetSession(req: SupabaseRequest, res: Response): Promise<Response> {
    const userId = req.user_id!;
    const businessId =
      ((req as any).businessId as string) ||
      (req.query.business_id as string) ||
      (req.body?.business_id as string);

    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: "business_id_required",
        message: "Business ID is required",
      });
    }

    const sessionKey = agentSessionKey(
      businessId,
      userId,
      sanitizeThreadId(req.query.thread_id),
    );
    await aiContextStore.clearContext(sessionKey);
    await cacheDel(agentDocKey(sessionKey));
    await cacheDel(agentSessionDraftKey(sessionKey));
    await cacheDel(agentSessionActionKey(sessionKey));
    await cacheDel(agentInflightKey(sessionKey));

    return res.json({ success: true });
  }
}

export const aiAgentController = new AIAgentController();
