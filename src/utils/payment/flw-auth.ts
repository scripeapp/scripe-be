import axios from "axios";

const TOKEN_URL =
  "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Returns a valid FLW OAuth2 access token, refreshing 60s before expiry.
 * Shared by FlutterwaveProvider, flutterwave.util, and currency-rates.util.
 */
export async function getFlwAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.value;
  }

  const clientId = process.env.FLW_CLIENT_ID;
  const clientSecret = process.env.FLW_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("FLW_CLIENT_ID and FLW_CLIENT_SECRET must be configured");
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);

  const res = await axios.post<{ access_token: string; expires_in: number }>(
    TOKEN_URL,
    params.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10_000,
    },
  );

  cachedToken = {
    value: res.data.access_token,
    expiresAt: now + res.data.expires_in * 1_000,
  };
  return cachedToken.value;
}

