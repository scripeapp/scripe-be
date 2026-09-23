export type ProductStatus = "draft" | "active" | "archived";
export type ProductType = "physical" | "service" | "digital" | "menu" | "pharmacy";

export interface ProductRow {
  readonly id: string; readonly businessId: string; readonly storeId: string;
  readonly name: string; readonly slug: string; readonly description: string;
  readonly productType: ProductType; readonly status: ProductStatus;
  readonly isSellable: boolean; readonly trackInventory: boolean; readonly allowBackorder: boolean;
  readonly createdBy: string; readonly createdAt: Date; readonly updatedAt: Date; readonly archivedAt: Date | null;
}
export interface VariantRow { readonly id: string; readonly businessId: string; readonly productId: string; readonly sku: string | null; readonly name: string; readonly optionValues: Record<string, unknown>; readonly unitId: string | null; readonly isDefault: boolean; readonly status: "active" | "archived"; readonly createdAt: Date; readonly updatedAt: Date; readonly archivedAt: Date | null; }
export interface CategoryRow { readonly id: string; readonly businessId: string; readonly parentId: string | null; readonly name: string; readonly slug: string; readonly description: string; readonly status: "active" | "archived"; readonly sortOrder: number; readonly createdAt: Date; readonly updatedAt: Date; readonly archivedAt: Date | null; }
export interface Product extends Omit<ProductRow, "createdAt" | "updatedAt" | "archivedAt"> { readonly createdAt: string; readonly updatedAt: string; readonly archivedAt: string | null; readonly variants: Variant[]; readonly categoryIds: string[]; }
export interface Variant extends Omit<VariantRow, "createdAt" | "updatedAt" | "archivedAt"> { readonly createdAt: string; readonly updatedAt: string; readonly archivedAt: string | null; }
export interface Category extends Omit<CategoryRow, "createdAt" | "updatedAt" | "archivedAt"> { readonly createdAt: string; readonly updatedAt: string; readonly archivedAt: string | null; }
export interface ProductCreateInput { readonly storeId: string; readonly name: string; readonly slug?: string; readonly description?: string; readonly productType?: ProductType; readonly status?: Exclude<ProductStatus, "archived">; readonly isSellable?: boolean; readonly trackInventory?: boolean; readonly allowBackorder?: boolean; readonly variant?: { readonly name?: string; readonly sku?: string | null; readonly optionValues?: Record<string, unknown>; readonly unitId?: string | null }; readonly categoryIds?: string[]; }
export interface ProductUpdateInput { readonly name?: string; readonly slug?: string; readonly description?: string; readonly productType?: ProductType; readonly status?: Exclude<ProductStatus, "archived">; readonly isSellable?: boolean; readonly trackInventory?: boolean; readonly allowBackorder?: boolean; readonly categoryIds?: string[]; }
export interface VariantInput { readonly name: string; readonly sku?: string | null; readonly optionValues?: Record<string, unknown>; readonly unitId?: string | null; readonly isDefault?: boolean; }
export interface CategoryInput { readonly name: string; readonly slug?: string; readonly parentId?: string | null; readonly description?: string; readonly sortOrder?: number; }
export interface CategoryUpdateInput { readonly name?: string; readonly slug?: string; readonly parentId?: string | null; readonly description?: string; readonly sortOrder?: number; }
export interface ProductOperation { readonly userId: string; readonly businessId: string; readonly requestId: string; }
export interface PublicVariant extends Variant { readonly priceMinor: string | null; readonly compareAtMinor: string | null; readonly assetCode: string | null; }
export interface PublicProduct extends Omit<Product, "variants"> { readonly variants: PublicVariant[]; }
