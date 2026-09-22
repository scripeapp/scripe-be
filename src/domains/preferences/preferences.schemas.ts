import { z } from "zod";

const MAX_PATCH_BYTES = 20_000;

export const updatePreferencesSchema = z
  .record(z.string().min(1).max(100), z.unknown())
  .refine((value) => Object.keys(value).length > 0, "At least one preference key is required")
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PATCH_BYTES, `Preferences patch must be ${MAX_PATCH_BYTES} bytes or smaller`);
