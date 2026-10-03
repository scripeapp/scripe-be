import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { anonymousPrincipal, withIdentity } from "../../db/principal.js";
import { objectStorage } from "../../integrations/r2.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import { requireBusinessConfirmedUpload } from "../uploads/uploads.service.js";
import { absoluteBrandingImageUrl, brandingImagePath, loadBusinessBranding, type BrandingImageKind, type BusinessBranding } from "./businesses.branding.js";
import { seedDefaultChartOfAccounts } from "../accounting/accounting.service.js";
import { seedStarterApprovalWorkflows } from "../approvals/approvals.service.js";
import { createDefaultBranch, fillDefaultBranchAddress } from "../stores/stores.service.js";
import { seedOwnerAsStaff } from "../staff/staff.service.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repository from "./businesses.repository.js";
import type { Business, BusinessBrandingUpdateInput, BusinessCreateInput, BusinessListRow, BusinessOperation, BusinessUpdateInput } from "./businesses.types.js";

export class BusinessesService {
  constructor(private readonly database: Database) {}

  async list(operation: BusinessOperation): Promise<Business[]> {
    return this.run(operation, null, async (context) =>
      (await repository.listBusinesses(context)).map(toBusiness),
    );
  }

  async get(operation: BusinessOperation, businessId: string): Promise<Business> {
    return this.run(operation, businessId, async (context) => {
      const row = await repository.findBusiness(context, businessId);
      if (!row) throw notFoundError("Business not found");
      return toBusiness(row);
    });
  }

  async create(operation: BusinessOperation, input: BusinessCreateInput): Promise<Business> {
    return this.run(operation, null, async (context) => {
      const storeSlug = `${slugify(input.displayName)}-${randomUUID().slice(0, 8)}`;
      const created = await repository.createBusiness(context, input, storeSlug);
      await repository.setBusinessContext(context, created.id);
      await seedDefaultChartOfAccounts(context, created.id);
      await seedStarterApprovalWorkflows(context, created.id, operation.userId);
      const row = await repository.findBusiness(context, created.id);
      if (!row) throw new Error("Created business could not be read in its transaction");
      const defaultBranchId = await createDefaultBranch(context, created.id, row.defaultStoreId, { name: row.displayName, timezone: row.timezone });
      await seedOwnerAsStaff(context, created.id, operation.userId, defaultBranchId);
      return toBusiness(row);
    });
  }

  async update(operation: BusinessOperation, businessId: string, input: BusinessUpdateInput): Promise<Business> {
    return this.run(operation, businessId, async (context) => {
      await this.requirePermission(context, businessId, "business.update");
      const updated = await repository.updateBusiness(context, businessId, input);
      if (!updated) throw notFoundError("Business not found");
      // Onboarding's "Preferred address" arrives here; it also becomes HQ's
      // address if HQ doesn't have one yet.
      if (input.addressLine1?.trim()) {
        await fillDefaultBranchAddress(context, businessId, {
          addressLine1: input.addressLine1.trim(),
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          postalCode: input.postalCode ?? null,
        });
      }
      const row = await repository.findBusiness(context, businessId);
      if (!row) throw notFoundError("Business not found");
      return toBusiness(row);
    });
  }

  /**
   * Sets the business's logo, banner and brand colour. An image must be a
   * confirmed upload owned by this business with the matching purpose
   * (business_logo / business_cover); null removes it.
   */
  async updateBranding(operation: BusinessOperation, businessId: string, input: BusinessBrandingUpdateInput): Promise<Business> {
    return this.run(operation, businessId, async (context) => {
      await this.requirePermission(context, businessId, "business.update");
      if (input.logoUploadId) await requireBusinessConfirmedUpload(context, operation.userId, businessId, input.logoUploadId, "business_logo");
      if (input.coverUploadId) await requireBusinessConfirmedUpload(context, operation.userId, businessId, input.coverUploadId, "business_cover");
      const updated = await repository.updateBranding(context, businessId, input);
      if (!updated) throw notFoundError("Business not found");
      const row = await repository.findBusiness(context, businessId);
      if (!row) throw notFoundError("Business not found");
      return toBusiness(row);
    });
  }

  /** Anonymous on purpose: a business's branding is shown on its public pages. */
  async getPublicBranding(requestId: string, businessId: string): Promise<BusinessBranding> {
    const branding = await withDatabaseContext(this.database, anonymousPrincipal(requestId), (context) => loadBusinessBranding(context, businessId));
    if (!branding) throw notFoundError("Business not found");
    // Absolute, like every other public payload (invoice, paylink, storefront): public pages render these as-is.
    return {
      logoUrl: absoluteBrandingImageUrl(branding.logoUrl),
      coverUrl: absoluteBrandingImageUrl(branding.coverUrl),
      brandColor: branding.brandColor,
    };
  }

  /** A short-lived download URL for one of the business's branding images, resolved fresh per request (presigned URLs expire). Null when none is set. */
  async resolveBrandingImageUrl(requestId: string, businessId: string, kind: BrandingImageKind): Promise<string | null> {
    const branding = await withDatabaseContext(this.database, anonymousPrincipal(requestId), (context) => loadBusinessBranding(context, businessId));
    const objectKey = { logo: branding?.logoObjectKey, cover: branding?.coverObjectKey }[kind];
    if (!objectKey) return null;
    return objectStorage.createPresignedDownloadUrl(objectKey);
  }

  async archive(operation: BusinessOperation, businessId: string): Promise<void> {
    return this.run(operation, businessId, async (context) => {
      await this.requirePermission(context, businessId, "business.archive");
      const archived = await repository.archiveBusiness(context, businessId);
      if (!archived) throw notFoundError("Business not found");
    });
  }

  private async requirePermission(context: Parameters<typeof repository.findBusiness>[0], businessId: string, permission: string): Promise<void> {
    return authorization.requirePermission(context, businessId, permission);
  }

  private async run<T>(operation: BusinessOperation, businessId: string | null, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "store";
}

function toBusiness(row: BusinessListRow): Business {
  return {
    id: row.id,
    displayName: row.displayName,
    status: row.status,
    defaultCurrency: row.defaultCurrency,
    timezone: row.timezone,
    primaryVertical: row.primaryVertical,
    createdBy: row.createdBy,
    website: row.website,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    roleCodes: row.roleCodes,
    branding: {
      logoUrl: row.logoUploadId ? brandingImagePath(row.id, "logo", row.logoUploadId) : null,
      coverUrl: row.coverUploadId ? brandingImagePath(row.id, "cover", row.coverUploadId) : null,
      brandColor: row.brandColor,
    },
    defaultStore: { id: row.defaultStoreId, name: row.defaultStoreName, slug: row.defaultStoreSlug },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
