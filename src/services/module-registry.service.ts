/**
 * Module Registry Service
 *
 * Adapter pattern that allows any platform module (publications, forms,
 * event_types, courses) to register itself as "store-listable."  Each adapter
 * implements a small contract:
 *
 *   validate  – confirm entity exists & belongs to the business
 *   fetchMeta – return display metadata (name, price, image, URL)
 *   getUrl    – build the public-facing URL for the entity
 *
 * The store service calls the registry; it never imports module-specific
 * services directly, so adding a new module requires only:
 *   1. Implement StoreListableAdapter
 *   2. Register it in MODULE_ADAPTERS below
 *   3. Add the module_type string to the DB CHECK constraint
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { ModuleLinkTypeValue } from "../types/store";

// ============================================================================
// Contract every module must implement to be store-listable
// ============================================================================

export interface EntityMeta {
  name: string;
  description?: string;
  slug?: string;
  price?: number;
  currency?: string;
  image_url?: string | null;
  url?: string;
  /** Module-specific extras (e.g. billing_cycle, plans) */
  extras?: Record<string, unknown>;
}

export interface ListableEntity {
  id: string;
  name: string;
  description?: string;
  slug?: string;
  price?: number;
  currency?: string;
  image_url?: string | null;
  /** Human-readable label for the entity type (e.g. "Circle", "Form") */
  type_label?: string;
  extras?: Record<string, unknown>;
}

export interface StoreListableAdapter {
  /** Verify entity exists and belongs to the given business. */
  validate(
    supabase: SupabaseClient,
    entityId: string,
    businessId: string,
  ): Promise<boolean>;

  /** Fetch display metadata for a single entity. */
  fetchMeta(
    supabase: SupabaseClient,
    entityId: string,
  ): Promise<EntityMeta | null>;

  /** List all entities of this module type belonging to a business. */
  listForBusiness(
    supabase: SupabaseClient,
    businessId: string,
  ): Promise<ListableEntity[]>;

  /** Build the public URL for this entity. */
  getUrl(entityId: string, slug?: string): string;
}

// ============================================================================
// Adapter implementations
// ============================================================================

const publicationAdapter: StoreListableAdapter = {
  async validate(supabase, entityId, businessId) {
    const { data } = await supabase
      .from("publications")
      .select("id")
      .eq("id", entityId)
      .eq("business_id", businessId)
      .maybeSingle();
    return !!data;
  },

  async fetchMeta(supabase, entityId) {
    const { data } = await supabase
      .from("publications")
      .select("id, name, description, profile_image, slug, monetization")
      .eq("id", entityId)
      .maybeSingle();
    if (!data) return null;
    const monetization = (data.monetization ?? {}) as Record<string, unknown>;
    const monthlyPrice = (monetization.monthly_price as number) ?? 0;
    return {
      name: data.name,
      description: data.description ?? undefined,
      slug: data.slug ?? undefined,
      price: monthlyPrice / 100, // stored in kobo, display in naira
      currency: (monetization.currency as string) ?? "NGN",
      image_url: data.profile_image ?? null,
      url: `/pub/${data.slug || data.id}`,
      extras: {
        monthly_price: monthlyPrice,
        yearly_price: (monetization.yearly_price as number) ?? 0,
      },
    };
  },

  async listForBusiness(supabase, businessId) {
    const { data } = await supabase
      .from("publications")
      .select("id, name, description, profile_image, slug, monetization")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });
    return (data ?? []).map((p) => {
      const monetization = (p.monetization ?? {}) as Record<string, unknown>;
      const monthlyPrice = (monetization.monthly_price as number) ?? 0;
      return {
        id: p.id,
        name: p.name,
        description: p.description ?? undefined,
        slug: p.slug ?? undefined,
        price: monthlyPrice / 100,
        currency: (monetization.currency as string) ?? "NGN",
        image_url: p.profile_image ?? null,
        type_label: "Publication",
        extras: {
          monthly_price: monthlyPrice,
          yearly_price: (monetization.yearly_price as number) ?? 0,
        },
      };
    });
  },

  getUrl(entityId, slug) {
    return `/pub/${slug || entityId}`;
  },
};

const formAdapter: StoreListableAdapter = {
  async validate(supabase, entityId, businessId) {
    const { data } = await supabase
      .from("hilaq_forms")
      .select("id")
      .eq("id", entityId)
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .maybeSingle();
    return !!data;
  },

  async fetchMeta(supabase, entityId) {
    const { data } = await supabase
      .from("hilaq_forms")
      .select("id, title, description, slug, access_type, payment_amount, payment_currency, payment_label")
      .eq("id", entityId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return null;
    return {
      name: data.title,
      description: data.description ?? undefined,
      slug: data.slug ?? undefined,
      price: data.access_type === "paid" ? (data.payment_amount ?? 0) : 0,
      currency: data.payment_currency ?? "NGN",
      image_url: null,
      url: `/f/${data.slug || data.id}`,
      extras: {
        access_type: data.access_type,
        payment_label: data.payment_label,
      },
    };
  },

  async listForBusiness(supabase, businessId) {
    const { data } = await supabase
      .from("hilaq_forms")
      .select("id, title, description, slug, access_type, payment_amount, payment_currency, is_published")
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .eq("is_published", true)
      .order("created_at", { ascending: false });
    return (data ?? []).map((f) => ({
      id: f.id,
      name: f.title,
      description: f.description ?? undefined,
      slug: f.slug ?? undefined,
      price: f.access_type === "paid" ? (f.payment_amount ?? 0) : 0,
      currency: f.payment_currency ?? "NGN",
      image_url: null,
      type_label: "Form",
      extras: { access_type: f.access_type },
    }));
  },

  getUrl(entityId, slug) {
    return `/f/${slug || entityId}`;
  },
};

const courseAdapter: StoreListableAdapter = {
  async validate(supabase, entityId, businessId) {
    const { data } = await supabase
      .from("courses")
      .select("id")
      .eq("id", entityId)
      .eq("business_id", businessId)
      .maybeSingle();
    return !!data;
  },

  async fetchMeta(supabase, entityId) {
    const { data } = await supabase
      .from("courses")
      .select("id, title, description, cover_image_url, access_type, price, payment_currency")
      .eq("id", entityId)
      .maybeSingle();
    if (!data) return null;
    return {
      name: data.title,
      description: data.description ?? undefined,
      price: data.access_type === "paid" ? (Number(data.price) || 0) : 0,
      currency: data.payment_currency ?? "NGN",
      image_url: data.cover_image_url ?? null,
      url: `/course/${data.id}`,
      extras: { access_type: data.access_type },
    };
  },

  async listForBusiness(supabase, businessId) {
    const { data } = await supabase
      .from("courses")
      .select("id, title, description, cover_image_url, access_type, price, payment_currency")
      .eq("business_id", businessId)
      .in("access_type", ["free", "paid"])
      .order("created_at", { ascending: false });
    return (data ?? []).map((c) => ({
      id: c.id,
      name: c.title,
      description: c.description ?? undefined,
      price: c.access_type === "paid" ? (Number(c.price) || 0) : 0,
      currency: c.payment_currency ?? "NGN",
      image_url: c.cover_image_url ?? null,
      type_label: "Course",
      extras: { access_type: c.access_type },
    }));
  },

  getUrl(entityId) {
    return `/course/${entityId}`;
  },
};

const eventTypeAdapter: StoreListableAdapter = {
  async validate(supabase, entityId, businessId) {
    const { data } = await supabase
      .from("event_types")
      .select("id")
      .eq("id", entityId)
      .eq("business_id", businessId)
      .maybeSingle();
    return !!data;
  },

  async fetchMeta(supabase, entityId) {
    const { data } = await supabase
      .from("event_types")
      .select("id, title, description, slug, duration_minutes, requires_payment, payment_amount, color, is_active")
      .eq("id", entityId)
      .maybeSingle();
    if (!data) return null;
    return {
      name: data.title,
      description: data.description ?? undefined,
      slug: data.slug ?? undefined,
      price: data.requires_payment ? (data.payment_amount ?? 0) : 0,
      currency: "NGN",
      image_url: null,
      url: `/b/${data.slug || data.id}`,
      extras: {
        duration_minutes: data.duration_minutes,
        requires_payment: data.requires_payment,
        color: data.color,
      },
    };
  },

  async listForBusiness(supabase, businessId) {
    const { data } = await supabase
      .from("event_types")
      .select("id, title, description, slug, duration_minutes, requires_payment, payment_amount, color, is_active")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    return (data ?? []).map((e) => ({
      id: e.id,
      name: e.title,
      description: e.description ?? undefined,
      slug: e.slug ?? undefined,
      price: e.requires_payment ? (e.payment_amount ?? 0) : 0,
      currency: "NGN",
      image_url: null,
      type_label: "Consultation",
      extras: {
        duration_minutes: e.duration_minutes,
        requires_payment: e.requires_payment,
        color: e.color,
      },
    }));
  },

  getUrl(_entityId, slug) {
    return `/b/${slug || _entityId}`;
  },
};

// ============================================================================
// Registry — single place to look up an adapter by module_type
// ============================================================================

const MODULE_ADAPTERS: Record<ModuleLinkTypeValue, StoreListableAdapter> = {
  publication: publicationAdapter,
  // form: formAdapter,
  event_type: eventTypeAdapter,
  course: courseAdapter,
};

export class ModuleRegistryService {
  getAdapter(moduleType: ModuleLinkTypeValue): StoreListableAdapter {
    const adapter = MODULE_ADAPTERS[moduleType];
    if (!adapter) {
      throw new Error(`No store adapter registered for module type: ${moduleType}`);
    }
    return adapter;
  }

  /** Validate that an entity exists and belongs to the given business. */
  async validate(
    supabase: SupabaseClient,
    moduleType: ModuleLinkTypeValue,
    entityId: string,
    businessId: string,
  ): Promise<boolean> {
    return this.getAdapter(moduleType).validate(supabase, entityId, businessId);
  }

  /** Fetch display metadata for a linked entity. */
  async fetchMeta(
    supabase: SupabaseClient,
    moduleType: ModuleLinkTypeValue,
    entityId: string,
  ): Promise<EntityMeta | null> {
    return this.getAdapter(moduleType).fetchMeta(supabase, entityId);
  }

  /** List all entities of a given module type for a business. */
  async listForBusiness(
    supabase: SupabaseClient,
    moduleType: ModuleLinkTypeValue,
    businessId: string,
  ): Promise<ListableEntity[]> {
    return this.getAdapter(moduleType).listForBusiness(supabase, businessId);
  }

  /**
   * List all entities across ALL module types for a business.
   *
   * Uses a single Postgres RPC (`get_linkable_items`) that queries all module
   * tables in one round-trip instead of separate PostgREST calls.
   * Falls back to the parallel-query path if the RPC is unavailable.
   */
  async listAllForBusiness(
    supabase: SupabaseClient,
    businessId: string,
  ): Promise<Record<ModuleLinkTypeValue, ListableEntity[]>> {
    const { data, error } = await supabase.rpc("get_linkable_items", {
      p_business_id: businessId,
    });

    if (!error && data) {
      // RPC returns JSONB shaped as { publication: [], event_type: [], course: [] }
      return {
        publication: (data.publication ?? []) as ListableEntity[],
        // form:     (data.form        ?? []) as ListableEntity[],
        event_type:  (data.event_type  ?? []) as ListableEntity[],
        course:      (data.course      ?? []) as ListableEntity[],
      };
    }

    // Fallback: run the registered adapters in parallel (pre-RPC behaviour)
    console.warn("get_linkable_items RPC unavailable, falling back to parallel queries:", error?.message);
    const types = Object.keys(MODULE_ADAPTERS) as ModuleLinkTypeValue[];
    const results = await Promise.all(
      types.map(async (type) => ({
        type,
        items: await this.getAdapter(type).listForBusiness(supabase, businessId),
      })),
    );
    return Object.fromEntries(results.map((r) => [r.type, r.items])) as Record<
      ModuleLinkTypeValue,
      ListableEntity[]
    >;
  }

  /** Build the public URL for a linked entity. */
  getUrl(moduleType: ModuleLinkTypeValue, entityId: string, slug?: string): string {
    return this.getAdapter(moduleType).getUrl(entityId, slug);
  }

  /** All registered module type keys. */
  get registeredTypes(): ModuleLinkTypeValue[] {
    return Object.keys(MODULE_ADAPTERS) as ModuleLinkTypeValue[];
  }
}

export const moduleRegistryService = new ModuleRegistryService();
