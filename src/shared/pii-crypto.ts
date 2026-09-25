import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { loadEnvironment } from "./environment.js";

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";

let cachedKey: Buffer | undefined;

/**
 * Field-level encryption for identity numbers (BVN, NIN, ID numbers, dates
 * of birth) that must never sit in the database as plain text. Production
 * requires an explicit PII_ENCRYPTION_KEY (validated at startup); other
 * environments derive a stable key from BETTER_AUTH_SECRET so local and test
 * databases still exercise the encrypted path.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const environment = loadEnvironment();
  cachedKey = environment.PII_ENCRYPTION_KEY
    ? Buffer.from(environment.PII_ENCRYPTION_KEY, "base64")
    : createHash("sha256").update(`pii:${environment.BETTER_AUTH_SECRET}`).digest();
  if (cachedKey.length !== 32) throw new Error("PII_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
  return cachedKey;
}

export function encryptPii(value: string): string;
export function encryptPii(value: string | null | undefined): string | null;
export function encryptPii(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

/** Rows written before encryption existed are plain text — returned unchanged rather than failing the read. */
export function decryptPii(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!value.startsWith(PREFIX)) return value;
  const [iv, tag, ciphertext] = value.slice(PREFIX.length).split(":");
  if (!iv || !tag || !ciphertext) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 4 ? "****" : `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}
