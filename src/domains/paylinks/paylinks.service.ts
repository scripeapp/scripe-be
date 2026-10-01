import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { anonymousPrincipal, withIdentity } from "../../db/principal.js";
import { getCheckoutGateway } from "../../integrations/checkout-gateway.js";
import { objectStorage } from "../../integrations/r2.js";
import { loadEnvironment } from "../../shared/environment.js";
import { conflictError, notFoundError, validationError } from "../../shared/errors.js";
import * as auditRepository from "../audit/audit.repository.js";
import * as authorization from "../authorization/authorization.service.js";
import type { PaymentsService } from "../payments/payments.service.js";
import * as repository from "./paylinks.repository.js";
import type {
  AnonymousOperation,
  CreatePaylinkInput,
  PaylinkOperation,
  PaylinkPaymentSummary,
  PaylinkRow,
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
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export class PaylinksService {
  constructor(
    private readonly database: Database,
    private readonly paymentsService?: PaymentsService,
  ) {}

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
        }

        try {
          const row = await repository.createPaylink(
            context,
            operation.businessId,
            operation.userId,
            storeId,
            channelId,
            slug,
            { ...input, currency },
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
        } catch (err) {
          console.error("CREATE PAYLINK ERROR:", err);
          throw err;
        }
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
  ): Promise<{ paylinks: PaylinkSummary[]; totalCount: number }> {
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

        return { paylinks: summaries, totalCount: result.totalCount };
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

        return {
          id: link.id,
          slug: link.slug,
          mode: link.mode as any,
          title: link.title,
          description: link.description,
          imageUrl,
          amountType: link.amountType as any,
          amountMinor: link.amountMinor ? String(link.amountMinor) : null,
          minAmountMinor: link.minAmountMinor ? String(link.minAmountMinor) : null,
          suggestedAmountsMinor: Array.isArray(link.suggestedAmountsMinor)
            ? (link.suggestedAmountsMinor as string[])
            : [],
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
    const outcome = await withDatabaseContext(
      this.database,
      anonymousPrincipal(operation.requestId),
      async (context) => {
        const link = await repository.findPublicPaylink(context, slug);
        if (!link) throw notFoundError("This payment link is inactive or does not exist");
        if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
          throw notFoundError("This payment link has expired");
        }

        const quantity = input.quantity && input.quantity > 0 ? input.quantity : 1;
        let amountMinor: bigint;

        if (link.amountType === "fixed") {
          if (!link.amountMinor) {
            throw validationError("Invalid payment link amount configuration");
          }
          amountMinor = BigInt(link.amountMinor) * BigInt(quantity);
        } else {
          // customer_sets
          if (!input.amountMinor) {
            throw validationError("Please enter an amount to pay");
          }
          amountMinor = BigInt(input.amountMinor);
          if (amountMinor <= 0n) {
            throw validationError("Amount must be greater than zero");
          }
          if (link.minAmountMinor && amountMinor < BigInt(link.minAmountMinor)) {
            throw validationError(`Minimum amount is ₦${(Number(link.minAmountMinor) / 100).toLocaleString()}`);
          }
        }

        const orderNumber = `ORD-PL-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
        const reference = `pl_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
        const description =
          link.mode === "product"
            ? `${link.title} (x${quantity})`
            : link.title;

        const { orderId, paymentId } = await repository.createGuestOrderAndPayment(context, {
          slug: link.slug,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          orderNumber,
          amountMinor,
          currency: link.currency,
          description,
          productVariantId: link.productVariantId,
          quantity,
          providerReference: reference,
          providerName: "paystack",
          idempotencyKey: input.idempotencyKey,
        });

        return {
          link,
          orderId,
          paymentId,
          reference,
          amountMinor,
        };
      },
    );

    const { link, orderId, paymentId, reference, amountMinor } = outcome;
    const env = loadEnvironment();
    const gateway = getCheckoutGateway("paystack");

    const callbackUrl = `${env.FRONTEND_URL}/pay/${slug}/complete`;
    const initialized = await gateway.initializeCheckout({
      amountMinor: amountMinor.toString(),
      assetCode: link.currency,
      email: input.customerEmail,
      reference,
      callbackUrl,
      metadata: {
        paylinkId: link.id,
        businessId: link.businessId,
        orderId,
        paymentId,
      },
    });

    return {
      orderId,
      paymentId,
      reference,
      authorizationUrl: initialized.authorizationUrl,
    };
  }

  async getCheckoutStatus(
    operation: AnonymousOperation,
    reference: string,
  ): Promise<PublicCheckoutStatus> {
    return withDatabaseContext(
      this.database,
      anonymousPrincipal(operation.requestId),
      async (context) => {
        const found = await repository.findPaymentByReference(context, reference);
        if (!found) throw notFoundError("Payment reference not found");

        let status: "pending" | "paid" | "failed" =
          found.status === "captured" || found.status === "authorized"
            ? "paid"
            : found.status === "failed"
            ? "failed"
            : "pending";

        // If still pending, call gateway verifyCheckout as verification fallback
        if (status === "pending") {
          try {
            const gateway = getCheckoutGateway("paystack");
            const verification = await gateway.verifyCheckout(reference);
            if (verification.status === "success") {
              status = "paid";
            } else if (verification.status === "failed") {
              status = "failed";
            }
          } catch {
            // Keep status pending if verify checkout throws
          }
        }

        return {
          reference: found.reference,
          status,
          amountMinor: found.amountMinor,
          currency: found.currency,
          paidAt: found.paidAt ? found.paidAt.toISOString() : null,
          redirectUrl: found.redirectUrl,
        };
      },
    );
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
      mode: row.mode as any,
      title: row.title,
      description: row.description,
      imageUrl,
      imageKey: row.imageKey,
      amountType: row.amountType as any,
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
      status: row.status as any,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      paymentCount,
      totalCollectedMinor,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
