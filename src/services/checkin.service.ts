import crypto from "crypto";
import { SupabaseClient } from "@supabase/supabase-js";

const CHECKIN_TOKEN_EXPIRY_HOURS = 8;
const ACCESS_CODE_LENGTH = 6;

// Excludes visually ambiguous characters (0/O, 1/I/L)
const ACCESS_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface CheckinTokenPayload {
  event_id: string;
  expires_at: string;
}

export interface SignedCheckinToken {
  token: string;
  expires_at: string;
}

class CheckinService {
  private get tokenSecret(): string {
    const secret = process.env.CHECKIN_TOKEN_SECRET;
    if (!secret) {
      throw new Error("CHECKIN_TOKEN_SECRET environment variable is not set");
    }
    return secret;
  }

  generateAccessCode(): string {
    const bytes = crypto.randomBytes(ACCESS_CODE_LENGTH);
    return Array.from(bytes)
      .map((byte) => ACCESS_CODE_CHARS[byte % ACCESS_CODE_CHARS.length])
      .join("");
  }

  hashCode(eventId: string, code: string): string {
    // eventId acts as a salt: the same code yields a different hash per event
    return crypto
      .createHash("sha256")
      .update(`${eventId}:${code.toUpperCase()}`)
      .digest("hex");
  }

  verifyCode(eventId: string, code: string, storedHash: string): boolean {
    const computedHash = this.hashCode(eventId, code);
    const computedBuffer = Buffer.from(computedHash, "hex");
    const storedBuffer = Buffer.from(storedHash, "hex");
    if (computedBuffer.length !== storedBuffer.length) return false;
    return crypto.timingSafeEqual(computedBuffer, storedBuffer);
  }

  signCheckinToken(eventId: string): SignedCheckinToken {
    const expiresAt = new Date(
      Date.now() + CHECKIN_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const payload = Buffer.from(
      JSON.stringify({ event_id: eventId, expires_at: expiresAt }),
    ).toString("base64url");

    const signature = crypto
      .createHmac("sha256", this.tokenSecret)
      .update(payload)
      .digest("base64url");

    return { token: `${payload}.${signature}`, expires_at: expiresAt };
  }

  verifyCheckinToken(token: string): CheckinTokenPayload | null {
    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) return null;

    const payload = token.slice(0, dotIndex);
    const signature = token.slice(dotIndex + 1);

    const expectedSignature = crypto
      .createHmac("sha256", this.tokenSecret)
      .update(payload)
      .digest("base64url");

    const sigBuffer = Buffer.from(signature, "base64url");
    const expectedBuffer = Buffer.from(expectedSignature, "base64url");

    if (sigBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;

    try {
      const data: CheckinTokenPayload = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      if (new Date(data.expires_at) < new Date()) return null;
      return data;
    } catch {
      return null;
    }
  }

  async saveAccessCodeHash(
    supabase: SupabaseClient,
    eventId: string,
    hash: string,
  ): Promise<void> {
    const { error } = await supabase
      .from("events")
      .update({ checkin_access_code_hash: hash })
      .eq("id", eventId);
    if (error) throw error;
  }

  async loadAccessCodeHash(
    supabase: SupabaseClient,
    eventId: string,
  ): Promise<string | null> {
    const { data, error } = await supabase
      .from("events")
      .select("checkin_access_code_hash")
      .eq("id", eventId)
      .single();
    if (error) throw error;
    return data?.checkin_access_code_hash ?? null;
  }
}

export const checkinService = new CheckinService();
