import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { loadEnvironment } from "../../shared/environment.js";

export type BrandingImageKind = "logo" | "cover";

export interface BusinessBranding {
  /** Relative to the API origin; `?v=` changes whenever the image does, so caches never show a stale logo. */
  readonly logoUrl: string | null;
  /** The storefront banner. */
  readonly coverUrl: string | null;
  /** The one brand colour, used on the storefront, checkout, invoices and emails. */
  readonly brandColor: string | null;
}

interface BrandingRow {
  readonly businessId: string;
  readonly displayName: string;
  readonly brandColor: string | null;
  readonly logoUploadId: string | null;
  readonly logoObjectKey: string | null;
  readonly coverUploadId: string | null;
  readonly coverObjectKey: string | null;
}

/** The public image route for one of a business's branding images. */
export function brandingImagePath(businessId: string, kind: BrandingImageKind, version: string): string {
  return `/api/businesses/${businessId}/branding/${kind}?v=${version}`;
}

/** brandingImagePath as an absolute URL, for places with no frontend to prefix it (emails). */
export function absoluteBrandingImageUrl(path: string | null): string | null {
  if (!path) return null;
  return `${new URL(loadEnvironment().BETTER_AUTH_URL).origin}${path}`;
}

/**
 * A business's branding, readable with or without a signed-in user (public
 * invoice, payment link and storefront pages, emails). Goes through
 * app.get_business_branding, which only ever reveals that business's
 * confirmed branding images. Undefined when the business doesn't exist or
 * is archived.
 */
export async function loadBusinessBranding(context: DatabaseContext, businessId: string): Promise<(BusinessBranding & { logoObjectKey: string | null; coverObjectKey: string | null; displayName: string }) | undefined> {
  const result = await sql<BrandingRow>`select * from app.get_business_branding(${businessId}::uuid)`.execute(context.transaction);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    displayName: row.displayName,
    brandColor: row.brandColor,
    logoUrl: row.logoUploadId ? brandingImagePath(businessId, "logo", row.logoUploadId) : null,
    coverUrl: row.coverUploadId ? brandingImagePath(businessId, "cover", row.coverUploadId) : null,
    logoObjectKey: row.logoObjectKey,
    coverObjectKey: row.coverObjectKey,
  };
}
