export type BusinessStatus = "active" | "suspended" | "archived";

export interface BusinessRow {
  readonly id: string;
  readonly displayName: string;
  readonly status: BusinessStatus;
  readonly defaultCurrency: string;
  readonly timezone: string;
  readonly primaryVertical: string | null;
  readonly createdBy: string;
  readonly website: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface Business extends Omit<BusinessRow, "createdAt" | "updatedAt" | "archivedAt"> {
  readonly roleCodes: string[];
  readonly defaultStore: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface BusinessListRow extends BusinessRow {
  readonly roleCodes: string[];
  readonly defaultStoreId: string;
  readonly defaultStoreName: string;
  readonly defaultStoreSlug: string;
}

export interface BusinessCreateInput {
  readonly displayName: string;
  readonly defaultCurrency: string;
  readonly timezone: string;
  readonly primaryVertical?: string | null;
}

export interface BusinessUpdateInput {
  readonly displayName?: string;
  readonly defaultCurrency?: string;
  readonly timezone?: string;
  readonly primaryVertical?: string | null;
  readonly website?: string;
  readonly addressLine1?: string | null;
  readonly addressLine2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly country?: string;
}

export interface BusinessOperation {
  readonly userId: string;
  readonly requestId: string;
}
