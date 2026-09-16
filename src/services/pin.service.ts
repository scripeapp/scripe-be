import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import type { SetPinInput } from "../types/pin.schemas";

const MAX_PIN_ATTEMPTS = 3;
const PIN_LOCK_MS = 24 * 60 * 60 * 1000;
const PIN_LENGTH_BYTES = 32;

interface ActiveVirtualAccountPin {
  id: string;
  has_pin: boolean;
  pin_hash: string | null;
  pin_attempts: number | null;
  pin_locked_until: string | null;
}

interface PinErrorDetails {
  code: "PIN_NOT_SET" | "PIN_INCORRECT" | "PIN_LOCKED" | "BVN_MISMATCH";
  remaining_attempts?: number;
  locked_until?: string | null;
}

export class PinService {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Create a PIN on the business virtual account, or change it when the
   * current PIN is supplied. The PIN is scoped to the business's active
   * virtual account row — one per business, so no separate table.
   */
  async setPin(input: SetPinInput): Promise<void> {
    const row = await this.getPinRecord(input.business_id);
    if (!row) {
      throw this.httpError(
        "Create a virtual account before setting a transaction PIN",
        409,
      );
    }
    if (row.has_pin) {
      if (!input.current_pin) {
        throw this.httpError(
          "Your current PIN is required to change the transaction PIN",
          400,
        );
      }
      await this.verify(input.business_id, input.current_pin);
    }

    const { salt, saltHash } = this.hashPin(input.pin);
    await this.supabase
      .from("virtual_accounts")
      .update({
        has_pin: true,
        pin_hash: `${salt}.${saltHash}`,
        pin_attempts: 0,
        pin_locked_until: null,
        pin_updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  }

  /**
   * Verify the PIN before any money movement. Rejects after MAX_PIN_ATTEMPTS
   * failures with a 24-hour lockout, and resets on success. Error details
   * carry the remaining attempts / lock expiry so the UI can explain the
   * lockout without exposing the stored attempts count in the row itself.
   */
  async verify(businessId: string, pin: string): Promise<void> {
    const row = await this.getPinRecord(businessId);
    if (!row || !row.has_pin || !row.pin_hash) {
      throw this.httpError(
        "Set a transaction PIN before sending money",
        400,
        { code: "PIN_NOT_SET" },
      );
    }
    if (
      row.pin_locked_until &&
      new Date(row.pin_locked_until).getTime() > Date.now()
    ) {
      throw this.httpError("Too many incorrect PIN attempts. Try again later.", 423, {
        code: "PIN_LOCKED",
        locked_until: row.pin_locked_until,
      });
    }

    if (this.matchesPin(row.pin_hash, pin)) {
      await this.supabase
        .from("virtual_accounts")
        .update({ pin_attempts: 0, pin_locked_until: null })
        .eq("id", row.id);
      return;
    }

    const attempts = (row.pin_attempts ?? 0) + 1;
    const locksOut = attempts >= MAX_PIN_ATTEMPTS;
    await this.supabase
      .from("virtual_accounts")
      .update({
        pin_attempts: attempts,
        pin_locked_until: locksOut
          ? new Date(Date.now() + PIN_LOCK_MS).toISOString()
          : null,
      })
      .eq("id", row.id);

    throw this.httpError("Incorrect PIN", 401, {
      code: "PIN_INCORRECT",
      remaining_attempts: Math.max(0, MAX_PIN_ATTEMPTS - attempts),
    });
  }

  /**
   * Clear a locked PIN using the BVN that verified this business's banking
   * KYC. Only the last 4 digits are requested (the full BVN is never stored);
   * matching them against the latest approved KYC record proves the caller
   * holds the same identity that set up money movement.
   */
  async resetLockedPinWithBvn(
    businessId: string,
    bvnLast4: string,
  ): Promise<void> {
    const row = await this.getPinRecord(businessId);
    if (!row) {
      throw this.httpError(
        "Create a virtual account before managing a transaction PIN",
        409,
      );
    }
    if (!row.has_pin) {
      throw this.httpError("No transaction PIN has been set", 400);
    }

    const { data: kyc, error: kycError } = await this.supabase
      .from("kyc_verifications")
      .select("document_number")
      .eq("business_id", businessId)
      .eq("document_type", "bvn")
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (kycError) throw kycError;
    if (!kyc?.document_number || !kyc.document_number.endsWith(bvnLast4)) {
      throw this.httpError(
        "That BVN doesn't match the one used to verify this business",
        400,
        { code: "BVN_MISMATCH" },
      );
    }

    await this.supabase
      .from("virtual_accounts")
      .update({ pin_attempts: 0, pin_locked_until: null })
      .eq("id", row.id);
  }

  private async getPinRecord(
    businessId: string,
  ): Promise<ActiveVirtualAccountPin | null> {
    const { data, error } = await this.supabase
      .from("virtual_accounts")
      .select("id, has_pin, pin_hash, pin_attempts, pin_locked_until")
      .eq("business_id", businessId)
      .in("status", ["pending", "active"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  private hashPin(pin: string): { salt: string; saltHash: string } {
    const salt = randomBytes(16).toString("hex");
    return { salt, saltHash: this.deriveHash(pin, salt).toString("hex") };
  }

  /**
   * Stored format is `salt.hash`. A random per-record salt keeps the 4-digit
   * space resistant to offline precomputation; the pepper keeps a leaked
   * database from being brute-forced offline at all.
   */
  private matchesPin(stored: string, pin: string): boolean {
    const [salt, saltHash] = stored.split(".");
    if (!salt || !saltHash) return false;
    return timingSafeEqual(
      this.deriveHash(pin, salt),
      Buffer.from(saltHash, "hex"),
    );
  }

  private deriveHash(pin: string, salt: string): Buffer {
    const pepper = process.env.PIN_PEPPER || "hilaq-pin-pepper-v1";
    return scryptSync(`${pin}:${pepper}`, salt, PIN_LENGTH_BYTES);
  }

  private httpError(
    message: string,
    statusCode: number,
    details?: PinErrorDetails,
  ): Error {
    return Object.assign(new Error(message), { statusCode, details });
  }
}