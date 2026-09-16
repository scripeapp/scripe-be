import { randomBytes } from "node:crypto";

/**
 * Canonical reference format for every Hilaq-generated transaction key.
 *
 * Entities used to build their own templates (uuid, timestamps, id slices) —
 * which made keys inconsistent and Date.now()-based ones collision-prone. Both
 * payment providers require a unique client-generated reference, so we shape
 * them here, once, in a format that is easy to read and type aloud in support
 * tickets:
 *
 *   createTransactionReference(REFERENCE_TYPES.WITHDRAWAL) -> HLQ-WDR-3FK29QN7
 *
 * The prefix is brand-only: it does NOT encode the payment provider. Verify
 * flows receive the provider explicitly instead, so the format stays uniform
 * across providers. Historical refs of the old HILAQ-<ENTITY>-<12> / FLW-
 * families are left untouched in the database.
 */
export const REFERENCE_TYPES = {
  EVENT_TICKET: "EVT",
  ORDER: "ORD",
  TRANSFER: "TRF",
  WITHDRAWAL: "WDR",
  DEPOSIT: "DEP",
  SUBSCRIPTION: "SUB",
  REFUND: "RFD",
  PAYMENT: "PAY",
} as const;

export type TransactionReferenceType =
  (typeof REFERENCE_TYPES)[keyof typeof REFERENCE_TYPES];

const REFERENCE_PREFIX = "HLQ";
const RANDOM_SEGMENT_LENGTH = 8;
// 32 characters, excluding confusable 0/O/1/I/L so the key reads well.
const UNIQUE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VALID_TYPES = new Set<string>(Object.values(REFERENCE_TYPES));

export function createTransactionReference(
  type: TransactionReferenceType,
): string {
  if (!VALID_TYPES.has(type)) {
    throw new Error(
      `Invalid reference type "${type}". Use a code from REFERENCE_TYPES.`,
    );
  }
  return `${REFERENCE_PREFIX}-${type}-${generateRandomSegment(RANDOM_SEGMENT_LENGTH)}`;
}

// randomBytes are uniform per byte and 256 is divisible by 32, so mod 32 is bias-free.
function generateRandomSegment(length: number): string {
  const bytes = randomBytes(length);
  let segment = "";
  for (let i = 0; i < length; i++) {
    segment += UNIQUE_CHARACTERS[bytes[i] % UNIQUE_CHARACTERS.length];
  }
  return segment;
}
