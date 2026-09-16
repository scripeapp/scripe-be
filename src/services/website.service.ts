import { SupabaseClient } from "@supabase/supabase-js";
import { StorageService } from "./storage.service";
import { z } from "zod";
import {
  WebsiteSchema,
  DefaultWebsite,
  Website,
  Page,
  Section,
  DomainSchema,
  SubdomainSchema,
  PageUpdate,
  NavigationSchema,
} from "../types/website";
import { randomUUID } from "crypto";
import publicSupabase from "../config/supabase";

// Soft limits to keep payloads reasonable
const MAX_PAGES = 50;
const MAX_SECTIONS_PER_PAGE = 50;

// Reserved subdomains that cannot be used
const RESERVED_SUBDOMAINS = [
  "www",
  "api",
  "admin",
  "app",
  "mail",
  "email",
  "ftp",
  "cdn",
  "assets",
  "static",
  "help",
  "support",
  "blog",
  "docs",
  "status",
  "dashboard",
  "login",
  "signup",
  "signin",
  "register",
  "auth",
  "oauth",
  "sso",
  "account",
  "billing",
  "payment",
  "checkout",
  "store",
  "shop",
  "test",
  "dev",
  "staging",
  "preview",
  "demo",
];

// Subdomain format regex: 3-30 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens
const SUBDOMAIN_FORMAT_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Validate page/section counts to prevent extreme payloads
function ensureLimits(site: Website) {
  if (site.pages.length > MAX_PAGES) throw new Error("Too many pages");
  site.pages.forEach((p: Page) => {
    if (p.sections.length > MAX_SECTIONS_PER_PAGE)
      throw new Error("Too many sections");
  });
}

export interface CheckSubdomainResponse {
  available: boolean;
  reason?: "invalid_format" | "reserved" | "taken";
  message?: string;
}

// Map a DB row to the API model shape
function dbToModel(row: any): Website {
  return {
    id: row.id,
    userId: row.user_id,
    businessId: row.business_id ?? undefined,
    domain: row.domain ?? undefined,
    subdomain: row.subdomain ?? undefined,
    isLive: !!row.is_live,
    design: row.design,
    navigation: row.navigation,
    pages: row.pages,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// Map API model to DB columns for persistence
function modelToDb(site: Website) {
  return {
    id: site.id,
    user_id: site.userId,
    business_id: site.businessId ?? null,
    domain: site.domain ?? null,
    subdomain: site.subdomain ?? null,
    is_live: site.isLive,
    design: site.design,
    navigation: site.navigation,
    pages: site.pages,
    created_at: site.createdAt,
    updated_at: site.updatedAt,
  };
}

export class WebsiteService {
  private storageService: StorageService;
  constructor(private supabase: SupabaseClient) {
    this.storageService = new StorageService(supabase);
  }

  /**
   * Check if a subdomain is available for use.
   */
  async checkSubdomainAvailability(
    subdomain: string,
  ): Promise<CheckSubdomainResponse> {
    const normalized = subdomain.toLowerCase().trim();

    if (normalized.length < 3 || normalized.length > 30) {
      return {
        available: false,
        reason: "invalid_format",
        message: "Subdomain must be 3-30 characters",
      };
    }

    if (!SUBDOMAIN_FORMAT_REGEX.test(normalized)) {
      return {
        available: false,
        reason: "invalid_format",
        message:
          "Subdomain must contain only lowercase letters, numbers, and hyphens (no leading/trailing hyphens)",
      };
    }

    if (RESERVED_SUBDOMAINS.includes(normalized)) {
      return {
        available: false,
        reason: "reserved",
        message: "This subdomain is reserved",
      };
    }

    const { data, error } = await this.supabase
      .from("websites")
      .select("id")
      .eq("subdomain", normalized)
      .limit(1);

    if (error) throw error;

    if (Array.isArray(data) && data.length > 0) {
      return {
        available: false,
        reason: "taken",
        message: "This subdomain is already in use",
      };
    }

    return { available: true };
  }

  /**
   * Initialize a website for a user or return the existing one.
   */
  async initUserWebsite(
    userId: string,
    overrides?: Partial<Website>,
    businessId?: string,
  ): Promise<Website> {
    let query = this.supabase.from("websites").select("*");
    if (businessId) {
      query = query.eq("business_id", businessId);
    } else {
      query = query.eq("user_id", userId);
    }

    const { data: existing } = await query.single();

    if (existing) return dbToModel(existing);
    const id = randomUUID();
    let site = DefaultWebsite(userId, id, businessId);
    if (overrides) site = { ...site, ...overrides } as Website;
    ensureLimits(site);
    const validated = WebsiteSchema.parse(site);
    const { data, error } = await this.supabase
      .from("websites")
      .insert([modelToDb(validated)])
      .select("*")
      .single();
    if (error) throw error;
    return dbToModel(data);
  }

  /**
   * Load a website by user (private) or by domain/subdomain (public when live).
   */
  async loadWebsiteByQuery(opts: {
    userId?: string;
    domain?: string;
    subdomain?: string;
    requesterId?: string;
    businessId?: string;
  }): Promise<Website | null> {
    const { userId, domain, subdomain, requesterId, businessId } = opts;

    if (userId || businessId) {
      if (requesterId && userId && requesterId !== userId)
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });

      let query = this.supabase.from("websites").select("*");

      if (businessId) {
        query = query.eq("business_id", businessId);
      } else if (userId) {
        query = query.eq("user_id", userId);
      }

      const { data, error } = await query.limit(1);

      if (error) throw error;
      const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
      return row ? dbToModel(row) : null;
    }
    if (domain) {
      const { data, error } = await this.supabase
        .from("websites")
        .select("*")
        .eq("domain", domain)
        .eq("is_live", true)
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
      return row ? dbToModel(row) : null;
    }
    if (subdomain) {
      const { data, error } = await this.supabase
        .from("websites")
        .select("*")
        .eq("subdomain", subdomain)
        .eq("is_live", true)
        .limit(1);
      if (error) throw error;
      const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
      return row ? dbToModel(row) : null;
    }
    return null;
  }

  /**
   * Upsert a user's website with validation and limits.
   */
  async saveUserWebsite(
    userId: string,
    payload: Partial<Website>,
    businessId?: string,
  ): Promise<Website> {
    let query = this.supabase.from("websites").select("*");
    if (businessId) query = query.eq("business_id", businessId);
    else query = query.eq("user_id", userId);

    const { data: existingRows, error: existingErr } = await query.limit(1);
    if (existingErr) throw existingErr;
    const existing =
      Array.isArray(existingRows) && existingRows.length > 0
        ? existingRows[0]
        : null;
    const merged: Website = existing
      ? ({ ...dbToModel(existing), ...payload } as Website)
      : ({
          ...DefaultWebsite(userId, randomUUID(), businessId),
          ...payload,
        } as Website);
    ensureLimits(merged);
    const validated = WebsiteSchema.parse(merged);

    const dbPayload = modelToDb(validated);
    if (businessId) dbPayload.business_id = businessId;

    const upserted = await this.supabase
      .from("websites")
      .upsert(dbPayload, { onConflict: "id" })
      .select("*")
      .single();
    if (upserted.error) throw upserted.error;
    return dbToModel(upserted.data);
  }

  /**
   * Toggle live status and optionally set domain/subdomain with uniqueness checks.
   */
  async setWebsitePublication(
    userId: string,
    body: { isLive: boolean; domain?: string; subdomain?: string },
    businessId?: string,
  ): Promise<Website> {
    let query = this.supabase.from("websites").select("*");
    if (businessId) query = query.eq("business_id", businessId);
    else query = query.eq("user_id", userId);

    const { data: existing, error } = await query.single();
    if (error) throw error;
    let domain = body.domain?.toLowerCase();
    let subdomain = body.subdomain?.toLowerCase();
    if (body.isLive) {
      if (domain) DomainSchema.parse(domain);
      if (subdomain) SubdomainSchema.parse(subdomain);
      if (domain) {
        const { data } = await this.supabase
          .from("websites")
          .select("id")
          .eq("domain", domain)
          .limit(1);
        const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
        if (row && row.id !== existing.id)
          throw Object.assign(new Error("Domain already in use"), {
            statusCode: 409,
          });
      }
      if (subdomain) {
        const { data } = await this.supabase
          .from("websites")
          .select("id")
          .eq("subdomain", subdomain)
          .limit(1);
        const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
        if (row && row.id !== existing.id)
          throw Object.assign(new Error("Subdomain already in use"), {
            statusCode: 409,
          });
      }
    } else {
      domain = existing.domain;
      subdomain = existing.subdomain;
    }
    const updated = await this.supabase
      .from("websites")
      .update({ is_live: body.isLive, domain, subdomain })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (updated.error) throw updated.error;
    return dbToModel(updated.data);
  }

  /**
   * Update only the navigation JSON for the user's website.
   */
  async updateWebsiteNavigation(
    userId: string,
    navigation: Website["navigation"],
    businessId?: string,
  ): Promise<Website> {
    const validatedNav = NavigationSchema.parse(navigation);

    let query = this.supabase.from("websites").select("*");
    if (businessId) query = query.eq("business_id", businessId);
    else query = query.eq("user_id", userId);

    const { data: existing, error } = await query.single();
    if (error) throw error;

    const site = dbToModel(existing);
    const nextUpdatedAt = new Date().toISOString();
    const { data: saved, error: saveErr } = await this.supabase
      .from("websites")
      .update({ navigation: validatedNav, updated_at: nextUpdatedAt })
      .eq("id", site.id)
      .select("*")
      .single();
    if (saveErr) throw saveErr;
    return dbToModel(saved);
  }

  /**
   * Add/update/delete a page in the user's website with invariants (unique slug, required page).
   */
  async updateWebsitePage(
    userId: string,
    input: {
      action: "add" | "update" | "delete";
      page?: Page;
      pageId?: string;
      updates?: Partial<PageUpdate>;
    },
    businessId?: string,
  ): Promise<Website> {
    let query = this.supabase.from("websites").select("*");
    if (businessId) query = query.eq("business_id", businessId);
    else query = query.eq("user_id", userId);

    const { data: existing, error } = await query.single();
    if (error) throw error;
    const site = dbToModel(existing);
    let pages = site.pages;
    if (input.action === "add" && input.page) {
      if (
        pages.find((p: Page) => p.metadata.slug === input.page!.metadata.slug)
      )
        throw Object.assign(new Error("Slug already exists"), {
          statusCode: 400,
        });
      pages = [...pages, input.page];
    } else if (input.action === "update" && input.pageId && input.updates) {
      pages = pages.map((p: Page) =>
        p.metadata.id === input.pageId
          ? {
              ...p,
              ...input.updates,
              metadata: {
                ...p.metadata,
                ...(input.updates?.metadata ?? {}),
                id: p.metadata.id,
                createdAt: p.metadata.createdAt,
                lastUpdated: new Date().toISOString(),
                name: input.updates?.metadata?.name ?? p.metadata.name,
                slug: input.updates?.metadata?.slug ?? p.metadata.slug,
                status: input.updates?.metadata?.status ?? p.metadata.status,
                required:
                  typeof input.updates?.metadata?.required === "boolean"
                    ? input.updates.metadata.required
                    : p.metadata.required,
                icon: input.updates?.metadata?.icon ?? p.metadata.icon,
                seo: (() => {
                  const incomingSeo =
                    input.updates?.metadata?.seo ?? p.metadata.seo;
                  if (!incomingSeo) return undefined;
                  return {
                    title: incomingSeo.title ?? "",
                    description: incomingSeo.description ?? "",
                    keywords: incomingSeo.keywords,
                    ogImage: incomingSeo.ogImage,
                    canonical: incomingSeo.canonical,
                    noindex: incomingSeo.noindex,
                  };
                })(),
              },
            }
          : p,
      );
    } else if (input.action === "delete" && input.pageId) {
      const target = pages.find((p: Page) => p.metadata.id === input.pageId);
      if (!target)
        throw Object.assign(new Error("Page not found"), { statusCode: 404 });
      if (target.metadata.required)
        throw Object.assign(new Error("Cannot delete required page"), {
          statusCode: 400,
        });
      pages = pages.filter((p: Page) => p.metadata.id !== input.pageId);
    }
    const updatedSite = { ...site, pages } as Website;
    ensureLimits(updatedSite);
    const validated = WebsiteSchema.parse(updatedSite);
    const { data: saved, error: saveErr } = await this.supabase
      .from("websites")
      .update({ pages: validated.pages })
      .eq("id", site.id)
      .select("*")
      .single();
    if (saveErr) throw saveErr;
    return dbToModel(saved);
  }

  /**
   * Add/update/delete/toggle a section in a specific page.
   */
  async updatePageSection(
    userId: string,
    input: {
      action: "add" | "update" | "delete" | "toggle" | "reorder";
      pageId: string;
      section?: Section;
      sectionId?: string;
      updates?: Partial<Section>;
      orderedIds?: string[];
    },
    businessId?: string,
  ): Promise<Website> {
    let query = this.supabase.from("websites").select("*");
    if (businessId) query = query.eq("business_id", businessId);
    else query = query.eq("user_id", userId);

    const { data: existing, error } = await query.single();
    if (error) throw error;
    const site = dbToModel(existing);
    const pageIdx = site.pages.findIndex(
      (p: Page) => p.metadata.id === input.pageId,
    );
    if (pageIdx < 0)
      throw Object.assign(new Error("Page not found"), { statusCode: 404 });
    const page = site.pages[pageIdx];
    let sections = page.sections;
    if (input.action === "add" && input.section) {
      sections = [...sections, input.section];
    } else if (input.action === "update" && input.sectionId && input.updates) {
      sections = sections.map((s: Section) =>
        s.id === input.sectionId ? { ...s, ...input.updates } : s,
      );
    } else if (input.action === "delete" && input.sectionId) {
      if (!sections.some((s: Section) => s.id === input.sectionId))
        throw Object.assign(new Error("Section not found"), {
          statusCode: 404,
        });
      sections = sections.filter((s: Section) => s.id !== input.sectionId);
    } else if (input.action === "toggle" && input.sectionId) {
      sections = sections.map((s: Section) =>
        s.id === input.sectionId ? { ...s, visible: !s.visible } : s,
      );
    } else if (input.action === "reorder" && Array.isArray(input.orderedIds)) {
      const currentIds = sections.map((s: Section) => s.id);
      if (
        currentIds.length !== input.orderedIds.length ||
        !currentIds.every((id: string) => input.orderedIds!.includes(id))
      ) {
        throw Object.assign(new Error("Invalid orderedIds set"), {
          statusCode: 422,
        });
      }
      const bannerId = sections.find(
        (s: Section) => s.type === "welcome-banner",
      )?.id;
      const footerId = sections.find((s: Section) => s.type === "footer")?.id;
      if (bannerId && input.orderedIds[0] !== bannerId)
        throw Object.assign(new Error("Banner section must remain first"), {
          statusCode: 422,
        });
      if (
        footerId &&
        input.orderedIds[input.orderedIds.length - 1] !== footerId
      )
        throw Object.assign(new Error("Footer section must remain last"), {
          statusCode: 422,
        });

      const byId = new Map(sections.map((s: Section) => [s.id, s] as const));
      sections = input.orderedIds.map((id: string, idx: number) => ({
        ...byId.get(id)!,
        order: idx,
      }));
    }
    const updatedPage = { ...page, sections };
    const updatedSite = {
      ...site,
      pages: site.pages.map((p: Page, i: number) =>
        i === pageIdx ? updatedPage : p,
      ),
    } as Website;
    ensureLimits(updatedSite);
    const validated = WebsiteSchema.parse(updatedSite);
    const { data: saved, error: saveErr } = await this.supabase
      .from("websites")
      .update({ pages: validated.pages })
      .eq("id", site.id)
      .select("*")
      .single();
    if (saveErr) throw saveErr;
    return dbToModel(saved);
  }

  /**
   * Resolve linked entities for website sections.
   */
  async resolveLinkedEntities(
    website: Website,
  ): Promise<{ website: Website; resolvedData: Record<string, any> }> {
    const resolvedData: Record<string, any> = {};

    for (const page of website.pages) {
      for (const section of page.sections) {
        const linked = (section as any).linkedEntity;
        if (!linked?.type) continue;

        const sectionKey = section.id;

        try {
          switch (linked.type) {
            case "store": {
              const storeSlug = linked.slug || linked.id;
              if (!storeSlug) break;

              const { data: store, error: storeError } = await this.supabase
                .from("stores")
                .select("id, name, slug, appearance, is_live")
                .eq("slug", storeSlug)
                .single();

              if (store) {
                const sectionType = section.type;
                let products: any[] = [];
                const productFields =
                  "id, name, price, cover_image, status, compare_at_price, currency, type";

                if (sectionType === "store-featured-products") {
                  const { data } = await this.supabase
                    .from("products")
                    .select(productFields)
                    .eq("store_id", store.id)
                    .eq("status", "published")
                    .eq("is_sellable", true)
                    .order("created_at", { ascending: false })
                    .limit(section.content?.limit || 6);
                  products = data || [];
                } else if (sectionType === "store-product-list") {
                  const { data } = await this.supabase
                    .from("products")
                    .select(`${productFields}, description`)
                    .eq("store_id", store.id)
                    .eq("status", "published")
                    .eq("is_sellable", true)
                    .order("created_at", { ascending: false })
                    .limit(section.content?.limit || 50);
                  products = data || [];
                }

                let categories: any[] = [];
                if (sectionType === "store-categories") {
                  const { data } = await this.supabase
                    .from("store_categories")
                    .select("id, name, slug, image_url, product_count")
                    .eq("store_id", store.id)
                    .order("sort_order", { ascending: true });
                  categories = data || [];
                }

                resolvedData[sectionKey] = { store, products, categories };
              }
              break;
            }

            case "event": {
              const eventId = linked.id;
              if (!eventId) break;
              const { data: event } = await this.supabase
                .from("events")
                .select(
                  "id, name, description, start_date, end_date, location, cover_image, status",
                )
                .eq("id", eventId)
                .single();
              if (event) resolvedData[sectionKey] = { event };
              break;
            }

            case "publication": {
              const pubSlug = linked.slug || linked.id;
              if (!pubSlug) break;
              const { data: publication } = await this.supabase
                .from("publications")
                .select("id, name, description, logo, slug")
                .eq("slug", pubSlug)
                .single();
              if (publication) {
                const { data: posts } = await this.supabase
                  .from("posts")
                  .select(
                    "id, title, subtitle, cover_image, publish_time, slug",
                  )
                  .eq("publication_id", publication.id)
                  .eq("status", "published")
                  .order("publish_time", { ascending: false })
                  .limit(section.content?.limit || 10);
                resolvedData[sectionKey] = { publication, posts: posts || [] };
              }
              break;
            }
          }
        } catch (err) {
          console.warn(
            `Failed to resolve linked entity for section ${sectionKey}:`,
            err,
          );
          resolvedData[sectionKey] = { error: "Failed to load data" };
        }
      }
    }

    return { website, resolvedData };
  }

  /**
   * Upload logo for a website
   */
  async uploadLogo(websiteId: string, file: Express.Multer.File) {
    const fileExt = file.originalname.split(".").pop();
    const fileName = `logo.${fileExt}`;
    const filePath = `websites/${websiteId}/logo/${fileName}`;
    return this.storageService.uploadFile("websites", filePath, file, true);
  }

  /**
   * Upload section image for a website
   */
  async uploadSectionImage(
    websiteId: string,
    sectionId: string,
    prefix: string,
    file: Express.Multer.File,
  ) {
    const fileExt = file.originalname.split(".").pop();
    const fileName = `${Date.now()}.${fileExt}`;
    const filePath = `websites/${websiteId}/${prefix}/${sectionId}/${fileName}`;
    return this.storageService.uploadFile("websites", filePath, file, false);
  }
}

export default WebsiteService;
