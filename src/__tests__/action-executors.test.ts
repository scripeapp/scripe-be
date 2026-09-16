/**
 * Executor tests for the scheduling + product action types. Supabase
 * admin clients are mocked at the module level (same pattern as
 * membership.integration.test.ts); the executor's request-scoped client
 * is a per-test chain mock.
 */

jest.mock("../config/supabase", () => {
  return {
    supabaseAdmin: {
      from: jest.fn((_table: string) => mockChain({ data: null, error: null })),
    },
  };
});

jest.mock("../config/supabaseAdmin", () => {
  const from = jest.fn((_table: string) =>
    mockChain({ data: null, error: null }),
  );
  return { supabaseAdmin: { from }, default: { from } };
});

import { supabaseAdmin } from "../config/supabase";
import { supabaseAdmin as schedulingAdmin } from "../config/supabaseAdmin";
import { executePendingAction } from "../services/ai/action-executor.service";
import { publicWebUrl } from "../services/ai/page-registry.service";
import { PendingAction } from "../types/ai-agent.types";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

const STORE = { id: "store-1", name: "Hilaq Store", slug: "hilaq-store" };
const PRODUCT_ROW = {
  id: "prod-1",
  name: "Hoodie",
  price: 5000,
  status: "draft",
  slug: "hoodie",
};
const EVENT_TYPE_ROW = { id: "et-1", title: "Consultation", slug: "consultation" };

interface MockChain {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  eq: jest.Mock;
  is: jest.Mock;
  in: jest.Mock;
  ilike: jest.Mock;
  limit: jest.Mock;
  range: jest.Mock;
  order: jest.Mock;
  maybeSingle: jest.Mock;
  single: jest.Mock;
  then: (resolve?: (v: unknown) => void, reject?: (e: unknown) => void) => Promise<void>;
}

/** A thenable chain: every query method returns the chain itself, so an
 *  `await` anywhere in the chain resolves to `terminal`. Methods are
 *  jest.fn so tests can inspect query shapes. */
function mockChain(terminal: unknown): MockChain {
  const chain: MockChain = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    is: jest.fn(() => chain),
    in: jest.fn(() => chain),
    ilike: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    range: jest.fn(() => chain),
    order: jest.fn(() => chain),
    maybeSingle: jest.fn(async () => terminal),
    single: jest.fn(async () => terminal),
    then: (resolve?: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(terminal).then(resolve, reject),
  };
  return chain;
}

function buildFrom(routes: Record<string, unknown>) {
  return {
    from: (table: string) => mockChain(routes[table] ?? { data: null, error: null }),
  };
}

function pendingAction(
  type: string,
  payload: Record<string, unknown>,
): PendingAction {
  return {
    actionId: `action-${type}`,
    type,
    businessId: BUSINESS_ID,
    userId: USER_ID,
    payload,
    summary: { title: "", body: "", label: "", cta: "", signal: 0 },
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

function lastInsertArg(fromMock: jest.Mock): Record<string, unknown> {
  const results = fromMock.mock.results as Array<{
    value: { insert?: jest.Mock };
  }>;
  const inserts = results.filter((r) => r.value?.insert?.mock.calls.length);
  const chain = inserts[inserts.length - 1]?.value;
  const call = chain?.insert?.mock.calls[0];
  const raw = (call?.[0] ?? {}) as unknown;
  return (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
}

function lastUpdateArg(fromMock: jest.Mock): Record<string, unknown> {
  const results = fromMock.mock.results as Array<{
    value: { update?: jest.Mock };
  }>;
  const updates = results.filter((r) => r.value?.update?.mock.calls.length);
  const chain = updates[updates.length - 1]?.value;
  const call = chain?.update?.mock.calls[0];
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

function insertArgForTable(fromMock: jest.Mock, table: string): Record<string, unknown> {
  const callIndex = fromMock.mock.calls.findIndex((call) => call[0] === table);
  const chain = fromMock.mock.results[callIndex]?.value as
    | { insert?: jest.Mock }
    | undefined;
  const call = chain?.insert?.mock.calls[0];
  const raw = (call?.[0] ?? {}) as unknown;
  return (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
}

describe("scheduling.event_type.create executor", () => {
  it("derives a slug from the title and returns the booking page URL", async () => {
    const from = schedulingAdmin!.from as jest.Mock;
    from.mockImplementation((table: string) =>
      mockChain(
        table === "event_types"
          ? { data: EVENT_TYPE_ROW, error: null }
          : table === "businesses"
            ? { data: { slug: "hilaq-consulting" }, error: null }
            : { data: null, error: null },
      ),
    );

    const outcome = await executePendingAction(
      buildFrom({
        businesses: { data: { slug: "hilaq-consulting" }, error: null },
      }) as never,
      pendingAction("scheduling.event_type.create", {
        title: "Product Consultation!",
        duration_minutes: 30,
        location_type: "google_meet",
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      eventTypeId: "et-1",
      title: "Consultation",
      slug: "consultation",
      url: publicWebUrl("/b/hilaq-consulting/consultation"),
    });

    const inserted = lastInsertArg(from);
    expect(inserted.slug).toBe("product-consultation");
    expect(inserted.title).toBe("Product Consultation!");
    expect(inserted.business_id).toBe(BUSINESS_ID);
    expect(inserted.user_id).toBe(USER_ID);
  });
});

describe("event.create executor", () => {
  it("fills the event_tickets NOT-NULL columns when a ticket is given", async () => {
    const routes: Record<string, unknown> = {
      events: {
        data: { id: "event-1", event_name: "Fest", status: "draft" },
        error: null,
      },
      event_tickets: { data: [{ id: "ticket-1" }], error: null },
      audit_logs: { data: null, error: null },
    };
    const fromMock = jest.fn((table: string) =>
      mockChain(routes[table] ?? { data: null, error: null }),
    );

    const outcome = await executePendingAction(
      { from: fromMock } as never,
      pendingAction("event.create", {
        event_name: "Fest",
        start_date: "2026-09-12",
        start_time: "16:00",
        tickets: [
          { ticket_name: "General", ticket_price: 5000, available_quantity: 100 },
        ],
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toMatchObject({
      eventId: "event-1",
      eventName: "Fest",
      status: "draft",
      eventUrl: null,
      url: null,
      editUrl: publicWebUrl("/events/edit/event-1"),
    });
    const inserted = insertArgForTable(fromMock, "event_tickets");
    expect(inserted.ticket_name).toBe("General");
    expect(inserted.ticket_is_limited_stock).toBe(true);
    expect(inserted.quantity_sold).toBe(0);
    expect(inserted.event_id).toBe("event-1");
  });
});

describe("product.create executor", () => {
  it("resolves the business store and creates a draft product", async () => {
    const routes: Record<string, unknown> = {
      stores: { data: STORE, error: null },
      products: { data: PRODUCT_ROW, error: null },
      product_categories: { data: [], error: null },
      product_module_links: { data: null, error: null },
      product_circle_links: { data: null, error: null },
    };
    const fromMock = jest.fn((table: string) =>
      mockChain(routes[table] ?? { data: null, error: null }),
    );

    const from = supabaseAdmin.from as jest.Mock;
    from.mockImplementation((table: string) =>
      mockChain(
        table === "product_variants"
          ? { data: [], error: null }
          : { data: null, error: null },
      ),
    );

    const outcome = await executePendingAction(
      { from: fromMock } as never,
      pendingAction("product.create", {
        name: "Hoodie",
        price: 5000,
        stock: 12,
        description: "Premium hoodie",
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      productId: "prod-1",
      productName: "Hoodie",
      price: 5000,
      status: "draft",
      storeId: "store-1",
      storeSlug: "hilaq-store",
      productSlug: "hoodie",
      url: publicWebUrl("/s/hilaq-store/hoodie"),
      editUrl: publicWebUrl("/dashboard/store/product/prod-1"),
    });

    const inserted = lastInsertArg(fromMock);
    expect(inserted.type).toBe("physical");
    expect(inserted.status).toBe("draft");
    expect(inserted.currency).toBe("NGN");
    expect(inserted.store_id).toBe("store-1");
  });

  it("fails clearly when the business has no store", async () => {
    await expect(
      executePendingAction(
        buildFrom({ stores: { data: null, error: null } }) as never,
        pendingAction("product.create", { name: "X", price: 100 }),
      ),
    ).rejects.toThrow(/No store found/);
  });

  it("rejects truly unknown action types", async () => {
    await expect(
      executePendingAction(
        buildFrom({}) as never,
        pendingAction("circle.create", {}),
      ),
    ).rejects.toThrow("Unknown action type");
  });
});

describe("event.update executor", () => {
  const UPDATED_EVENT = {
    id: "event-1",
    event_name: "Hilaq Fest 2",
    status: "published",
    event_url: "hilaq-fest-2",
  };

  it("resolves the event by name and applies only column updates", async () => {
    const fromMock = jest.fn((table: string) =>
      mockChain(
        table === "events"
          ? { data: UPDATED_EVENT, error: null }
          : { data: null, error: null },
      ),
    );

    const outcome = await executePendingAction(
      { from: fromMock } as never,
      pendingAction("event.update", {
        event_name: "Hilaq Fest",
        new_name: "Hilaq Fest 2",
        status: "published",
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      eventId: "event-1",
      eventName: "Hilaq Fest 2",
      status: "published",
      eventUrl: "hilaq-fest-2",
      url: publicWebUrl("/events/hilaq-fest-2"),
      editUrl: publicWebUrl("/events/edit/event-1"),
    });

    const updated = lastUpdateArg(fromMock);
    expect(updated.event_name).toBe("Hilaq Fest 2");
    expect(updated.status).toBe("published");
    expect(updated.new_name).toBeUndefined();
    expect(updated.event_name === "Hilaq Fest").toBe(false);
  });

  it("fails clearly when no event matches the name", async () => {
    await expect(
      executePendingAction(
        buildFrom({ events: { data: null, error: null } }) as never,
        pendingAction("event.update", { event_name: "Nope" }),
      ),
    ).rejects.toThrow(/No event named "Nope"/);
  });
});

describe("scheduling.event_type.update executor", () => {
  it("resolves the type by title and returns the updated booking URL", async () => {
    const updated = {
      id: "et-1",
      title: "Deep Consultation",
      slug: "deep-consultation",
    };
    const fromMock = jest.fn((table: string) =>
      mockChain(
        table === "event_types"
          ? { data: { id: "et-1" }, error: null }
          : table === "businesses"
            ? { data: { slug: "hilaq-consulting" }, error: null }
            : { data: null, error: null },
      ),
    );

    const from = schedulingAdmin!.from as jest.Mock;
    from.mockImplementation((table: string) =>
      mockChain(
        table === "event_types" ? { data: updated, error: null } : { data: null, error: null },
      ),
    );

    const outcome = await executePendingAction(
      { from: fromMock } as never,
      pendingAction("scheduling.event_type.update", {
        title: "Consultation",
        new_title: "Deep Consultation",
        duration_minutes: 60,
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      eventTypeId: "et-1",
      title: "Deep Consultation",
      slug: "deep-consultation",
      url: publicWebUrl("/b/hilaq-consulting/deep-consultation"),
    });

    const updatedArg = lastUpdateArg(from);
    expect(updatedArg.title).toBe("Deep Consultation");
    expect(updatedArg.duration_minutes).toBe(60);
    expect(updatedArg.new_title).toBeUndefined();
  });
});

describe("product.update executor", () => {
  const UPDATED_PRODUCT = {
    id: "prod-1",
    name: "Premium Hoodie",
    price: 4500,
    status: "published",
    slug: "premium-hoodie",
  };

  it("resolves the product by name and applies only column updates", async () => {
    const routes: Record<string, unknown> = {
      stores: { data: STORE, error: null },
      products: { data: UPDATED_PRODUCT, error: null },
      product_categories: { data: [], error: null },
      product_module_links: { data: null, error: null },
      product_circle_links: { data: null, error: null },
    };
    const fromMock = jest.fn((table: string) =>
      mockChain(routes[table] ?? { data: null, error: null }),
    );

    const outcome = await executePendingAction(
      { from: fromMock } as never,
      pendingAction("product.update", {
        name: "Hoodie",
        new_name: "Premium Hoodie",
        price: 4500,
        status: "published",
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.result).toEqual({
      productId: "prod-1",
      productName: "Premium Hoodie",
      price: 4500,
      status: "published",
      storeId: "store-1",
      storeSlug: "hilaq-store",
      productSlug: "premium-hoodie",
      url: publicWebUrl("/s/hilaq-store/premium-hoodie"),
      editUrl: publicWebUrl("/dashboard/store/product/prod-1"),
    });

    const updated = lastUpdateArg(fromMock);
    expect(updated.name).toBe("Premium Hoodie");
    expect(updated.price).toBe(4500);
    expect(updated.status).toBe("published");
    expect(updated.new_name).toBeUndefined();
  });

  it("fails clearly when no product matches the name", async () => {
    await expect(
      executePendingAction(
        buildFrom({
          stores: { data: STORE, error: null },
          products: { data: null, error: null },
        }) as never,
        pendingAction("product.update", { name: "Nope", price: 100 }),
      ),
    ).rejects.toThrow(/No product named "Nope"/);
  });
});
