import { Redis } from "@upstash/redis";
import "dotenv/config";

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.warn("[Redis] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN — caching disabled");
}

export const redis: Redis | null = url && token
  ? new Redis({ url, token })
  : null;

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    return await redis.get<T>(key);
  } catch (err) {
    console.warn(`[Redis] cacheGet error for key "${key}":`, err);
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.warn(`[Redis] cacheSet error for key "${key}":`, err);
  }
}

export async function cacheDel(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    console.warn(`[Redis] cacheDel error for key "${key}":`, err);
  }
}

/**
 * Acquire a distributed lock.
 * Returns true if the lock was acquired (i.e. first caller wins).
 * TTL is the lock expiry in seconds — set it to slightly less than the job interval.
 */
export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  if (!redis) return true; // No Redis = no distributed locking; allow the job to run
  try {
    const result = await redis.set(key, "1", { nx: true, ex: ttlSeconds });
    return result === "OK";
  } catch (err) {
    console.warn(`[Redis] acquireLock error for key "${key}":`, err);
    return true; // Fail open — better to run twice than not at all
  }
}
