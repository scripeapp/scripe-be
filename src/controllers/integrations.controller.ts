import crypto from "crypto";
import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import {
  generateAuthUrl,
  exchangeCodeForTokens,
  getUserEmail,
} from "../services/google-calendar.service";
import { supabaseAdmin } from "../config/supabaseAdmin";

// ============================================================================
// Helpers — HMAC-signed state prevents state forgery in OAuth callback
// ============================================================================

function signState(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("hex")
    .slice(0, 32);
  return `${data}.${sig}`;
}

function verifyState(state: string): { user_id: string } {
  const dot = state.lastIndexOf(".");
  if (dot === -1) throw new Error("Malformed state");
  const data = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("hex")
    .slice(0, 32);
  if (sig !== expected) throw new Error("Invalid state signature");
  return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
}

// ============================================================================
// GET /api/integrations
// ============================================================================
export const getIntegrations = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;

  try {
    const { data, error } = await supabaseClient
      .from("calendar_integrations")
      .select("provider, google_email, calendar_id, connected_at, scopes")
      .eq("user_id", req.user_id);

    if (error) throw error;

    const integrations = {
      google_calendar: {
        connected: false,
        email: null as string | null,
        calendar_id: null as string | null,
        connected_at: null as string | null,
        has_meet: false,
      },
    };

    const googleRow = data?.find((r) => r.provider === "google");
    if (googleRow) {
      integrations.google_calendar = {
        connected: true,
        email: googleRow.google_email,
        calendar_id: googleRow.calendar_id,
        connected_at: googleRow.connected_at,
        has_meet: (googleRow.scopes ?? []).includes(
          "https://www.googleapis.com/auth/calendar.events"
        ),
      };
    }

    return res.status(200).json({ success: true, data: integrations });
  } catch (error: any) {
    console.error("[Integrations] getIntegrations error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================================
// GET /api/integrations/google-calendar/connect
// ============================================================================
export const getGoogleConnectUrl = async (
  req: SupabaseRequest,
  res: Response
) => {
  try {
    const state = signState({ user_id: req.user_id });
    const url = generateAuthUrl(state);
    return res.status(200).json({ success: true, data: { url } });
  } catch (error: any) {
    console.error("[Integrations] getGoogleConnectUrl error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ============================================================================
// GET /api/integrations/google-calendar/callback
// ============================================================================
export const handleGoogleCallback = async (
  req: SupabaseRequest,
  res: Response
) => {
  const { code, state, error: oauthError } = req.query as Record<string, string>;
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

  if (oauthError) {
    return res.redirect(`${frontendUrl}/dashboard?tab=settings&section=integrations&error=google_denied`);
  }

  try {
    if (!state || !code) throw new Error("Missing state or code");

    // Verify HMAC signature — prevents forged state attacks
    const { user_id } = verifyState(state);
    if (!user_id) throw new Error("Invalid state payload");

    const tokens = await exchangeCodeForTokens(code);

    if (!tokens.refresh_token) {
      // This happens if the user already authorised before and didn't use prompt:consent
      // Our generateAuthUrl already forces prompt:consent so this shouldn't happen
      throw new Error("No refresh token returned from Google");
    }

    const googleEmail = tokens.access_token
      ? await getUserEmail(tokens.access_token)
      : null;

    const expiry =
      typeof tokens.expiry_date === "number"
        ? new Date(tokens.expiry_date).toISOString()
        : null;

    const { error: upsertError } = await supabaseAdmin!
      .from("calendar_integrations")
      .upsert(
        {
          user_id,
          provider: "google",
          google_email: googleEmail,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expiry: expiry,
          scopes: tokens.scope?.split(" ") ?? [],
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" }
      );

    if (upsertError) throw upsertError;

    return res.redirect(`${frontendUrl}/dashboard?tab=settings&section=integrations&success=google_connected`);
  } catch (error: any) {
    console.error("[Integrations] handleGoogleCallback error:", error);
    return res.redirect(`${frontendUrl}/dashboard?tab=settings&section=integrations&error=google_failed`);
  }
};

// ============================================================================
// DELETE /api/integrations/google-calendar
// ============================================================================
export const disconnectGoogleCalendar = async (
  req: SupabaseRequest,
  res: Response
) => {
  const supabaseClient = req.supabase!;

  try {
    const { error } = await supabaseClient
      .from("calendar_integrations")
      .delete()
      .eq("user_id", req.user_id)
      .eq("provider", "google");

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Google Calendar disconnected successfully",
    });
  } catch (error: any) {
    console.error("[Integrations] disconnectGoogleCalendar error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
