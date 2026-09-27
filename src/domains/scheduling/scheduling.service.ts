import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./scheduling.repository.js";
import type { AvailabilityRow, EventTypeRow } from "./scheduling.repository.js";

const READ = "product.read";
const WRITE = "product.update";

function slugify(value: string): string {
  return (
    value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item"
  );
}

// ── shape mappers (row <-> frontend snake_case) ──────────────────────────────

function toAvailability(row: AvailabilityRow): Record<string, unknown> {
  return {
    ...row.data,
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fromAvailability(body: Record<string, unknown>): { name: string; status: string; data: Record<string, unknown> } {
  const { id, business_id, businessId, createdAt, updatedAt, name, status, ...data } = body as any;
  void id; void business_id; void businessId; void createdAt; void updatedAt;
  return {
    name: typeof name === "string" && name.trim() ? name.trim() : "Untitled schedule",
    status: status === "inactive" ? "inactive" : "active",
    data,
  };
}

function toEventType(row: EventTypeRow): Record<string, unknown> {
  return {
    ...row.data,
    id: row.id,
    slug: row.slug,
    title: row.title,
    is_active: row.isActive,
    availability_profile_id: row.availabilityProfileId,
    bookings_count: 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fromEventType(body: Record<string, unknown>): {
  slug: string;
  title: string;
  isActive: boolean;
  availabilityProfileId: string | null;
  data: Record<string, unknown>;
} {
  const { id, business_id, businessId, createdAt, updatedAt, slug, title, is_active, availability_profile_id, ...data } = body as any;
  void id; void business_id; void businessId; void createdAt; void updatedAt;
  const resolvedTitle = typeof title === "string" && title.trim() ? title.trim() : "New event type";
  return {
    slug: typeof slug === "string" && slug.trim() ? slugify(slug) : slugify(resolvedTitle),
    title: resolvedTitle,
    isActive: is_active !== false,
    availabilityProfileId: typeof availability_profile_id === "string" ? availability_profile_id : null,
    data,
  };
}

export class SchedulingService {
  constructor(private readonly database: Database) {}

  // ── availability ───────────────────────────────────────────────────────────

  async listAvailability(userId: string, requestId: string, businessId: string): Promise<Record<string, unknown>[]> {
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, READ);
      return (await repo.listAvailability(context, businessId)).map(toAvailability);
    });
  }

  async createAvailability(userId: string, requestId: string, businessId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, WRITE);
      return toAvailability(await repo.createAvailability(context, businessId, fromAvailability(body)));
    });
  }

  async updateAvailability(userId: string, requestId: string, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const businessId = await this.businessForAvailability(userId, requestId, id);
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, WRITE);
      const updated = await repo.updateAvailability(context, businessId, id, fromAvailability(body));
      if (!updated) throw notFoundError("Availability profile not found");
      return toAvailability(updated);
    });
  }

  async deleteAvailability(userId: string, requestId: string, id: string): Promise<void> {
    const businessId = await this.businessForAvailability(userId, requestId, id);
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, WRITE);
      const ok = await repo.deleteAvailability(context, businessId, id);
      if (!ok) throw notFoundError("Availability profile not found");
    });
  }

  async duplicateAvailability(userId: string, requestId: string, id: string): Promise<Record<string, unknown>> {
    const businessId = await this.businessForAvailability(userId, requestId, id);
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, WRITE);
      const source = await repo.getAvailability(context, businessId, id);
      if (!source) throw notFoundError("Availability profile not found");
      return toAvailability(
        await repo.createAvailability(context, businessId, {
          name: `${source.name} (copy)`,
          status: source.status,
          data: source.data,
        }),
      );
    });
  }

  // ── event types ──────────────────────────────────────────────────────────────

  async listEventTypes(userId: string, requestId: string, businessId: string): Promise<Record<string, unknown>[]> {
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, READ);
      return (await repo.listEventTypes(context, businessId)).map(toEventType);
    });
  }

  async createEventType(userId: string, requestId: string, businessId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, WRITE);
      return toEventType(await repo.createEventType(context, businessId, fromEventType(body)));
    });
  }

  async updateEventType(userId: string, requestId: string, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const businessId = await this.businessForEventType(userId, requestId, id);
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, WRITE);
      const updated = await repo.updateEventType(context, businessId, id, fromEventType(body));
      if (!updated) throw notFoundError("Event type not found");
      return toEventType(updated);
    });
  }

  async deleteEventType(userId: string, requestId: string, id: string): Promise<void> {
    const businessId = await this.businessForEventType(userId, requestId, id);
    return this.run(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, WRITE);
      const ok = await repo.deleteEventType(context, businessId, id);
      if (!ok) throw notFoundError("Event type not found");
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async businessForAvailability(userId: string, requestId: string, id: string): Promise<string> {
    const businessId = await this.run(userId, requestId, null, (context) => repo.businessIdForAvailability(context, id));
    if (!businessId) throw notFoundError("Availability profile not found");
    return businessId;
  }

  private async businessForEventType(userId: string, requestId: string, id: string): Promise<string> {
    const businessId = await this.run(userId, requestId, null, (context) => repo.businessIdForEventType(context, id));
    if (!businessId) throw notFoundError("Event type not found");
    return businessId;
  }

  private async run<T>(
    userId: string,
    requestId: string,
    businessId: string | null,
    work: Parameters<typeof withDatabaseContext<T>>[2],
  ): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(requestId, userId, businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}
