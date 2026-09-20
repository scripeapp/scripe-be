export type CartStatus = "active" | "converted" | "abandoned";
export interface CartRow { readonly id: string; readonly businessId: string; readonly storeId: string; readonly channelId: string; readonly customerPartyId: string | null; readonly currency: string; readonly status: CartStatus; readonly createdBy: string | null; readonly createdAt: Date; readonly updatedAt: Date; readonly convertedAt: Date | null; }
export interface CartLineRow { readonly id: string; readonly businessId: string; readonly cartId: string; readonly productVariantId: string; readonly quantity: number; readonly selectedModifiers: Record<string, unknown>; readonly quotedUnitMinor: string | null; readonly assetCode: string; readonly createdAt: Date; readonly updatedAt: Date; }
export interface Cart { readonly id: string; readonly businessId: string; readonly storeId: string; readonly channelId: string; readonly customerPartyId: string | null; readonly currency: string; readonly status: CartStatus; readonly createdAt: string; readonly updatedAt: string; readonly convertedAt: string | null; readonly lines: CartLine[]; }
export interface CartLine extends Omit<CartLineRow, "createdAt" | "updatedAt"> { readonly createdAt: string; readonly updatedAt: string; }
export interface CartOperation { readonly userId: string; readonly businessId: string; readonly requestId: string; }
export interface CreateCartInput { readonly storeId: string; readonly channelId: string; readonly customerPartyId?: string | null; readonly currency?: string; }
export interface AddCartLineInput { readonly productVariantId: string; readonly quantity: number; readonly selectedModifiers?: Record<string, unknown>; readonly assetCode?: string; }
export interface UpdateCartLineInput { readonly quantity: number; readonly selectedModifiers?: Record<string, unknown>; }
export interface CheckoutInput { readonly locationId?: string | null; readonly discountCode?: string | null; readonly idempotencyKey: string; }
