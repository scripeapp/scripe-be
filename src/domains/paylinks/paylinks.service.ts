import { randomInt, randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { anonymousPrincipal, withIdentity } from "../../db/principal.js";
import { getCheckoutGateway } from "../../integrations/checkout-gateway.js";
import { objectStorage } from "../../integrations/r2.js";
import { loadEnvironment } from "../../shared/environment.js";
import { conflictError, notFoundError, serviceUnavailableError, validationError } from "../../shared/errors.js";
import * as auditRepository from "../audit/audit.repository.js";
import * as authorization from "../authorization/authorization.service.js";
import { checkoutRequiresSubaccount, getCheckoutSettlementStatus, requireCheckoutSubaccount } from "../banking/checkout-subaccounts.js";
import { ChargeMismatchError, settleCheckoutPayment } from "../provider-events/checkout-settlement.js";
import * as providerEventsRepository from "../provider-events/provider-events.repository.js";
import { checkLimit } from "../subscriptions/subscriptions.service.js";
import * as repository from "./paylinks.repository.js";
import type {
  AnonymousOperation,
  CreatePaylinkInput,
  DeliveryAddress,
  PaylinkAmountType,
  PaylinkMode,
  PaylinkOperation,
  PaylinkPaymentSummary,
  PaylinkRow,
  PaylinkStatus,
  PaylinkSummary,
  PublicCheckoutInput,
  PublicCheckoutResult,
  PublicCheckoutStatus,
  PublicPaylink,
  UpdatePaylinkInput,
} from "./paylinks.types.js";

const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "checkout",
  "dashboard",
  "help",
  "login",
  "logout",
  "order",
  "orders",
  "pay",
  "payment",
  "payments",
  "paylink",
  "paylinks",
  "pos",
  "public",
  "settings",
  "store",
  "storefront",
  "support",
  "webhook",
  "webhooks",
]);

function generateRandomSlug(): string {
  const chars = "23456789abcdefghjkmnpqrstuvwxyz";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(randomInt(chars.length));
  }
  return result;
}

/** Currencies Paystack can charge in; a link in any other currency could never be paid. */
const PAYSTACK_CURRENCIES = new Set(["NGN", "GHS", "ZAR", "KES", "USD"]);

/** Plan entitlement key (migration 0084): starter 10, plus 50, pro unlimited. */
const ACTIVE_PAYLINKS_LIMIT = "active_paylinks";

function formatMinor(amountMinor: string, currency: string): string {
  const major = (Number(amountMinor) / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });
  return currency === "NGN" ? `₦${major}` : `${currency} ${major}`;
}

function cleanAddress(address: DeliveryAddress | null | undefined): DeliveryAddress | null {
  if (!address) return null;
  const cleaned = {
    streetAddress: address.streetAddress?.trim() || undefined,
    city: address.city?.trim() || undefined,
    state: address.state?.trim() || undefined,
  };
  return cleaned.streetAddress || cleaned.city || cleaned.state ? cleaned : null;
}

export class PaylinksService {
  constructor(private readonly database: Database) {}

  async createPaylink(
    operation: PaylinkOperation,
    input: CreatePaylinkInput,
  ): Promise<PaylinkSummary> {
    return withDatabaseContext(
      this.database,
      withIdentity(operation.requestId, operation.userId, operation.businessId),
      async (context) => {
        await authorization.requirePermission(context, operation.businessId, "paylink.manage");

        let storeId = input.storeId;
        let currency = input.currency || "NGN";
        if (!storeId) {
          const defaultStore = await repository.findDefaultStore(context, operation.businessId);
          if (!defaultStore) throw validationError("No store found for this business");
          storeId = defaultStore.id;
          if (!input.currency) currency = defaultStore.currency;
        }

        if (!PAYSTACK_CURRENCIES.has(currency)) {
          throw validationError(`Payment links can't be priced in ${currency} yet. Supported: ${[...PAYSTACK_CURRENCIES].join(", ")}.`, { field: "currency" });
        }
        if ((input.status ?? "active") === "active") {
          await checkLimit(context, operation.businessId, ACTIVE_PAYLINKS_LIMIT, await repository.countActivePaylinks(context, operation.businessId));
        }

        const channelId = await repository.ensurePaylinkChannel(context, operation.businessId, storeId);

        let slug: string;
        if (input.customSlug) {
          const cleanSlug = input.customSlug.trim().toLowerCase();
          if (RESERVED_SLUGS.has(cleanSlug)) {
            throw validationError("This link name is reserved; please choose another.", {
              field: "customSlug",
            });
          }
          const available = await repository.isSlugAvailable(context, cleanSlug);
          if (!available) {
            throw conflictError("This custom link URL is already in use.");
          }
          slug = cleanSlug;
        } else {
          let attempts = 0;
          do {
            slug = generateRandomSlug();
            attempts++;
          } while (!(await repository.isSlugAvailable(context, slug)) && attempts < 5);
          if (!(await repository.isSlugAvailable(context, slug))) throw conflictError("Could not generate a unique link. Please try again.");
        }

        if (input.imageKey) await this.requireOwnImage(context, operation.businessId, input.imageKey);

        // A fixed product link stores the price it was created with; fall
        // back to the catalog's current price when the client sent none.
        let amountMinor = input.amountMinor ?? null;
        if (input.mode === "product" && (input.amountType ?? "fixed") === "fixed" && !amountMinor && input.productVariantId) {
          amountMinor = await repository.findVariantPriceMinor(context, operation.businessId, input.productVariantId);
          if (!amountMinor) throw validationError("This product has no price yet. Set a price or let the customer choose the amount.", { field: "amountMinor" });
        }

        const row = await repository.createPaylink(
          context,
          operation.businessId,
          operation.userId,
          storeId,
          channelId,
          slug,
          { ...input, amountMinor, currency },
        );

        await auditRepository.log(context, {
          businessId: operation.businessId,
          actorUserId: operation.userId,
          action: "paylink.created",
          targetType: "paylink",
          targetId: row.id,
          metadata: { slug: row.slug, mode: row.mode, title: row.title },
          requestId: operation.requestId,
        });

        return this.toSummary(row, 0, "0");
      },
    );
  }

  async getPaylink(
    operation: PaylinkOperation,
    paylinkId: string,
  ): Promise<PaylinkSummary> {
    return withDatabaseContext(
      this.database,
      withIdentity(operation.requestId, operation.userId, operation.businessId),
      async (context) => {
        await authorization.requirePermission(context, operation.businessId, "paylink.read");
        const row = await repository.findPaylinkById(context, operation.businessId, paylinkId);
        if (!row || row.status === "archived") throw notFoundError("Payment link not found");

        const payments = await repository.listPaylinkPayments(context, operation.businessId, paylinkId);
        const successful = payments.filter((p) => p.status === "captured" || p.status === "authorized");
        const total = successful.reduce((sum, p) => sum + BigInt(p.amountMinor), 0n);

        return this.toSummary(row, successful.length, total.toString());
      },
    );
  }

  async listPaylinks(
    operation: PaylinkOperation,
    filter: {
      status?: string;
      search?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ paylinks: PaylinkSummary[]; totalCount: number; payoutsReady: boolean }> {
    return withDatabaseContext(
      this.database,
      withIdentity(operation.requestId, operation.userId, operation.businessId),
      async (context) => {
        await authorization.requirePermission(context, operation.businessId, "paylink.read");
        const result = await repository.listPaylinks(context, operation.businessId, filter);

        const summaries = await Promise.all(
          result.paylinks.map(async (p) => {
            let imageUrl: string | null = null;
            if (p.imageKey) {
              try {
                imageUrl = await objectStorage.createPresignedDownloadUrl(p.imageKey);
              } catch {
                imageUrl = null;
              }
            }
            return { ...p, imageUrl };
          }),
        );

        // With real Paystack, links can't take money until a payout account
        // exists; the dashboard shows a "set up payouts" banner from this.
        const payoutsReady = checkoutRequiresSubaccount() ? (await getCheckoutSettlementStatus(context, operation.businessId)).hasSettlementAccount : true;

        return { paylinks: summaries, totalCount: result.totalCount, payoutsReady };
      },
    );
  }

  async updatePaylink(
    operation: PaylinkOperation,
    paylinkId: string,
    input: UpdatePaylinkInput,
  ): Promise<PaylinkSummary> {
    return withDatabaseContext(
      this.database,
      withIdentity(operation.requestId, operation.userId, operation.businessId),
      async (context) => {
        await authorization.requirePermission(context, operation.businessId, "paylink.manage");
        const existing = await repository.findPaylinkById(context, operation.businessId, paylinkId);
        if (!existing || existing.status === "archived") throw notFoundError("Payment link not found");

        if (input.imageKey) await this.requireOwnImage(context, operation.businessId, input.imageKey);
        if (input.status === "active" && existing.status !== "active") {
          await checkLimit(context, operation.businessId, ACTIVE_PAYLINKS_LIMIT, await repository.countActivePaylinks(context, operation.businessId));
        }
        const amountType = input.amountType ?? existing.amountType;
        const amountMinor = input.amountMinor !== undefined ? input.amountMinor : existing.amountMinor;
        if (amountType === "fixed" && !amountMinor) {
          throw validationError("A fixed-amount link needs an amount", { field: "amountMinor" });
        }

        const updated = await repository.updatePaylink(context, operation.businessId, paylinkId, input);
        if (!updated) throw notFoundError("Payment link not found");

        await auditRepository.log(context, {
          businessId: operation.businessId,
          actorUserId: operation.userId,
          action: "paylink.updated",
          targetType: "paylink",
          targetId: updated.id,
          metadata: { changes: Object.keys(input) },
          requestId: operation.requestId,
        });

        return this.toSummary(updated);
      },
    );
  }

  async archivePaylink(
    operation: PaylinkOperation,
    paylinkId: string,
  ): Promise<void> {
    return withDatabaseContext(
      this.database,
      withIdentity(operation.requestId, operation.userId, operation.businessId),
      async (context) => {
        await authorization.requirePermission(context, operation.businessId, "paylink.manage");
        const existing = await repository.findPaylinkById(context, operation.businessId, paylinkId);
        if (!existing || existing.status === "archived") throw notFoundError("Payment link not found");

        await repository.archivePaylink(context, operation.businessId, paylinkId);

        await auditRepository.log(context, {
          businessId: operation.businessId,
          actorUserId: operation.userId,
          action: "paylink.archived",
          targetType: "paylink",
          targetId: paylinkId,
          metadata: { slug: existing.slug },
          requestId: operation.requestId,
        });
      },
    );
  }

  async listPayments(
    operation: PaylinkOperation,
    paylinkId: string,
  ): Promise<PaylinkPaymentSummary[]> {
    return withDatabaseContext(
      this.database,
      withIdentity(operation.requestId, operation.userId, operation.businessId),
      async (context) => {
        await authorization.requirePermission(context, operation.businessId, "paylink.read");
        return repository.listPaylinkPayments(context, operation.businessId, paylinkId);
      },
    );
  }

  // ==========================================================================
  // Public Guest Checkout Paths (Anonymous)
  // ==========================================================================

  async getPublicPaylink(
    operation: AnonymousOperation,
    slug: string,
  ): Promise<PublicPaylink> {
    return withDatabaseContext(
      this.database,
      anonymousPrincipal(operation.requestId),
      async (context) => {
        const link = await repository.findPublicPaylink(context, slug);
        if (!link) throw notFoundError("This payment link is inactive or does not exist");
        if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
          throw notFoundError("This payment link has expired");
        }

        let imageUrl: string | null = null;
        if (link.imageKey) {
          try {
            imageUrl = await objectStorage.createPresignedDownloadUrl(link.imageKey);
          } catch {
            imageUrl = null;
          }
        }
        // Not accepting: suspended or held, or (with real Paystack) no payout
        // account yet, so the money would have nowhere to settle.
        const settlement = checkoutRequiresSubaccount() ? await getCheckoutSettlementStatus(context, link.businessId) : null;
        const acceptingPayments =
          (await repository.isBusinessAcceptingPayments(context, link.businessId)) && (settlement === null || settlement.hasSettlementAccount);

        return {
          id: link.id,
          acceptingPayments,
          slug: link.slug,
          mode: link.mode as PaylinkMode,
          title: link.title,
          description: link.description,
          imageUrl,
          amountType: link.amountType as PaylinkAmountType,
          amountMinor: link.amountMinor ? String(link.amountMinor) : null,
          minAmountMinor: link.minAmountMinor ? String(link.minAmountMinor) : null,
          suggestedAmountsMinor: Array.isArray(link.suggestedAmountsMinor) ? link.suggestedAmountsMinor : [],
          currency: link.currency,
          collectName: link.collectName,
          collectPhone: link.collectPhone,
          collectAddress: link.collectAddress,
          businessName: link.businessName,
          businessLogoUrl: null,
          product: link.product,
        };
      },
    );
  }

  async checkoutPublic(
    operation: AnonymousOperation,
    slug: string,
    input: PublicCheckoutInput,
  ): Promise<PublicCheckoutResult> {
    const record = await withDatabaseContext(
      this.database,
      anonymousPrincipal(operation.requestId),
      async (context) => {
        const link = await repository.findPublicPaylink(context, slug);
        if (!link) throw notFoundError("This payment link is inactive or does not exist");
        if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
          throw notFoundError("This payment link has expired");
        }

        if (!(await repository.isBusinessAcceptingPayments(context, link.businessId))) {
          throw conflictError("This business can't accept payments right now. Please contact them directly.");
        }

        if (link.collectPhone && !input.customerPhone?.trim()) {
          throw validationError("Please enter your phone number", { field: "customerPhone" });
        }
        const deliveryAddress = cleanAddress(input.deliveryAddress);
        if (link.collectAddress && !deliveryAddress?.streetAddress) {
          throw validationError("Please enter a delivery address", { field: "deliveryAddress" });
        }

        // Only product links sell more than one unit.
        const quantity = link.mode === "product" ? Math.max(1, input.quantity ?? 1) : 1;
        let amountMinor: bigint;

        if (link.amountType === "fixed") {
          // The price always comes from the link, never from the client.
          if (!link.amountMinor) {
            throw validationError("Invalid payment link amount configuration");
          }
          amountMinor = BigInt(link.amountMinor) * BigInt(quantity);
        } else {
          if (!input.amountMinor) {
            throw validationError("Please enter an amount to pay");
          }
          amountMinor = BigInt(input.amountMinor);
          if (amountMinor <= 0n) {
            throw validationError("Amount must be greater than zero");
          }
          if (link.minAmountMinor && amountMinor < BigInt(link.minAmountMinor)) {
            throw validationError(`Minimum amount is ${formatMinor(link.minAmountMinor, link.currency)}`);
          }
        }

        // The sale settles to the business's own Paystack subaccount; with
        // real Paystack and no payout account this refuses (409).
        const subaccountCode = await requireCheckoutSubaccount(context, link.businessId);

        const reference = `pl_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
        const recorded = await repository.createGuestOrderAndPayment(context, {
          slug: link.slug,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          orderNumber: `ORD-PL-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`,
          amountMinor,
          currency: link.currency,
          description: link.mode === "product" ? `${link.title} (x${quantity})` : link.title,
          productVariantId: link.productVariantId,
          quantity,
          providerReference: reference,
          providerName: "paystack",
          // Namespaced so a client key can never collide with another flow's
          // payments; without one, each request is its own attempt.
          idempotencyKey: `paylink:${input.idempotencyKey?.trim() || reference}`,
          deliveryAddress,
        });

        return { link, recorded, amountMinor, subaccountCode };
      },
    );

    const { link, recorded, amountMinor, subaccountCode } = record;
    if (recorded.replayed && recorded.checkoutUrl) {
      return {
        orderId: recorded.orderId,
        paymentId: recorded.paymentId,
        reference: recorded.reference,
        authorizationUrl: recorded.checkoutUrl,
      };
    }

    // The gateway call runs outside the transaction so no database
    // connection is held open while Paystack responds.
    let authorizationUrl: string;
    try {
      const initialized = await getCheckoutGateway("paystack").initializeCheckout({
        amountMinor: amountMinor.toString(),
        assetCode: link.currency,
        email: input.customerEmail,
        reference: recorded.reference,
        subaccountCode,
        callbackUrl: `${loadEnvironment().FRONTEND_URL.replace(/\/+$/, "")}/pay/${link.slug}/complete`,
        metadata: {
          paylinkId: link.id,
          businessId: link.businessId,
          orderId: recorded.orderId,
          paymentId: recorded.paymentId,
        },
      });
      authorizationUrl = initialized.authorizationUrl;
    } catch (error) {
      // Leave no pending payment behind for a checkout that never started.
      await withDatabaseContext(this.database, anonymousPrincipal(operation.requestId), (context) =>
        providerEventsRepository.failCheckoutPaymentByReference(context, recorded.reference),
      );
      console.error(`[paylinks] gateway initialization failed for ${recorded.reference}:`, error);
      throw serviceUnavailableError("We could not start the payment. Please try again in a moment.");
    }

    await withDatabaseContext(this.database, anonymousPrincipal(operation.requestId), (context) =>
      repository.setCheckoutUrl(context, recorded.reference, authorizationUrl),
    );

    return {
      orderId: recorded.orderId,
      paymentId: recorded.paymentId,
      reference: recorded.reference,
      authorizationUrl,
    };
  }

  /**
   * Polled by the completion page. A payment still pending is checked with
   * the gateway and, when the gateway confirms it, settled through the same
   * path as the webhook (amount check, ledger, receipt, emails), so the
   * page never reports "paid" for an order the books still show unpaid.
   */
  async getCheckoutStatus(
    operation: AnonymousOperation,
    reference: string,
  ): Promise<PublicCheckoutStatus> {
    const read = () =>
      withDatabaseContext(this.database, anonymousPrincipal(operation.requestId), (context) =>
        repository.findPaymentByReference(context, reference),
      );

    let found = await read();
    if (!found || !reference.startsWith("pl_")) throw notFoundError("Payment reference not found");

    if (found.status === "pending") {
      let verification: Awaited<ReturnType<ReturnType<typeof getCheckoutGateway>["verifyCheckout"]>> | null = null;
      try {
        verification = await getCheckoutGateway("paystack").verifyCheckout(reference);
      } catch (error) {
        console.warn(`[paylinks] verify failed for ${reference}:`, error);
      }

      if (verification?.status === "success") {
        try {
          await withDatabaseContext(this.database, anonymousPrincipal(operation.requestId), (context) =>
            settleCheckoutPayment(context, reference, { amountMinor: verification.amountMinor, currency: verification.assetCode }),
          );
        } catch (error) {
          if (!(error instanceof ChargeMismatchError)) throw error;
          console.error(`[paylinks] ${error.message} (reference ${reference})`);
        }
        found = (await read()) ?? found;
      } else if (verification?.status === "failed") {
        await withDatabaseContext(this.database, anonymousPrincipal(operation.requestId), (context) =>
          providerEventsRepository.failCheckoutPaymentByReference(context, reference),
        );
        found = (await read()) ?? found;
      }
    }

    const status: PublicCheckoutStatus["status"] =
      found.status === "captured" || found.status === "authorized" ? "paid" : found.status === "failed" ? "failed" : "pending";

    return {
      reference: found.reference,
      status,
      amountMinor: found.amountMinor,
      currency: found.currency,
      paidAt: found.paidAt ? new Date(found.paidAt).toISOString() : null,
      redirectUrl: status === "paid" ? found.redirectUrl : null,
    };
  }

  private async requireOwnImage(context: DatabaseContext, businessId: string, imageKey: string): Promise<void> {
    if (!(await repository.isConfirmedBusinessImage(context, businessId, imageKey))) {
      throw validationError("The link image must be an image uploaded to this business", { field: "imageKey" });
    }
  }

  private async toSummary(
    row: PaylinkRow,
    paymentCount = 0,
    totalCollectedMinor = "0",
  ): Promise<PaylinkSummary> {
    let imageUrl: string | null = null;
    if (row.imageKey) {
      try {
        imageUrl = await objectStorage.createPresignedDownloadUrl(row.imageKey);
      } catch {
        imageUrl = null;
      }
    }

    return {
      id: row.id,
      businessId: row.businessId,
      storeId: row.storeId,
      channelId: row.channelId,
      slug: row.slug,
      publicUrl: repository.publicPaylinkUrl(row.slug),
      mode: row.mode as PaylinkMode,
      title: row.title,
      description: row.description,
      imageUrl,
      imageKey: row.imageKey,
      amountType: row.amountType as PaylinkAmountType,
      amountMinor: row.amountMinor ? String(row.amountMinor) : null,
      minAmountMinor: row.minAmountMinor ? String(row.minAmountMinor) : null,
      suggestedAmountsMinor: Array.isArray(row.suggestedAmountsMinor)
        ? (row.suggestedAmountsMinor as string[])
        : [],
      currency: row.currency,
      productVariantId: row.productVariantId,
      collectName: row.collectName,
      collectPhone: row.collectPhone,
      collectAddress: row.collectAddress,
      redirectUrl: row.redirectUrl,
      status: row.status as PaylinkStatus,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      paymentCount,
      totalCollectedMinor,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

const RECONCILE_AFTER_MINUTES = 15;
const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;
const ALERT_PENDING_AFTER_MS = 60 * 60 * 1000;
const RECONCILE_PAGE = 100;
/** Upper bound per run so one sweep can't hold the scheduler for long; the next run continues. */
const RECONCILE_MAX_PER_RUN = 1000;

export interface PaylinkReconcileSummary {
  readonly checked: number;
  readonly captured: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly stillPending: number;
}

/**
 * Background safety net for payments the webhook and the completion page
 * both missed (lost webhook, customer closed the tab): every paylink
 * payment pending for 15+ minutes is re-verified with Paystack and settled
 * or failed through the same path as the webhook; one still pending after
 * 24 hours is treated as abandoned. Also raises log alerts — pending over
 * an hour, or webhook signature failures — for log-based monitoring to
 * page on (search for "[alert]").
 */
export async function reconcilePendingPaylinkPayments(database: Database): Promise<PaylinkReconcileSummary> {
  const principal = anonymousPrincipal("paylinks-reconcile");
  const stale: { reference: string; createdAt: Date }[] = [];
  let cursor: Date | null = null;
  while (stale.length < RECONCILE_MAX_PER_RUN) {
    const after: Date | null = cursor;
    const page: { reference: string; createdAt: Date }[] = await withDatabaseContext(database, principal, (context) =>
      repository.listStalePaylinkPayments(context, RECONCILE_AFTER_MINUTES, after, RECONCILE_PAGE),
    );
    stale.push(...page);
    const last = page.at(-1);
    if (!last || page.length < RECONCILE_PAGE) break;
    cursor = new Date(last.createdAt);
  }

  let captured = 0;
  let failed = 0;
  let abandoned = 0;
  let stillPending = 0;
  let oldestPendingMs = 0;
  const gateway = getCheckoutGateway("paystack");

  for (const payment of stale) {
    const ageMs = Date.now() - new Date(payment.createdAt).getTime();
    let verification: Awaited<ReturnType<typeof gateway.verifyCheckout>> | null = null;
    try {
      verification = await gateway.verifyCheckout(payment.reference);
    } catch (error) {
      // Gateway unreachable or unconfigured: try again on the next run.
      console.warn(`[paylinks] reconcile could not verify ${payment.reference}:`, error instanceof Error ? error.message : error);
    }

    try {
      if (verification?.status === "success") {
        const outcome = await withDatabaseContext(database, principal, (context) =>
          settleCheckoutPayment(context, payment.reference, { amountMinor: verification.amountMinor, currency: verification.assetCode }),
        );
        if (outcome.status === "captured") captured++;
        continue;
      }
      if (verification?.status === "failed" || (verification && ageMs > ABANDON_AFTER_MS)) {
        await withDatabaseContext(database, principal, (context) => providerEventsRepository.failCheckoutPaymentByReference(context, payment.reference));
        if (verification.status === "failed") failed++;
        else abandoned++;
        continue;
      }
    } catch (error) {
      if (error instanceof ChargeMismatchError) console.error(`[alert] paylink charge mismatch: ${error.message} (reference ${payment.reference})`);
      else console.error(`[paylinks] reconcile failed for ${payment.reference}:`, error);
    }
    stillPending++;
    oldestPendingMs = Math.max(oldestPendingMs, ageMs);
  }

  if (oldestPendingMs > ALERT_PENDING_AFTER_MS) {
    console.error(`[alert] ${stillPending} paylink payment(s) still pending; oldest ${Math.round(oldestPendingMs / 60000)} minutes`);
  }
  const signatureFailures = await withDatabaseContext(database, principal, (context) => repository.countRecentWebhookSignatureFailures(context, 60));
  if (signatureFailures > 0) {
    console.error(`[alert] ${signatureFailures} webhook delivery(ies) failed signature verification in the last hour`);
  }

  return { checked: stale.length, captured, failed, abandoned, stillPending };
}
