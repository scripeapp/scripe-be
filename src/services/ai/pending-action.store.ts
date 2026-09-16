/**
 * Redis-backed storage for agent detail-collection question sets and
 * pending (awaiting-approval) actions. Falls back to process memory when
 * Redis is not configured, mirroring draft.store.ts. Ephemeral by design
 * (24h TTL) — question sets either get answered and turned into pending
 * actions, or expire.
 */
import { cacheGet, cacheSet, cacheDel, redis } from "../../config/redis";
import {
  AgentQuestionSet,
  PendingAction,
  agentQuestionSetKey,
  agentActionKey,
  agentSessionActionKey,
} from "../../types/ai-agent.types";

const TTL_SECONDS = 86_400; // 24h
const TTL_MS = TTL_SECONDS * 1000;

interface MemoryEntry<T> {
  value: T;
  expiresAt: number;
}

const memoryStore = new Map<string, MemoryEntry<unknown>>();

export async function saveQuestionSet(
  questionSet: AgentQuestionSet,
): Promise<void> {
  if (!redis) {
    memorySet(agentQuestionSetKey(questionSet.questionSetId), questionSet);
    return;
  }
  await cacheSet(
    agentQuestionSetKey(questionSet.questionSetId),
    questionSet,
    TTL_SECONDS,
  );
}

export async function getQuestionSet(
  questionSetId: string,
): Promise<AgentQuestionSet | null> {
  if (!redis) {
    return memoryGet<AgentQuestionSet>(agentQuestionSetKey(questionSetId));
  }
  return cacheGet<AgentQuestionSet>(agentQuestionSetKey(questionSetId));
}

export async function saveAction(action: PendingAction): Promise<void> {
  if (!redis) {
    memorySet(agentActionKey(action.actionId), action);
    return;
  }
  await cacheSet(agentActionKey(action.actionId), action, TTL_SECONDS);
}

export async function getAction(
  actionId: string,
): Promise<PendingAction | null> {
  if (!redis) {
    return memoryGet<PendingAction>(agentActionKey(actionId));
  }
  return cacheGet<PendingAction>(agentActionKey(actionId));
}

export async function pointSessionAtAction(
  sessionKey: string,
  actionId: string,
): Promise<void> {
  if (!redis) {
    memorySet(agentSessionActionKey(sessionKey), { actionId });
    return;
  }
  await cacheSet(agentSessionActionKey(sessionKey), { actionId }, TTL_SECONDS);
}

export async function clearSessionAction(sessionKey: string): Promise<void> {
  if (!redis) {
    memoryStore.delete(agentSessionActionKey(sessionKey));
    return;
  }
  await cacheDel(agentSessionActionKey(sessionKey));
}

function memorySet<T>(key: string, value: T): void {
  memoryStore.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

function memoryGet<T>(key: string): T | null {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value as T;
}