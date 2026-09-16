import { redis } from "../../config/redis";
import { AIMessage } from "./ai-provider.types";
import { agentInflightKey } from "../../types/ai-agent.types";

export interface ConversationContext {
  messages: AIMessage[];
  summary: string;
}

/** How long a dropped turn's checkpoint stays resumable. Long enough for
 *  a client to retry after a stream error, short enough that a stale
 *  buffer never swallows a later message. */
const INFLIGHT_TTL_SECONDS = 600;

export class AIContextStore {
  private static inMemoryStore = new Map<string, ConversationContext>();
  private static inMemoryInflight = new Map<string, AIMessage[]>();
  private readonly maxWindowSize = 10; // Number of turns to keep in raw sliding window
  private readonly ttlSeconds = 86400; // 24 hour expiration

  private key(sessionId: string): string {
    return `ai:session:${sessionId}`;
  }

  /**
   * Get the context for a given session.
   */
  async getContext(sessionId: string): Promise<ConversationContext> {
    if (!redis) {
      return (
        AIContextStore.inMemoryStore.get(sessionId) ?? {
          messages: [],
          summary: "",
        }
      );
    }

    const data = await this.redisGet<ConversationContext>(this.key(sessionId));
    return data ?? { messages: [], summary: "" };
  }

  /**
   * Save the context for a given session.
   */
  async saveContext(sessionId: string, context: ConversationContext): Promise<void> {
    if (!redis) {
      // Snapshot, matching the serialization the redis path performs —
      // callers keep mutating the array they passed in.
      AIContextStore.inMemoryStore.set(sessionId, {
        ...context,
        messages: [...context.messages],
      });
      return;
    }

    await this.redisSet(this.key(sessionId), context, this.ttlSeconds);
  }

  /**
   * Add a new message to the session's context.
   * If the sliding window size is exceeded, the oldest messages should be processed/evicted.
   * Returns the evicted messages so the caller can trigger summarization if desired.
   */
  async addMessage(sessionId: string, message: AIMessage): Promise<AIMessage[]> {
    const context = await this.getContext(sessionId);
    context.messages.push(message);

    let evicted: AIMessage[] = [];
    if (context.messages.length > this.maxWindowSize) {
      // Evict oldest messages exceeding window size
      const countToEvict = context.messages.length - this.maxWindowSize;
      evicted = context.messages.splice(0, countToEvict);
    }

    await this.saveContext(sessionId, context);
    return evicted;
  }

  /**
   * Update the medium-term summary.
   */
  async updateSummary(sessionId: string, summary: string): Promise<void> {
    const context = await this.getContext(sessionId);
    context.summary = summary;
    await this.saveContext(sessionId, context);
  }

  /**
   * Clear context (both raw history and summary) for a session.
   */
  async clearContext(sessionId: string): Promise<void> {
    if (!redis) {
      AIContextStore.inMemoryStore.delete(sessionId);
      return;
    }

    await this.redisDel(this.key(sessionId));
  }

  /**
   * The checkpointed message buffer of an interrupted turn, or null when
   * there is nothing to resume.
   */
  async getInflightTurn(sessionId: string): Promise<AIMessage[] | null> {
    if (!redis) {
      return AIContextStore.inMemoryInflight.get(sessionId) ?? null;
    }

    return this.redisGet<AIMessage[]>(agentInflightKey(sessionId));
  }

  /**
   * Checkpoint the in-progress message buffer so an interrupted turn can
   * resume instead of re-running.
   */
  async saveInflightTurn(sessionId: string, messages: AIMessage[]): Promise<void> {
    if (!redis) {
      // Snapshot — the caller mutates the same array on the next round.
      AIContextStore.inMemoryInflight.set(sessionId, [...messages]);
      return;
    }

    await this.redisSet(agentInflightKey(sessionId), messages, INFLIGHT_TTL_SECONDS);
  }

  /**
   * Drop the checkpoint once the turn finished (or is being reset).
   */
  async clearInflightTurn(sessionId: string): Promise<void> {
    if (!redis) {
      AIContextStore.inMemoryInflight.delete(sessionId);
      return;
    }

    await this.redisDel(agentInflightKey(sessionId));
  }

  private async redisGet<T>(key: string): Promise<T | null> {
    try {
      return await redis!.get<T>(key);
    } catch (err) {
      console.warn(`[AIContextStore] Redis read failed for key "${key}":`, err);
      return null;
    }
  }

  private async redisSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await redis!.set(key, value, { ex: ttlSeconds });
    } catch (err) {
      console.warn(`[AIContextStore] Redis write failed for key "${key}":`, err);
    }
  }

  private async redisDel(key: string): Promise<void> {
    try {
      await redis!.del(key);
    } catch (err) {
      console.warn(`[AIContextStore] Redis delete failed for key "${key}":`, err);
    }
  }
}

export const aiContextStore = new AIContextStore();
export default aiContextStore;
