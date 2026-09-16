/**
 * Digital Product Service
 * Handles download management for digital products.
 * New files are stored in R2; legacy files remain in Supabase Storage.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { supabaseAdmin } from "../config/supabase";
import { getR2Client, R2_BUCKET_NAME } from "../config/r2";
import { isR2Path, extractR2Key } from "../utils/storage.util";

const SUPABASE_STORAGE_BUCKET = "stores";
const DOWNLOAD_URL_EXPIRY = 3600; // 1 hour in seconds

export interface DownloadRecord {
  id: string;
  order_id: string;
  product_id: string;
  user_id: string | null;
  downloaded_at: string;
  ip_address: string | null;
}

/**
 * Pure window calculation shared by the download service.
 * An entitlement was established once at `firstIssuedAt`; a null
 * `expiryHours` means the window never closes (unlimited). This is the
 * single source of truth for the "active / expired" decision so the
 * enforcement path and the tests can't drift.
 */
export function evaluateDownloadWindow(opts: {
  firstIssuedAt: string | Date;
  expiryHours: number | null;
  now?: Date;
}): { expired: boolean; expiresAt: Date | null } {
  if (opts.expiryHours == null) {
    return { expired: false, expiresAt: null };
  }
  const issuedAt = new Date(opts.firstIssuedAt).getTime();
  const expiresAt = new Date(issuedAt + opts.expiryHours * 60 * 60 * 1000);
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  return { expired: now > expiresAt.getTime(), expiresAt };
}

export class DigitalProductService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Get a signed download URL for a purchased product
   */
  async getDownloadUrl(
    orderId: string,
    productId: string,
    userId?: string,
    ipAddress?: string,
  ): Promise<{
    download_url: string;
    file_name: string;
    downloads_remaining: number | null;
  }> {
    // Verify order exists and contains this product
    console.log(
      "[DigitalProductService.getDownloadUrl] Looking up order:",
      orderId,
    );

    // Use admin client to bypass RLS for public/guest downloads
    const DB = supabaseAdmin;

    const { data: order, error: orderError } = await DB.from("store_orders")
      .select("id, items, status")
      .eq("id", orderId)
      .single();

    console.log("[DigitalProductService.getDownloadUrl] Order query result:", {
      found: !!order,
      error: orderError?.message,
      orderStatus: order?.status,
    });

    if (orderError || !order) {
      throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    }

    // Check order status
    if (!["paid", "fulfilled"].includes(order.status)) {
      throw Object.assign(new Error("Order must be paid to download"), {
        statusCode: 403,
      });
    }

    // Verify product is in order
    const orderItems = (order.items as any[]) || [];
    const productItem = orderItems.find(
      (item: any) => item.product_id === productId,
    );

    if (!productItem) {
      throw Object.assign(new Error("Product not found in order"), {
        statusCode: 404,
      });
    }

    // Get product details
    const { data: product, error: productError } = await DB.from("products")
      .select("id, digital, type, digital_link_expiry_hours")
      .eq("id", productId)
      .single();

    if (productError || !product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    if (product.type !== "digital") {
      throw Object.assign(new Error("Product is not a digital product"), {
        statusCode: 400,
      });
    }

    const expiryHours = product.digital_link_expiry_hours as number | null;

    // Establish the entitlement once. Repeated link requests reuse this
    // timestamp and therefore cannot extend the buyer's access window.
    const { data: entitlement, error: entitlementError } = await DB.rpc(
      "issue_digital_entitlement",
      { p_order_id: orderId, p_product_id: productId },
    );
    if (entitlementError) throw entitlementError;
    const firstIssuedAt = entitlement || (await DB.from("digital_entitlements")
      .select("first_download_link_issued_at")
      .eq("order_id", orderId)
      .eq("product_id", productId)
      .single()).data?.first_download_link_issued_at;

    // Enforce the (once-established) digital link expiry window.
    const { expired } = evaluateDownloadWindow({
      firstIssuedAt,
      expiryHours,
    });
    if (expired) {
      throw Object.assign(new Error("Download link has expired. Please purchase again."), { statusCode: 403 });
    }

    // Determine download URL and download limit — the unified digital shape
    // covers both legacy ebooks (files) and direct downloadable assets.
    const digital = product.digital as {
      download_url?: string;
      download_limit?: number;
      files?: {
        pdf_url?: string | null;
        epub_url?: string | null;
        mobi_url?: string | null;
      } | null;
    } | null;
    const downloadUrl =
      digital?.download_url ||
      digital?.files?.pdf_url ||
      digital?.files?.epub_url ||
      digital?.files?.mobi_url ||
      undefined;
    const downloadLimit = digital?.download_limit;

    if (!downloadUrl) {
      throw Object.assign(new Error("No download file available"), {
        statusCode: 404,
      });
    }

    // Check download limit
    let downloadsRemaining: number | null = null;

    if (downloadLimit !== null && downloadLimit !== undefined) {
      // Count existing downloads
      const { count } = await DB.from("order_downloads")
        .select("id", { count: "exact", head: true })
        .eq("order_id", orderId)
        .eq("product_id", productId);

      const downloadCount = count || 0;

      if (downloadCount >= downloadLimit) {
        throw Object.assign(new Error("Download limit exceeded"), {
          statusCode: 403,
        });
      }

      downloadsRemaining = downloadLimit - downloadCount - 1; // -1 for current download
    }

    // Record the download
    await DB.from("order_downloads").insert({
      order_id: orderId,
      product_id: productId,
      user_id: userId || null,
      ip_address: ipAddress || null,
    });

    const signedDownloadUrl = await this.createSignedDownloadUrl(downloadUrl);
    const fileName = downloadUrl.split("/").pop() || "hilaq-download";

    return {
      download_url: signedDownloadUrl,
      file_name: fileName,
      downloads_remaining: downloadsRemaining,
    };
  }

  /**
   * Get download history for a product
   */
  async getDownloadHistory(
    productId: string,
    limit: number = 50,
  ): Promise<DownloadRecord[]> {
    const { data, error } = await this.supabase
      .from("order_downloads")
      .select("*")
      .eq("product_id", productId)
      .order("downloaded_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[DigitalProductService.getDownloadHistory] Error:", error);
      throw error;
    }

    return data as DownloadRecord[];
  }

  /**
   * Delete a product file from storage (handles both R2 and legacy Supabase paths)
   */
  async deleteProductFile(storagePath: string): Promise<void> {
    if (isR2Path(storagePath)) {
      const r2 = getR2Client();
      if (!r2) return;
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const key = extractR2Key(storagePath);
      if (!key) return;
      await r2
        .send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
        .catch((err) =>
          console.error("[DigitalProductService.deleteProductFile] R2 error:", err),
        );
      return;
    }

    const { error } = await this.supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .remove([storagePath]);

    if (error) {
      console.error("[DigitalProductService.deleteProductFile] Error:", error);
    }
  }

  /**
   * Get a signed sample URL for a digital product (public, no auth required)
   */
  async getDigitalSample(productId: string): Promise<{ sample_url: string }> {
    const { data: product, error } = await this.supabase
      .from("products")
      .select("id, type, digital")
      .eq("id", productId)
      .single();

    if (error || !product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    if (product.type !== "digital") {
      throw Object.assign(new Error("Product is not a digital product"), {
        statusCode: 400,
      });
    }

    const digital = product.digital as {
      has_sample?: boolean;
      sample_url?: string;
    } | null;

    if (!digital?.has_sample || !digital?.sample_url) {
      throw Object.assign(new Error("No sample available for this digital product"), {
        statusCode: 404,
      });
    }

    // Already a public URL (e.g. R2 public CDN URL) — return directly
    if (digital.sample_url.startsWith("http")) {
      return { sample_url: digital.sample_url };
    }

    const sampleUrl = await this.createSignedDownloadUrl(digital.sample_url);
    return { sample_url: sampleUrl };
  }

  /**
   * Get all digital products purchased by a user
   */
  async getUserDownloads(userId: string): Promise<any[]> {
    // 1. Get all paid orders for this user
    const { data: orders, error: ordersError } = await this.supabase
      .from("store_orders")
      .select("id, items, created_at, order_number, store:stores(name, slug)")
      .eq("customer_email", await this.getUserEmail(userId)) // We need email to match orders
      // OR if we track user_id on orders, use that: .eq("user_id", userId)
      // Current schema seems to rely on email for guest checkout support, but let's check if we can match by email
      // For now, let's assume we fetch by email matching the user's email
      .in("status", ["paid", "fulfilled"])
      .order("created_at", { ascending: false });

    if (ordersError) throw ordersError;
    if (!orders || orders.length === 0) return [];

    const downloads: any[] = [];

    // 2. Extract digital items
    for (const order of orders) {
      const items = (order.items as any[]) || [];

      // Filter for validation, but we can also optimize by fetching digital product IDs first
      const productIds = items.map((i: any) => i.product_id);

      if (productIds.length === 0) continue;

      const { data: products } = await this.supabase
        .from("products")
        .select("id, name, type, digital, cover_image")
        .in("id", productIds)
        .eq("type", "digital");

      if (products && products.length > 0) {
        for (const product of products) {
          const orderItem = items.find((i: any) => i.product_id === product.id);
          downloads.push({
            order_id: order.id,
            order_number: order.order_number,
            product_id: product.id,
            product_name: product.name,
            cover_image: product.cover_image,
            store_name: (order.store as any)?.name,
            store_slug: (order.store as any)?.slug,
            purchase_date: order.created_at,
            file_type: product.digital?.file_type,
            file_size: product.digital?.file_size,
          });
        }
      }
    }

    return downloads;
  }

  private async getUserEmail(userId: string): Promise<string> {
    const { data, error } = await this.supabase
      .from("users")
      .select("email")
      .eq("id", userId)
      .single();

    if (error || !data) throw new Error("User not found");
    return data.email;
  }

  // ── Signed URL generation ─────────────────────────────────────────────

  /**
   * Creates a time-limited signed download URL for either R2 or legacy Supabase files.
   */
  private async createSignedDownloadUrl(urlOrPath: string): Promise<string> {
    if (isR2Path(urlOrPath)) {
      return this.createR2SignedUrl(urlOrPath);
    }
    return this.createSupabaseSignedUrl(urlOrPath);
  }

  private async createR2SignedUrl(urlOrPath: string): Promise<string> {
    const r2 = getR2Client();
    if (!r2) {
      throw Object.assign(new Error("R2 storage is not configured"), {
        statusCode: 500,
      });
    }

    const key = extractR2Key(urlOrPath) ?? urlOrPath;
    const command = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key });
    return getSignedUrl(r2, command, { expiresIn: DOWNLOAD_URL_EXPIRY });
  }

  private async createSupabaseSignedUrl(urlOrPath: string): Promise<string> {
    const storagePath = this.extractSupabaseStoragePath(urlOrPath);
    const fileName = storagePath.split("/").pop() || "hilaq-download";
    const storageClient = supabaseAdmin || this.supabase;

    const { data, error } = await storageClient.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .createSignedUrl(storagePath, DOWNLOAD_URL_EXPIRY, {
        download: fileName,
      });

    if (error || !data) {
      console.error(
        "[DigitalProductService.createSupabaseSignedUrl] Error:",
        error,
      );
      throw Object.assign(new Error("Failed to generate download URL"), {
        statusCode: 500,
      });
    }

    return data.signedUrl;
  }

  /**
   * Extracts the Supabase storage path from a full URL or returns as-is if already a path.
   */
  private extractSupabaseStoragePath(urlOrPath: string): string {
    if (!urlOrPath.startsWith("http")) {
      return decodeURIComponent(urlOrPath);
    }

    try {
      const url = new URL(urlOrPath);
      const pathname = url.pathname;

      const publicMatch = pathname.match(
        /\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+)/,
      );
      if (publicMatch) {
        return decodeURIComponent(publicMatch[1]);
      }

      const bucketRegex = new RegExp(`\/${SUPABASE_STORAGE_BUCKET}\/(.+)`);
      const bucketMatch = pathname.match(bucketRegex);
      if (bucketMatch) {
        return decodeURIComponent(bucketMatch[1]);
      }

      return decodeURIComponent(urlOrPath);
    } catch {
      return decodeURIComponent(urlOrPath);
    }
  }
}
