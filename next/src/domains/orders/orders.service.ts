import type { Database } from "../../db/database.types.js";
import { sql } from "kysely";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, forbiddenError, notFoundError } from "../../shared/errors.js";
import * as repo from "./orders.repository.js";
import type { Order, OrderOperation } from "./orders.types.js";
export class OrdersService {
  constructor(private readonly database: Database) {}
  async list(op: OrderOperation, status?: string, limit = 50): Promise<Order[]> { return this.run(op, async (c) => { await this.require(c, "order.read"); return Promise.all((await repo.list(c, op.businessId, status, limit)).map((row) => this.hydrate(c, row))); }); }
  async get(op: OrderOperation, orderId: string): Promise<Order> { return this.run(op, async (c) => { await this.require(c, "order.read"); const row = await repo.find(c, op.businessId, orderId); if (!row) throw notFoundError("Order not found"); return this.hydrate(c, row); }); }
  private async hydrate(c: Parameters<typeof repo.find>[0], row: Awaited<ReturnType<typeof repo.find>> extends infer R ? Exclude<R, undefined> : never): Promise<Order> { const lines = await repo.lines(c, row.businessId, row.id); return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), cancelledAt: row.cancelledAt?.toISOString() ?? null, lines: lines.map((line) => ({ ...line, createdAt: line.createdAt.toISOString() })) }; }
  private async require(c: Parameters<typeof repo.find>[0], permission: string): Promise<void> { const result = await sql<{ allowed: boolean }>`select app.has_business_permission(current_setting('app.business_id', true)::uuid, ${permission}) as allowed`.execute(c.transaction); if (result.rows[0]?.allowed !== true) throw forbiddenError(`Missing permission: ${permission}`); }
  private async run<T>(op: OrderOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { try { return await withDatabaseContext(this.database, withIdentity(op.requestId, op.userId, op.businessId), work); } catch (error) { if (error instanceof AppError || error instanceof DatabaseError) throw error; throw normalizeDatabaseError(error); } }
}
