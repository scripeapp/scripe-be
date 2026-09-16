/**
 * The find_pages tool: maps a merchant's "where is X?" intent to real
 * Hilaq pages. The manifest comes from the web app (page-registry.service)
 * so the agent never invents URLs from memory; context params the tool
 * knows (business slug, store slug) are resolved server-side, and pages
 * needing an unknown entity are returned with `needs` so the agent asks
 * instead of guessing.
 */
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { AITool } from "../ai-provider.types";
import {
  AgentPage,
  ResolvedAgentPage,
  fetchPageManifest,
  matchPages,
  resolvePageUrl,
} from "../page-registry.service";

interface FindPagesContext {
  businessId: string;
  supabase: SupabaseClient;
}

export function buildFindPagesTool(ctx: FindPagesContext): AITool<{
  query: string;
  limit?: number;
}> {
  return {
    name: "find_pages",
    description:
      "Find Hilaq pages that match what the merchant wants to do — dashboard tabs, settings sections, and public pages. Call this whenever the merchant asks where something is, how to change or manage something (e.g. 'where can I change my business name?', 'how do I publish an event?', 'where do I see my revenue?'). Returns the exact page title and URL when it can be resolved, or the page with what it still needs (e.g. which product).",
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .max(120)
        .describe("What the merchant wants to do or find"),
      limit: z.number().int().min(1).max(5).default(3),
    }),
    execute: async ({ query, limit }) => {
      let pages: AgentPage[];
      try {
        pages = await fetchPageManifest();
      } catch {
        return {
          error:
            "The page directory is unavailable right now. Answer without page links and suggest the merchant retry.",
        };
      }

      const matches = matchPages(pages, query, limit ?? 3);
      if (matches.length === 0) {
        return { pages: [] };
      }
      return { pages: await resolvePageUrls(matches, ctx) };
    },
  };
}

async function resolvePageUrls(
  pages: AgentPage[],
  ctx: FindPagesContext,
): Promise<ResolvedAgentPage[]> {
  const resolvedParams = await loadResolvableParams(pages, ctx);
  return pages.map((page) => {
    const { url, needs } = resolvePageUrl(page, resolvedParams);
    return {
      id: page.id,
      title: page.title,
      url,
      description: page.description,
      ...(needs ? { needs } : {}),
    };
  });
}

/** Fetches only the context params the matched pages actually use. */
async function loadResolvableParams(
  pages: AgentPage[],
  ctx: FindPagesContext,
): Promise<Record<string, string>> {
  const wanted = new Set(pages.flatMap((page) => page.entityParams ?? []));
  const resolved: Record<string, string> = {};

  if (wanted.has("businessSlug")) {
    const businessSlug = await resolveSlugFor(
      ctx.supabase,
      "businesses",
      "id",
      ctx.businessId,
    );
    if (businessSlug) resolved.businessSlug = businessSlug;
  }
  if (wanted.has("storeSlug")) {
    const storeSlug = await resolveFirstStoreSlug(ctx.supabase, ctx.businessId);
    if (storeSlug) resolved.storeSlug = storeSlug;
  }
  return resolved;
}

async function resolveSlugFor(
  supabase: SupabaseClient,
  table: "businesses",
  column: "id",
  id: string,
): Promise<string | null> {
  const { data } = await supabase
    .from(table)
    .select("slug")
    .eq(column, id)
    .maybeSingle();
  return data?.slug ?? null;
}

async function resolveFirstStoreSlug(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("stores")
    .select("slug")
    .eq("business_id", businessId)
    .limit(1)
    .maybeSingle();
  return data?.slug ?? null;
}
