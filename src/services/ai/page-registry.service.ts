/**
 * Page directory for the dashboard agent. The manifest lives in the web
 * app (surge-fe/src/config/agentPages.ts — the frontend owns its routes)
 * and is served from /api/agent/pages; this service fetches it with a
 * TTL cache so the agent's own system prompt stays static and small.
 *
 * Matching is deliberately keyword-based (aliases + title + description)
 * so merchants can ask "where can I change my business name" and land on
 * the exact settings section.
 */
import { z } from "zod";

/** Canonical public origin of the web app; override for local dev. */
const WEB_BASE_URL = process.env.HILAQ_WEB_URL ?? "https://hilaq.com";

const PAGE_MANIFEST_PATH = "/api/agent/pages";
const MANIFEST_CACHE_TTL_MS = 60 * 60 * 1000;
const MANIFEST_FETCH_TIMEOUT_MS = 5_000;

export interface AgentPage {
  id: string;
  title: string;
  description: string;
  /** Phrases merchants use for this page ("business name", "rename store"). */
  aliases: string[];
  /** Path template; {param} placeholders are filled by find_pages. */
  path: string;
  /** Template params the resolver can look up, e.g. "businessSlug". */
  entityParams?: string[];
}

export interface ResolvedAgentPage {
  id: string;
  title: string;
  /** Fully qualified URL, or null when an entity param could not be resolved. */
  url: string | null;
  description: string;
  /** Entity params still needed before a URL can be built. */
  needs?: string[];
}

const pageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  path: z.string().min(1).startsWith("/"),
  entityParams: z.array(z.string()).optional(),
});

const pageManifestSchema = z.object({
  pages: z.array(pageSchema),
});

let cachedManifest: AgentPage[] | null = null;
let cacheExpiresAt = 0;

/** Prefixes a path with the app's canonical origin for sharing. */
export function publicWebUrl(path: string): string {
  return path.startsWith("http") ? path : `${WEB_BASE_URL}${path}`;
}

/** Returns the manifest, re-fetching after the TTL. Throws when the web
 *  app is unreachable so the caller can degrade gracefully. */
export async function fetchPageManifest(): Promise<AgentPage[]> {
  const now = Date.now();
  if (cachedManifest && now < cacheExpiresAt) {
    return cachedManifest;
  }

  const response = await fetch(`${WEB_BASE_URL}${PAGE_MANIFEST_PATH}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Page manifest fetch failed with status ${response.status}`);
  }

  const parsed = pageManifestSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Page manifest does not match the expected shape");
  }

  cachedManifest = parsed.data.pages;
  cacheExpiresAt = now + MANIFEST_CACHE_TTL_MS;
  return cachedManifest;
}

/** Filler words that add no signal to a page search. */
const SEARCH_STOPWORDS = new Set([
  "where", "what", "which", "when", "how", "can", "could", "would",
  "should", "do", "does", "did", "i", "me", "my", "the", "a", "an",
  "is", "are", "it", "to", "for", "in", "on", "at", "of", "and", "or",
  "out", "up", "off", "go", "get", "find", "show", "open", "page", "link",
]);

export function tokenizePageQuery(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token));
}

function scorePage(page: AgentPage, tokens: string[]): number {
  let score = 0;
  for (const alias of page.aliases) {
    const aliasTokens = tokenizePageQuery(alias);
    if (aliasTokens.length > 0 && tokens.every((t) => aliasTokens.includes(t))) {
      score += 10;
    } else {
      score += tokens.filter((t) => aliasTokens.includes(t)).length;
    }
  }
  const titleTokens = tokenizePageQuery(page.title);
  score += tokens.filter((t) => titleTokens.includes(t)).length * 2;
  const descriptionTokens = tokenizePageQuery(page.description);
  score += tokens.filter((t) => descriptionTokens.includes(t)).length;
  const pathTokens = tokenizePageQuery(page.path);
  score += tokens.filter((t) => pathTokens.includes(t)).length;
  return score;
}

/** Returns the best-matching pages for a merchant query, best first. */
export function matchPages(
  pages: AgentPage[],
  query: string,
  limit: number,
): AgentPage[] {
  const tokens = tokenizePageQuery(query);
  if (tokens.length === 0) return [];

  return pages
    .map((page) => ({ page, score: scorePage(page, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.page.title.localeCompare(b.page.title),
    )
    .slice(0, limit)
    .map((entry) => entry.page);
}

/** Fills {param} placeholders in a page path with resolved values. */
export function resolvePageUrl(
  page: AgentPage,
  resolvedParams: Record<string, string>,
): Pick<ResolvedAgentPage, "url" | "needs"> {
  const unresolvedParams = (page.entityParams ?? []).filter(
    (param) => !resolvedParams[param],
  );
  if (unresolvedParams.length > 0) {
    return { url: null, needs: unresolvedParams };
  }

  let path = page.path;
  for (const [param, value] of Object.entries(resolvedParams)) {
    path = path.split(`{${param}}`).join(value);
  }
  return { url: publicWebUrl(path), needs: undefined };
}
