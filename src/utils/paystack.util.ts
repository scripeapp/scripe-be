import axios from "axios";
import type { FeeBearer, SettlementSchedule } from "../types/payment";
import type { PaystackMetadata } from "../types/webhook";

/**
 * Paystack payment verification response
 */
interface PaystackVerificationResponse {
  status: boolean;
  message: string;
  data: {
    id: number;
    domain: string;
    status: string;
    reference: string;
    amount: number;
    message: string | null;
    gateway_response: string;
    paid_at: string;
    created_at: string;
    channel: string;
    currency: string;
    subaccount?:
      | string
      | {
          id?: number;
          subaccount_code?: string;
        }
      | null;
    ip_address: string;
    metadata: any;
    customer: {
      id: number;
      first_name: string;
      last_name: string;
      email: string;
      customer_code: string;
      phone: string | null;
      metadata: any;
      risk_action: string;
    };
    authorization?: {
      channel?: string;
      receiver_bank_account_number?: string;
      receiver_bank?: string;
      receiver_bank_account_name?: string;
    };
  };
}

/**
 * Fetch a Paystack transaction by reference WITHOUT requiring a success status.
 * Unlike {@link verifyPaystackPayment}, this returns the raw payload for any
 * status (failed, abandoned, success) so callers can inspect declined charges,
 * customer/card metadata, and gateway responses during fraud investigations.
 */
export async function fetchPaystackTransaction(
  reference: string,
): Promise<PaystackVerificationResponse["data"]> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  try {
    const response = await axios.get<PaystackVerificationResponse>(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        timeout: 10000,
      },
    );

    if (!response.data.status) {
      throw new Error(response.data.message || "Failed to fetch transaction");
    }

    return response.data.data;
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(
          `Paystack API error: ${error.response.data?.message || error.message}`,
        );
      } else if (error.request) {
        throw new Error("No response from Paystack API. Please try again.");
      }
    }
    throw error;
  }
}

/**
 * Verify a Paystack payment using the payment reference
 * @param reference - Paystack payment reference
 * @returns Payment verification data
 * @throws Error if payment verification fails
 */
export async function verifyPaystackPayment(
  reference: string,
): Promise<PaystackVerificationResponse["data"]> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  try {
    const response = await axios.get<PaystackVerificationResponse>(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        timeout: 10000, // 10 second timeout
      },
    );

    if (!response.data.status) {
      throw new Error(response.data.message || "Payment verification failed");
    }

    if (response.data.data.status !== "success") {
      throw new Error(
        `Payment not successful. Status: ${response.data.data.status}`,
      );
    }

    return response.data.data;
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(
          `Paystack API error: ${error.response.data?.message || error.message}`,
        );
      } else if (error.request) {
        throw new Error("No response from Paystack API. Please try again.");
      }
    }
    throw error;
  }
}

/**
 * Paystack transaction initialization response
 */
interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: {
    authorization_url: string;
    access_code: string;
    reference: string;
  };
}

/**
 * Initialize a Paystack transaction for store checkout
 * @param amount - Amount in naira
 * @param email - Customer email
 * @param reference - Unique payment reference
 * @param metadata - Additional metadata for the transaction
 * @param callback_url - URL to redirect after payment
 * @param subaccountCode - Optional Paystack subaccount code for split payment
 * @returns Paystack authorization URL and reference
 */
export async function initializePaystackPayment(
  amount: number,
  email: string,
  reference: string | undefined,
  metadata: PaystackMetadata,
  callback_url?: string,
  subaccountCode?: string,
  bearer: FeeBearer = "subaccount",
  transactionCharge?: number,
  planCode?: string,
): Promise<{ authorization_url: string; reference: string }> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  try {
    const payload: any = {
      amount: Math.round(amount * 100), // Convert to kobo
      email,
      callback_url,
      metadata,
      currency: "NGN",
    };

    // Add plan code if this is a recurring subscription
    if (planCode) {
      payload.plan = planCode;
    }

    // Only include reference if provided (otherwise Paystack generates one)
    if (reference) {
      payload.reference = reference;
    }

    // Add subaccount for split payment if provided
    if (subaccountCode) {
      payload.subaccount = subaccountCode;

      // Set fee bearer
      // "split" is handled at the application level (customer charged half the fees);
      // Paystack only accepts "account" or "subaccount", so we map to "subaccount".
      payload.bearer = bearer === "split" ? "subaccount" : bearer;

      // Set platform transaction charge if provided
      if (transactionCharge) {
        payload.transaction_charge = transactionCharge;
      }
    }

    const response = await axios.post<PaystackInitializeResponse>(
      "https://api.paystack.co/transaction/initialize",
      payload,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    if (!response.data.status) {
      throw new Error(response.data.message || "Failed to initialize payment");
    }

    return {
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    };
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(
          `Paystack API error: ${error.response.data?.message || error.message}`,
        );
      } else if (error.request) {
        throw new Error("No response from Paystack API. Please try again.");
      }
    }
    throw error;
  }
}

/**
 * Minutes a checkout virtual account stays valid before Paystack expires it.
 * Kept short so buyers pay promptly and stale accounts don't linger.
 */
export const BANK_TRANSFER_EXPIRY_MINUTES = 60;

/**
 * Dynamic virtual account details returned by a bank-transfer charge.
 * The account is unique to one transaction and expires at `expiresAt`.
 */
export interface VirtualAccountDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  expiresAt: string;
}

interface PaystackChargeResponse {
  status: boolean;
  message: string;
  data: {
    reference: string;
    status: string;
    account_name?: string;
    account_number?: string;
    account_expires_at?: string;
    bank?: { name?: string };
  };
}

/**
 * Issue a transaction-scoped virtual account for a NGN bank-transfer payment.
 *
 * Uses Paystack's Charge API (`/charge` with the `bank_transfer` channel), which
 * returns a temporary NUBAN tied to this charge and expiring after a window.
 * Split-payment fields mirror {@link initializePaystackPayment} so the merchant
 * subaccount receives the same amount and Hilaq the same platform fee, whether
 * the buyer pays by card or by transfer.
 *
 * Reconciliation is identical to card: Paystack fires `charge.success` (channel
 * `dedicated_nuban`) with this reference and metadata once the transfer lands.
 */
export async function initializePaystackBankTransfer(params: {
  amount: number; // naira
  email: string;
  metadata: PaystackMetadata;
  reference?: string;
  subaccountCode?: string;
  bearer?: FeeBearer;
  transactionCharge?: number; // kobo
}): Promise<{ reference: string; virtualAccount: VirtualAccountDetails }> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  const expiresAt = new Date(
    Date.now() + BANK_TRANSFER_EXPIRY_MINUTES * 60 * 1000,
  ).toISOString();

  const payload: Record<string, unknown> = {
    email: params.email,
    amount: Math.round(params.amount * 100),
    currency: "NGN",
    metadata: params.metadata,
    bank_transfer: { account_expires_at: expiresAt },
  };

  if (params.reference) payload.reference = params.reference;

  if (params.subaccountCode) {
    payload.subaccount = params.subaccountCode;
    payload.bearer = params.bearer === "split" ? "subaccount" : params.bearer;
    if (params.transactionCharge) {
      payload.transaction_charge = params.transactionCharge;
    }
  }

  try {
    const response = await axios.post<PaystackChargeResponse>(
      "https://api.paystack.co/charge",
      payload,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    const { status, message, data } = response.data;
    if (!status || !data?.account_number) {
      throw new Error(message || "Failed to create bank transfer account");
    }

    return {
      reference: data.reference,
      virtualAccount: {
        bankName: data.bank?.name ?? "Bank",
        accountName: data.account_name ?? "",
        accountNumber: data.account_number,
        expiresAt: data.account_expires_at ?? expiresAt,
      },
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(
          `Paystack charge error: ${error.response.data?.message || error.message}`,
        );
      }
      if (error.request) {
        throw new Error("No response from Paystack API. Please try again.");
      }
    }
    throw error;
  }
}

/**
 * Initialize a Paystack transaction for publication subscriptions
 * @param options - Payment options including amount in kobo, email, reference, metadata, subaccount, and fee configuration
 * @returns Paystack authorization URL and reference
 */
export async function initializeSubscriptionPayment(options: {
  amount: number; // Amount in kobo
  email: string;
  reference: string;
  metadata: {
    subscription_type: "publication";
    publication_id: string;
    publication_name: string;
    user_id: string;
    plan: "monthly" | "yearly";
    existing_subscription_id?: string;
  };
  callback_url?: string;
  subaccountCode?: string;
  transactionCharge?: number; // Platform fee in kobo
  bearer?: "subaccount" | "customer";
}): Promise<{ authorization_url: string; reference: string }> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  try {
    const payload: any = {
      amount: options.amount, // Already in kobo
      email: options.email,
      reference: options.reference,
      callback_url: options.callback_url,
      metadata: options.metadata,
      currency: "NGN",
    };

    // Add split payment configuration if subaccount provided
    if (options.subaccountCode) {
      payload.subaccount = options.subaccountCode;

      // Set fee bearer
      payload.bearer = options.bearer || "subaccount";

      // Set platform transaction charge if provided
      if (options.transactionCharge) {
        payload.transaction_charge = options.transactionCharge;
      }
    }

    const response = await axios.post<PaystackInitializeResponse>(
      "https://api.paystack.co/transaction/initialize",
      payload,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    if (!response.data.status) {
      throw new Error(
        response.data.message || "Failed to initialize subscription payment",
      );
    }

    return {
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    };
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(
          `Paystack API error: ${error.response.data?.message || error.message}`,
        );
      } else if (error.request) {
        throw new Error("No response from Paystack API. Please try again.");
      }
    }
    throw error;
  }
}

/**
 * Create a Paystack Plan
 * @param data - Plan data including name, amount in naira, and interval
 */
export async function createPaystackPlan(data: {
  name: string;
  amount: number;
  interval: "hourly" | "daily" | "weekly" | "monthly" | "quarterly" | "biannually" | "annually";
  description?: string;
  currency?: string;
}): Promise<{ plan_code: string; id: number }> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  try {
    const payload = {
      name: data.name,
      amount: Math.round(data.amount * 100), // Convert to kobo
      interval: data.interval,
      description: data.description,
      currency: data.currency || "NGN",
    };

    const response = await axios.post("https://api.paystack.co/plan", payload, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.data.status) {
      throw new Error(response.data.message || "Failed to create Paystack Plan");
    }

    return {
      plan_code: response.data.data.plan_code,
      id: response.data.data.id,
    };
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Paystack error: ${error.response.data.message}`);
    }
    throw error;
  }
}

/**
 * Update a Paystack Plan
 * @param planCode - The plan code to update
 * @param data - Updated plan data
 */
export async function updatePaystackPlan(
  planCode: string,
  data: {
    name?: string;
    amount?: number;
    description?: string;
  },
): Promise<boolean> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  try {
    const payload: any = {};
    if (data.name) payload.name = data.name;
    if (data.amount !== undefined) payload.amount = Math.round(data.amount * 100);
    if (data.description) payload.description = data.description;

    const response = await axios.put(`https://api.paystack.co/plan/${planCode}`, payload, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
    });

    return response.data.status;
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Paystack error: ${error.response.data.message}`);
    }
    throw error;
  }
}

/**
 * Paystack list transactions response
 */
interface PaystackListTransactionsResponse {
  status: boolean;
  message: string;
  data: Array<{
    id: number;
    domain: string;
    status: string;
    reference: string;
    amount: number;
    message: string | null;
    gateway_response: string;
    paid_at: string | null;
    created_at: string;
    channel: string;
    currency: string;
    ip_address: string;
    metadata: any;
    customer: {
      id: number;
      first_name: string | null;
      last_name: string | null;
      email: string;
      customer_code: string;
      phone: string | null;
    };
  }>;
  meta: {
    total: number;
    skipped: number;
    perPage: number;
    page: number;
    pageCount: number;
  };
}

/**
 * List transactions from Paystack
 * @param page - Page number (default: 1)
 * @param perPage - Results per page (default: 20, max: 100)
 * @param status - Filter by status: 'failed' | 'success' | 'abandoned'
 * @param from - Start date (ISO format)
 * @param to - End date (ISO format)
 */
export async function listPaystackTransactions(
  options: {
    page?: number;
    perPage?: number;
    status?: "failed" | "success" | "abandoned";
    from?: string;
    to?: string;
    subaccount?: string;
    customer?: string;
  } = {},
): Promise<{
  transactions: PaystackListTransactionsResponse["data"];
  meta: PaystackListTransactionsResponse["meta"];
}> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  try {
    const params = new URLSearchParams();
    if (options.page) params.append("page", String(options.page));
    if (options.perPage)
      params.append("perPage", String(Math.min(options.perPage, 100)));
    if (options.status) params.append("status", options.status);
    if (options.from) params.append("from", options.from);
    if (options.to) params.append("to", options.to);
    if (options.subaccount) params.append("subaccount", options.subaccount);
    if (options.customer) params.append("customer", options.customer);

    const response = await axios.get<PaystackListTransactionsResponse>(
      `https://api.paystack.co/transaction?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        timeout: 15000,
      },
    );

    if (!response.data.status) {
      throw new Error(response.data.message || "Failed to fetch transactions");
    }

    return {
      transactions: response.data.data,
      meta: response.data.meta,
    };
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(
          `Paystack API error: ${error.response.data?.message || error.message}`,
        );
      } else if (error.request) {
        throw new Error("No response from Paystack API. Please try again.");
      }
    }
    throw error;
  }
}

/**
 * Paystack list settlements response (payouts to bank account)
 */
interface PaystackListSettlementsResponse {
  status: boolean;
  message: string;
  data: Array<{
    id: number;
    integration: number;
    domain: string;
    subaccount: {
      id: number;
      subaccount_code: string;
      business_name: string;
      settlement_bank: string;
      account_number: string;
    } | null;
    settlement_date: string;
    settled_by: string | null;
    account_id: number | null;
    currency: string;
    status: string;
    total_amount: number;
    deductions: number | null;
    effective_amount: number;
    total_fees: number;
    total_processed: number;
    created_at: string;
  }>;
  meta: {
    total: number;
    skipped: number;
    perPage: number;
    page: number;
    pageCount: number;
  };
}

/**
 * List settlements (payouts) from Paystack
 * @param page - Page number (default: 1)
 * @param perPage - Results per page (default: 50)
 * @param status - Filter by status: 'pending' | 'success' | 'processing' | 'failed'
 * @param subaccount - Subaccount ID to filter, or 'none' for main account only
 * @param from - Start date (ISO format or YYYY-MM-DD)
 * @param to - End date (ISO format or YYYY-MM-DD)
 */
export async function listPaystackSettlements(
  options: {
    page?: number;
    perPage?: number;
    status?: "pending" | "success" | "processing" | "failed";
    subaccount?: string;
    from?: string;
    to?: string;
  } = {},
): Promise<{
  settlements: PaystackListSettlementsResponse["data"];
  meta: PaystackListSettlementsResponse["meta"];
}> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;

  if (!secretKey) {
    throw new Error("PAYSTACK_SECRET_KEY is not configured");
  }

  try {
    const params = new URLSearchParams();
    if (options.page) params.append("page", String(options.page));
    if (options.perPage) params.append("perPage", String(options.perPage));
    if (options.status) params.append("status", options.status);
    if (options.subaccount) params.append("subaccount", options.subaccount);
    if (options.from) params.append("from", options.from);
    if (options.to) params.append("to", options.to);

    const response = await axios.get<PaystackListSettlementsResponse>(
      `https://api.paystack.co/settlement?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
        timeout: 15000,
      },
    );

    if (!response.data.status) {
      throw new Error(response.data.message || "Failed to fetch settlements");
    }

    return {
      settlements: response.data.data,
      meta: response.data.meta,
    };
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(
          `Paystack API error: ${error.response.data?.message || error.message}`,
        );
      } else if (error.request) {
        throw new Error("No response from Paystack API. Please try again.");
      }
    }
    throw error;
  }
}

/**
 * Create a Paystack subaccount
 * @param data - Subaccount data
 */
export async function createPaystackSubaccount(data: {
  business_name: string;
  settlement_bank: string;
  account_number: string;
  percentage_charge: number;
  description?: string;
  primary_contact_email?: string;
  settlement_schedule?: SettlementSchedule;
}): Promise<{ subaccount_code: string; id: number }> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  try {
    const response = await axios.post(
      "https://api.paystack.co/subaccount",
      data,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.data.status) {
      throw new Error(response.data.message || "Failed to create subaccount");
    }

    return {
      subaccount_code: response.data.data.subaccount_code,
      id: response.data.data.id,
    };
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Paystack error: ${error.response.data.message}`);
    }
    throw error;
  }
}

/**
 * Update a Paystack subaccount
 * @param subaccountCode - The subaccount code to update
 * @param data - Updated subaccount data
 */
export async function updatePaystackSubaccount(
  subaccountCode: string,
  data: {
    business_name?: string;
    settlement_bank?: string;
    account_number?: string;
    percentage_charge?: number;
    description?: string;
    primary_contact_email?: string;
    active?: boolean;
    settlement_schedule?: SettlementSchedule;
  },
): Promise<boolean> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  try {
    const response = await axios.put(
      `https://api.paystack.co/subaccount/${subaccountCode}`,
      data,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.data.status;
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Paystack error: ${error.response.data.message}`);
    }
    throw error;
  }
}

/**
 * Fetch a Paystack subaccount
 * @param subaccountCode - The subaccount code
 */
export async function fetchPaystackSubaccount(
  subaccountCode: string,
): Promise<any> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  try {
    const response = await axios.get(
      `https://api.paystack.co/subaccount/${subaccountCode}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      },
    );

    if (!response.data.status) {
      throw new Error(response.data.message || "Failed to fetch subaccount");
    }

    return response.data.data;
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Paystack error: ${error.response.data.message}`);
    }
    throw error;
  }
}

/**
 * List banks supported by Paystack
 */
export async function listBanks(): Promise<
  Array<{ name: string; code: string }>
> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  const all: Array<{ name: string; code: string }> = [];
  let next: string | null = null;

  try {
    do {
      const params: Record<string, string> = { perPage: "100", country: "nigeria" };
      if (next) params.next = next;

      const response = await axios.get("https://api.paystack.co/bank", {
        headers: { Authorization: `Bearer ${secretKey}` },
        params,
      });

      if (!response.data.status) {
        throw new Error(response.data.message || "Failed to fetch banks");
      }

      all.push(...response.data.data);
      next = response.data.meta?.next ?? null;
    } while (next);

    return all;
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(`Paystack error: ${error.response.data.message}`);
    }
    throw error;
  }
}

const PAYSTACK_BASE_URL = "https://api.paystack.co";

interface PaystackApiResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

async function paystackRequest<T>(
  method: "get" | "post" | "delete",
  path: string,
  data?: Record<string, unknown>,
): Promise<T> {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) throw new Error("PAYSTACK_SECRET_KEY is not configured");

  try {
    const response = await axios.request<PaystackApiResponse<T>>({
      method,
      url: `${PAYSTACK_BASE_URL}${path}`,
      data,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    if (!response.data.status) {
      throw new Error(response.data.message || "Paystack request failed");
    }

    return response.data.data;
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        throw new Error(
          `Paystack API error: ${error.response.data?.message || error.message}`,
        );
      }
      if (error.request) {
        throw new Error("No response from Paystack API. Please try again.");
      }
    }
    throw error;
  }
}

export interface PaystackCustomer {
  id: number;
  customer_code: string;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

export interface PaystackDedicatedAccount {
  id?: number;
  account_name?: string;
  account_number?: string;
  bank?: { name?: string; slug?: string };
  customer?: PaystackCustomer;
  assignment?: { assignee_id?: number; status?: string; reference?: string };
}

export async function createPaystackCustomer(params: {
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  metadata?: Record<string, unknown>;
}): Promise<PaystackCustomer> {
  return paystackRequest<PaystackCustomer>("post", "/customer", params);
}

export async function validatePaystackCustomer(params: {
  customerCode: string;
  first_name: string;
  last_name: string;
  bvn: string;
  bank_code: string;
  account_number: string;
}): Promise<Record<string, unknown>> {
  return paystackRequest<Record<string, unknown>>(
    "post",
    `/customer/${params.customerCode}/identification`,
    {
      country: "NG",
      type: "bank_account",
      first_name: params.first_name,
      last_name: params.last_name,
      bvn: params.bvn,
      bank_code: params.bank_code,
      account_number: params.account_number,
    },
  );
}

/**
 * Resolve a Nigerian bank account number to its bank-registered account name.
 * Uses query params so this hits the GET /bank/resolve endpoint.
 */
export async function resolvePaystackBankAccount(params: {
  account_number: string;
  bank_code: string;
}): Promise<{ account_name: string; account_number: string }> {
  const query = new URLSearchParams({
    account_number: params.account_number,
    bank_code: params.bank_code,
  });
  return paystackRequest("get", `/bank/resolve?${query.toString()}`);
}

export async function createPaystackDedicatedAccount(params: {
  customer: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  preferred_bank?: string;
}): Promise<PaystackDedicatedAccount> {
  const payload: Record<string, unknown> = {
    customer: params.customer,
    email: params.email,
    first_name: params.first_name,
    last_name: params.last_name,
    phone: params.phone,
  };
  if (params.preferred_bank) payload.preferred_bank = params.preferred_bank;

  return paystackRequest<PaystackDedicatedAccount>(
    "post",
    "/dedicated_account",
    payload,
  );
}

export async function deactivatePaystackDedicatedAccount(
  dedicatedAccountId: string | number,
): Promise<Record<string, unknown>> {
  return paystackRequest<Record<string, unknown>>(
    "delete",
    `/dedicated_account/${dedicatedAccountId}`,
  );
}

export async function requeryPaystackDedicatedAccount(params: {
  account_number: string;
  provider_slug: string;
  date: string;
}): Promise<PaystackDedicatedAccount> {
  const query = new URLSearchParams({
    account_number: params.account_number,
    provider_slug: params.provider_slug,
    date: params.date,
  });

  return paystackRequest<PaystackDedicatedAccount>(
    "get",
    `/dedicated_account/requery?${query.toString()}`,
  );
}

export interface PaystackTransferRecipient {
  recipient_code: string;
  id?: number;
  name?: string;
}

export async function createPaystackTransferRecipient(params: {
  name: string;
  account_number: string;
  bank_code: string;
}): Promise<PaystackTransferRecipient> {
  return paystackRequest<PaystackTransferRecipient>(
    "post",
    "/transferrecipient",
    {
      type: "nuban",
      name: params.name,
      account_number: params.account_number,
      bank_code: params.bank_code,
      currency: "NGN",
    },
  );
}

export interface PaystackTransfer {
  transfer_code: string;
  reference: string;
  status: string;
}

export async function initiatePaystackTransfer(params: {
  amount: number;
  recipient: string;
  reference: string;
  reason?: string;
}): Promise<PaystackTransfer> {
  return paystackRequest<PaystackTransfer>("post", "/transfer", {
    source: "balance",
    amount: Math.round(params.amount * 100),
    recipient: params.recipient,
    reference: params.reference,
    reason: params.reason,
  });
}

export async function finalizePaystackTransfer(params: {
  transfer_code: string;
  otp: string;
}): Promise<PaystackTransfer> {
  return paystackRequest<PaystackTransfer>("post", "/transfer/finalize_transfer", {
    transfer_code: params.transfer_code,
    otp: params.otp,
  });
}

export async function getPaystackTransfer(
  transferCode: string,
): Promise<PaystackTransfer> {
  return paystackRequest<PaystackTransfer>("get", `/transfer/${transferCode}`);
}
