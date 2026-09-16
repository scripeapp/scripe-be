/**
 * Shared two-phase-action helpers for the AI agent tools.
 *
 * Every tool follows the same contract: missing details → `questions`
 * card (stored question set) → merchant answers → tool re-invoked with a
 * complete payload → pending action + `action` card. These helpers make
 * that contract one code path instead of six copies, so a change to how
 * question sets or pending actions are persisted/emitted applies to every
 * tool at once.
 */
import { randomUUID } from "crypto";
import {
  AgentEmit,
  AgentQuestion,
  AgentQuestionSet,
  PendingAction,
} from "../../../types/ai-agent.types";
import {
  saveAction,
  saveQuestionSet,
  pointSessionAtAction,
} from "../pending-action.store";

export interface ActionToolContext {
  sessionKey: string;
  businessId: string;
  userId: string;
  emit: AgentEmit;
}

/** Persist the question set and show the detail card. Returns the note
 *  the model should say to the merchant. */
export async function presentQuestions(
  ctx: ActionToolContext,
  questions: AgentQuestion[],
  partialPayload: Record<string, unknown>,
): Promise<{ ok: true; note: string }> {
  const questionSet: AgentQuestionSet = {
    questionSetId: randomUUID(),
    sessionKey: ctx.sessionKey,
    questions,
    partialPayload,
    createdAt: new Date().toISOString(),
  };
  await saveQuestionSet(questionSet);
  ctx.emit("questions", {
    questionSetId: questionSet.questionSetId,
    questions: questionSet.questions,
  });
  return {
    ok: true,
    note: "A detail card is showing to the merchant. Tell them to answer the questions so you can finish preparing it. Do not invent values.",
  };
}

export interface PendingActionInput {
  type: string;
  payload: Record<string, unknown>;
  summary: PendingAction["summary"];
}

/** Persist the pending action and show the approval card. Returns the
 *  note the model should say to the merchant. */
export async function presentPendingAction(
  ctx: ActionToolContext,
  input: PendingActionInput,
): Promise<{ ok: true; note: string }> {
  const action: PendingAction = {
    actionId: randomUUID(),
    businessId: ctx.businessId,
    userId: ctx.userId,
    status: "pending",
    createdAt: new Date().toISOString(),
    ...input,
  };
  await saveAction(action);
  await pointSessionAtAction(ctx.sessionKey, action.actionId);

  ctx.emit("action", {
    actionId: action.actionId,
    type: action.type,
    summary: action.summary,
    options: [
      {
        actionId: action.actionId,
        summary: action.summary,
      },
    ],
  });

  return {
    ok: true,
    note: "An approval card is now showing to the merchant. Summarize what is being changed and tell them to review and confirm. Do not claim it is done.",
  };
}