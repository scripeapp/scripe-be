/**
 * Redis-backed storage for agent extraction drafts and uploaded-document
 * text. Falls back to process memory when Redis is not configured so local
 * agent testing still works. Ephemeral by design (24h TTL) — drafts either
 * get approved into real stores or expire.
 */
import { cacheGet, cacheSet, cacheDel, redis } from "../../config/redis";
import {
  StoreDraft,
  agentDocKey,
  agentDraftKey,
  agentSessionDraftKey,
} from "../../types/ai-agent.types";

const TTL_SECONDS = 86_400; // 24h
const TTL_MS = TTL_SECONDS * 1000;

interface MemoryEntry<T> {
  value: T;
  expiresAt: number;
}

const memoryStore = new Map<string, MemoryEntry<unknown>>();

export interface StoredDocument {
  filename: string;
  text: string;
  truncated: boolean;
  uploadedAt: string;
}

export async function saveDocument(
  sessionKey: string,
  doc: StoredDocument,
): Promise<void> {
  if (!redis) {
    memorySet(agentDocKey(sessionKey), doc);
    return;
  }
  await cacheSet(agentDocKey(sessionKey), doc, TTL_SECONDS);
}

export async function getDocument(
  sessionKey: string,
): Promise<StoredDocument | null> {
  if (!redis) {
    return memoryGet<StoredDocument>(agentDocKey(sessionKey));
  }
  return cacheGet<StoredDocument>(agentDocKey(sessionKey));
}

export async function saveDraft(draft: StoreDraft): Promise<void> {
  if (!redis) {
    memorySet(agentDraftKey(draft.draftId), draft);
    return;
  }
  await cacheSet(agentDraftKey(draft.draftId), draft, TTL_SECONDS);
}

export async function getDraft(draftId: string): Promise<StoreDraft | null> {
  if (!redis) {
    return memoryGet<StoreDraft>(agentDraftKey(draftId));
  }
  return cacheGet<StoreDraft>(agentDraftKey(draftId));
}

export async function pointSessionAtDraft(
  sessionKey: string,
  draftId: string,
): Promise<void> {
  if (!redis) {
    memorySet(agentSessionDraftKey(sessionKey), { draftId });
    return;
  }
  await cacheSet(agentSessionDraftKey(sessionKey), { draftId }, TTL_SECONDS);
}

export async function clearSessionDraft(sessionKey: string): Promise<void> {
  if (!redis) {
    memoryStore.delete(agentSessionDraftKey(sessionKey));
    return;
  }
  await cacheDel(agentSessionDraftKey(sessionKey));
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
