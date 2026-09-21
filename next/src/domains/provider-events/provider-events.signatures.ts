import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnvironment } from "../../shared/environment.js";

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Paystack re-signs the raw body with the API secret key itself — HMAC-SHA512, hex digest, header x-paystack-signature. */
export function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secretKey = loadEnvironment().PAYSTACK_SECRET_KEY;
  if (!secretKey || !signature) return false;
  const expected = createHmac("sha512", secretKey).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}

/** Flutterwave uses a pre-shared static token compared directly against the verif-hash header — not a per-request HMAC. */
export function verifyFlutterwaveSignature(header: string | undefined): boolean {
  const hash = loadEnvironment().FLW_WEBHOOK_HASH;
  if (!hash || !header) return false;
  return safeEqual(hash, header);
}

/** Anchor: Base64(HMAC-SHA1(rawBody, key=webhook token)), header x-anchor-signature. https://docs.getanchor.co/docs/verify-webhooks */
export function verifyAnchorSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const token = loadEnvironment().ANCHOR_WEBHOOK_TOKEN;
  if (!token || !signature) return false;
  const expected = createHmac("sha1", token).update(rawBody).digest("base64");
  return safeEqual(expected, signature);
}

/** Brails: HMAC-SHA512(rawBody, key=webhook secret), hex digest, header x-brails-signature. */
export function verifyBrailsSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = loadEnvironment().BRAILS_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}
