import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, conflictError, notFoundError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./carts.repository.js";
import * as orderRepo from "../orders/orders.repository.js";
import * as promotionsRepo from "../promotions/promotions.repository.js";
import { reserveForCheckout } from "../promotions/promotions.service.js";
import type { AddCartLineInput, Cart, CartLine, CartOperation, CheckoutInput, CreateCartInput, UpdateCartLineInput } from "./carts.types.js";
export class CartsService {
  constructor(private readonly database: Database) {}
  async create(op: CartOperation, input: CreateCartInput): Promise<Cart> { return this.run(op, async (c) => { await this.require(c, op.businessId, "cart.manage"); return this.hydrate(await repo.createCart(c, op.businessId, op.userId, input), c); }); }
  async get(op: CartOperation, cartId: string): Promise<Cart> { return this.run(op, async (c) => { await this.require(c, op.businessId, "cart.read"); const row = await repo.findCart(c, op.businessId, cartId); if (!row) throw notFoundError("Cart not found"); return this.hydrate(row, c); }); }
  async addLine(op: CartOperation, cartId: string, input: AddCartLineInput): Promise<Cart> { return this.run(op, async (c) => { await this.require(c, op.businessId, "cart.manage"); const cart = await repo.findCart(c, op.businessId, cartId, true); if (!cart || cart.status !== "active") throw notFoundError("Active cart not found"); await repo.addLine(c, op.businessId, cartId, input); return this.hydrate(cart, c); }); }
  async updateLine(op: CartOperation, cartId: string, lineId: string, input: UpdateCartLineInput): Promise<Cart> { return this.run(op, async (c) => { await this.require(c, op.businessId, "cart.manage"); const cart = await repo.findCart(c, op.businessId, cartId); if (!cart || cart.status !== "active") throw notFoundError("Active cart not found"); if (!(await repo.updateLine(c, op.businessId, cartId, lineId, input))) throw notFoundError("Cart line not found"); return this.hydrate(cart, c); }); }
  async deleteLine(op: CartOperation, cartId: string, lineId: string): Promise<Cart> { return this.run(op, async (c) => { await this.require(c, op.businessId, "cart.manage"); const cart = await repo.findCart(c, op.businessId, cartId); if (!cart || cart.status !== "active") throw notFoundError("Active cart not found"); if (!(await repo.deleteLine(c, op.businessId, cartId, lineId))) throw notFoundError("Cart line not found"); return this.hydrate(cart, c); }); }
  async checkout(op: CartOperation, cartId: string, input: CheckoutInput): Promise<{ orderId: string; discountMinor: string }> {
    return this.run(op, async (c) => {
      await this.require(c, op.businessId, "cart.manage");
      await this.require(c, op.businessId, "order.create");
      const previous = await repo.findCheckout(c, op.businessId, input.idempotencyKey);
      if (previous?.orderId) {
        const existingOrder = await orderRepo.find(c, op.businessId, previous.orderId);
        return { orderId: previous.orderId, discountMinor: existingOrder?.discountMinor ?? "0" };
      }
      if (previous) throw conflictError("Checkout idempotency key is already in progress");
      const cart = await repo.findCart(c, op.businessId, cartId, true);
      if (!cart || cart.status !== "active") throw notFoundError("Active cart not found");
      const lines = await repo.listLines(c, op.businessId, cartId);
      if (!lines.length) throw conflictError("Cannot checkout an empty cart");
      await repo.createCheckout(c, op.businessId, cartId, input.idempotencyKey);

      const priced = await orderRepo.priceCartLines(c, op.businessId, lines, input.locationId ?? null);
      const evaluationItems = priced.map((item) => ({ productId: item.productId, quantity: item.line.quantity, lineTotalMinor: item.lineTotalMinor }));
      const reserved = await reserveForCheckout(c, op.businessId, evaluationItems, cart.customerPartyId, input.discountCode?.trim() || null);

      const order = await orderRepo.createOrderFromPricedLines(c, op.businessId, op.userId, cart, priced, input.locationId ?? null, BigInt(reserved.totalDiscountMinor));
      if (reserved.redemptions.length > 0) await promotionsRepo.recordRedemptions(c, op.businessId, order.id, cart.customerPartyId, reserved.redemptions);

      await repo.markConverted(c, op.businessId, cartId);
      await repo.linkCheckout(c, op.businessId, input.idempotencyKey, order.id);
      return { orderId: order.id, discountMinor: reserved.totalDiscountMinor };
    });
  }
  private async hydrate(row: Awaited<ReturnType<typeof repo.findCart>> extends infer R ? Exclude<R, undefined> : never, c: Parameters<typeof repo.findCart>[0]): Promise<Cart> { const lines = await repo.listLines(c, row.businessId, row.id); return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), convertedAt: row.convertedAt?.toISOString() ?? null, lines: lines.map(toLine) }; }
  private async require(c: Parameters<typeof repo.findCart>[0], businessId: string, permission: string): Promise<void> { return authorization.requirePermission(c, businessId, permission); }
  private async run<T>(op: CartOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { try { return await withDatabaseContext(this.database, withIdentity(op.requestId, op.userId, op.businessId), work); } catch (error) { if (error instanceof AppError || error instanceof DatabaseError) throw error; throw normalizeDatabaseError(error); } }
}
function toLine(row: Awaited<ReturnType<typeof repo.listLines>>[number]): CartLine { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }; }
