/**
 * Executes approved pending actions. Each action type maps to a required
 * permission and a real service call — the agent only prepares actions;
 * this registry is the ONLY path that mutates business data.
 *
 * New action types (product.create, scheduling.event_type.create, …) are
 * one registry entry + one tool that emits a pending action. Create and
 * update variants share their entity-resolution logic so identity rules
 * can't drift between the two.
 */
import { SupabaseClient } from "@supabase/supabase-js";
import { PendingAction } from "../../types/ai-agent.types";
import { EventService } from "../events.services";
import { SchedulingService } from "../scheduling.service";
import { StoreService } from "../store.service";
import { publicWebUrl } from "./page-registry.service";

type ActionExecutor = (
  supabase: SupabaseClient,
  action: PendingAction,
) => Promise<{ ok: boolean; result: unknown }>;

/** Fills the event_tickets NOT-NULL columns the model does not ask for.
 *  Guards against stale pending actions created before the tool carried
 *  defaults. */
function normalizeTickets(tickets: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tickets)) return [];
  return tickets.map((ticket) => {
    const t = (ticket ?? {}) as Record<string, unknown>;
    return {
      ticket_name: String(t.ticket_name ?? "").trim(),
      ticket_price: Number(t.ticket_price ?? 0),
      available_quantity: Number(t.available_quantity ?? 0),
      ticket_is_limited_stock: t.ticket_is_limited_stock ?? true,
      quantity_sold: Number(t.quantity_sold ?? 0),
    };
  });
}

const eventCreateExecutor: ActionExecutor = async (supabase, action) => {
  const service = new EventService(supabase);
  const payload = {
    ...(action.payload as Record<string, unknown>),
    tickets: normalizeTickets((action.payload as Record<string, unknown>).tickets),
  };
  const created = await service.createEvent(payload, action.businessId, {
    actorUserId: action.userId,
  });
  const eventUrl = created.event_url ?? null;
  return {
    ok: true,
    result: {
      eventId: created.id,
      eventName: created.event_name,
      status: created.status,
      ticketCount: created.tickets?.length ?? 0,
      eventUrl,
      url: eventUrl ? publicWebUrl(`/events/${eventUrl}`) : null,
      editUrl: publicWebUrl(`/events/edit/${created.id}`),
    },
  };
};

const eventTypeCreateExecutor: ActionExecutor = async (supabase, action) => {
  const payload = action.payload as Record<string, unknown>;
  const title = String(payload.title || "").trim();

  const service = new SchedulingService(supabase);
  const created = await service.createEventType(
    action.userId,
    action.businessId,
    { ...payload, slug: slugify(title) } as Parameters<SchedulingService["createEventType"]>[2],
  );
  const businessSlug = await resolveBusinessSlug(supabase, action.businessId);
  return {
    ok: true,
    result: {
      eventTypeId: created.id,
      title: created.title,
      slug: created.slug,
      url:
        businessSlug && created.slug
          ? publicWebUrl(`/b/${businessSlug}/${created.slug}`)
          : null,
    },
  };
};

/** The business's first store — the product tools' tenant anchor. */
async function resolveFirstStore(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ id: string; name: string; slug: string }> {
  const { data: store } = await supabase
    .from("stores")
    .select("id, name, slug")
    .eq("business_id", businessId)
    .limit(1)
    .maybeSingle();

  if (!store) {
    throw new Error(
      "No store found for this business — create a store first, then ask me again.",
    );
  }
  return store;
}

async function resolveBusinessSlug(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string | null> {
  const { data: business } = await supabase
    .from("businesses")
    .select("slug")
    .eq("id", businessId)
    .maybeSingle();
  return business?.slug ?? null;
}

/** Admin edit page for a draft product — its public page 404s until the
 *  product is published, so drafts always link here. */
function productShareUrls(
  store: { slug: string },
  created: { id: string; slug?: string },
): { storeSlug: string; productSlug: string; url: string | null; editUrl: string } {
  const storeSlug = store.slug;
  const productSlug = created.slug ?? "";
  return {
    storeSlug,
    productSlug,
    url:
      storeSlug && productSlug
        ? publicWebUrl(`/s/${storeSlug}/${productSlug}`)
        : null,
    editUrl: publicWebUrl(`/dashboard/store/product/${created.id}`),
  };
}

const productCreateExecutor: ActionExecutor = async (supabase, action) => {
  const store = await resolveFirstStore(supabase, action.businessId);
  const payload = action.payload as Record<string, unknown>;

  const service = new StoreService(supabase);
  const created = await service.addProduct(
    store.id,
    {
      name: String(payload.name || "").trim(),
      price: Number(payload.price),
      currency: String(payload.currency || "NGN"),
      type: "physical",
      stock: payload.stock !== undefined ? Number(payload.stock) : null,
      description:
        payload.description !== undefined
          ? String(payload.description).trim()
          : "",
      status: "draft",
    } as never,
    action.userId,
    action.businessId,
  );
  return {
    ok: true,
    result: {
      productId: created.id,
      productName: created.name,
      price: created.price,
      status: created.status,
      storeId: store.id,
      ...productShareUrls(store, created as { id: string; slug?: string }),
    },
  };
};

/** Strip the identity and rename markers, leaving only real column
 *  values. Unknown keys never reach the DB — the tool schemas are strict
 *  and the executors also drop the identity fields they consume. */
function columnUpdates(
  payload: Record<string, unknown>,
  identityKeys: string[],
  renameKey: string,
  columnKey: string,
): Record<string, unknown> {
  const updates = { ...payload };
  for (const key of identityKeys) delete updates[key];
  const newName = updates[renameKey];
  delete updates[renameKey];
  if (newName !== undefined) {
    updates[columnKey] = String(newName).trim();
  }
  return updates;
}

const eventUpdateExecutor: ActionExecutor = async (supabase, action) => {
  const payload = action.payload as Record<string, unknown>;
  const currentName = String(payload.event_name || "").trim();

  const { data: event } = await supabase
    .from("events")
    .select("id")
    .eq("business_id", action.businessId)
    .ilike("event_name", currentName)
    .limit(1)
    .maybeSingle();

  if (!event) {
    throw new Error(
      `No event named "${currentName}" was found for this business. Tell the merchant to check the name, or ask them which event they meant.`,
    );
  }

  const service = new EventService(supabase);
  const updated = await service.updateEvent(
    event.id,
    columnUpdates(payload, ["event_name"], "new_name", "event_name"),
  );
  const eventUrl = updated.event_url ?? null;
  return {
    ok: true,
    result: {
      eventId: updated.id,
      eventName: updated.event_name,
      status: updated.status,
      eventUrl,
      url: eventUrl ? publicWebUrl(`/events/${eventUrl}`) : null,
      editUrl: publicWebUrl(`/events/edit/${updated.id}`),
    },
  };
};

const eventTypeUpdateExecutor: ActionExecutor = async (supabase, action) => {
  const payload = action.payload as Record<string, unknown>;
  const currentTitle = String(payload.title || "").trim();

  const { data: eventType } = await supabase
    .from("event_types")
    .select("id")
    .eq("business_id", action.businessId)
    .ilike("title", currentTitle)
    .limit(1)
    .maybeSingle();

  if (!eventType) {
    throw new Error(
      `No booking type named "${currentTitle}" was found for this business. Tell the merchant to check the name, or ask them which one they meant.`,
    );
  }

  const service = new SchedulingService(supabase);
  const updated = await service.updateEventType(
    eventType.id,
    action.userId,
    columnUpdates(
      payload,
      ["title"],
      "new_title",
      "title",
    ) as Parameters<SchedulingService["updateEventType"]>[2],
  );
  const businessSlug = await resolveBusinessSlug(supabase, action.businessId);
  return {
    ok: true,
    result: {
      eventTypeId: updated.id,
      title: updated.title,
      slug: updated.slug,
      url:
        businessSlug && updated.slug
          ? publicWebUrl(`/b/${businessSlug}/${updated.slug}`)
          : null,
    },
  };
};

const productUpdateExecutor: ActionExecutor = async (supabase, action) => {
  const store = await resolveFirstStore(supabase, action.businessId);
  const payload = action.payload as Record<string, unknown>;
  const currentName = String(payload.name || "").trim();

  const { data: product } = await supabase
    .from("products")
    .select("id")
    .eq("store_id", store.id)
    .ilike("name", currentName)
    .limit(1)
    .maybeSingle();

  if (!product) {
    throw new Error(
      `No product named "${currentName}" was found in ${store.name}. Tell the merchant to check the name, or ask them which product they meant.`,
    );
  }

  const service = new StoreService(supabase);
  const updated = await service.updateProduct(
    store.id,
    product.id,
    columnUpdates(payload, ["name"], "new_name", "name") as never,
    action.userId,
    action.businessId,
  );
  return {
    ok: true,
    result: {
      productId: updated.id,
      productName: updated.name,
      price: updated.price,
      status: updated.status,
      storeId: store.id,
      ...productShareUrls(store, updated as { id: string; slug?: string }),
    },
  };
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const ACTION_EXECUTORS: Record<string, ActionExecutor> = {
  "event.create": eventCreateExecutor,
  "event.update": eventUpdateExecutor,
  "scheduling.event_type.create": eventTypeCreateExecutor,
  "scheduling.event_type.update": eventTypeUpdateExecutor,
  "product.create": productCreateExecutor,
  "product.update": productUpdateExecutor,
};

export const ACTION_PERMISSIONS: Record<string, string> = {
  "event.create": "event.create",
  "event.update": "event.update",
  "scheduling.event_type.create": "event.create",
  "scheduling.event_type.update": "event.update",
  "product.create": "store.product.create",
  "product.update": "store.product.update",
};

export function actionPermission(actionType: string): string | null {
  return ACTION_PERMISSIONS[actionType] ?? null;
}

export async function executePendingAction(
  supabase: SupabaseClient,
  action: PendingAction,
): Promise<{ ok: boolean; result: unknown }> {
  const executor = ACTION_EXECUTORS[action.type];
  if (!executor) {
    throw new Error(`Unknown action type: ${action.type}`);
  }
  return executor(supabase, action);
}