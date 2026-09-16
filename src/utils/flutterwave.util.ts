import axios from "axios";

// Management APIs (subaccounts, banks) use v3 with secret key — not the f4b transaction URL.
const FLW_MGMT_URL = "https://api.flutterwave.com/v3";

function getMgmtAuthHeader() {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error("FLW_SECRET_KEY must be configured for subaccount management");
  return `Bearer ${key}`;
}

export interface FlwSubaccountData {
  /** Bank account number */
  account_number: string;
  /** Flutterwave bank code — use getFlutterwaveBanks() to look up */
  account_bank: string;
  /** Legal business / account holder name */
  business_name: string;
  /** ISO country code, e.g. "NG", "GH", "KE" */
  country: string;
  /** Optional contact email shown in the FLW dashboard */
  business_email?: string;
  /** Optional short description */
  business_description?: string;
  /** Optional mobile number */
  mobile_number?: string;
  /** Split type sent on transactions. Defaults to "flat" */
  split_type?: "flat" | "percentage";
  /** Split value (only used for Flutterwave-managed recurring splits; we set per-transaction instead) */
  split_value?: number;
}

export interface FlwSubaccountResult {
  /** Unique subaccount identifier — store this as flw_subaccount_id */
  id: string;
  subaccount_id: string;
  bank_name: string;
  account_number: string;
  business_name: string;
  country: string;
}

/**
 * Create a Flutterwave subaccount for a merchant.
 * Store the returned `subaccount_id` (RS_xxxx) as `flw_subaccount_id` on the business record.
 * The numeric `id` is used only for management PUT/DELETE operations.
 */
export async function createFlutterwaveSubaccount(
  data: FlwSubaccountData,
): Promise<FlwSubaccountResult> {
  const response = await axios.post<{
    status: string;
    message: string;
    data: FlwSubaccountResult;
  }>(
    `${FLW_MGMT_URL}/subaccounts`,
    {
      account_number: data.account_number,
      account_bank: data.account_bank,
      business_name: data.business_name,
      country: data.country,
      business_email: data.business_email ?? "",
      business_description: data.business_description ?? "",
      mobile_number: data.mobile_number ?? "",
      split_type: data.split_type ?? "flat",
      split_value: data.split_value ?? 0,
    },
    {
      headers: {
        Authorization: getMgmtAuthHeader(),
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    },
  );

  if (response.data.status !== "success") {
    throw new Error(
      `Flutterwave subaccount creation failed: ${response.data.message}`,
    );
  }

  return response.data.data;
}

/**
 * Update an existing Flutterwave subaccount.
 * @param subaccountId — the RS_xxxx subaccount_id stored as flw_subaccount_id
 */
export async function updateFlutterwaveSubaccount(
  subaccountId: string,
  data: Partial<FlwSubaccountData>,
): Promise<boolean> {
  const response = await axios.put<{ status: string; message: string }>(
    `${FLW_MGMT_URL}/subaccounts/${subaccountId}`,
    data,
    {
      headers: {
        Authorization: getMgmtAuthHeader(),
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    },
  );

  if (response.data.status !== "success") {
    throw new Error(
      `Flutterwave subaccount update failed: ${response.data.message}`,
    );
  }

  return true;
}

export interface FlwBank {
  id: number;
  code: string;
  name: string;
}

/**
 * Fetch the list of supported banks for a given country.
 * @param country — ISO code, e.g. "NG", "GH", "KE", "ZA", "TZ", "UG"
 */
export async function getFlutterwaveBanks(country: string): Promise<FlwBank[]> {
  const response = await axios.get<{
    status: string;
    data: FlwBank[];
  }>(`${FLW_MGMT_URL}/banks/${country.toUpperCase()}`, {
    headers: { Authorization: getMgmtAuthHeader() },
    timeout: 10_000,
  });

  if (response.data.status !== "success") {
    throw new Error(`Failed to fetch Flutterwave banks for ${country}`);
  }

  return response.data.data;
}
