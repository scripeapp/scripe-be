import { FlutterwaveProvider } from "./FlutterwaveProvider";
import { PaystackProvider } from "./PaystackProvider";
import type { PaymentProviderId } from "./fees";
import type { IPaymentProvider, SupportedCurrency } from "./types";

export class PaymentProviderFactory {
  static getProvider(currency: SupportedCurrency = "NGN"): IPaymentProvider {
    return PaymentProviderFactory.fromId(
      currency === "NGN" ? "paystack" : "flutterwave",
    );
  }

  static fromId(id: PaymentProviderId): IPaymentProvider {
    return id === "flutterwave"
      ? new FlutterwaveProvider()
      : new PaystackProvider();
  }

  /**
   * Route a stored reference to its provider by the "FLW-" namespace prefix.
   *
   * Invariant: callers must persist the reference RETURNED by
   * initializePayment (which FlutterwaveProvider normalizes under "FLW-").
   * Prefer deriving the provider from persisted payment_provider metadata
   * where a record exists — this probe is for references with no local
   * context yet (admin recovery of arbitrary refs).
   */
  static getProviderForReference(reference: string): IPaymentProvider {
    return reference.startsWith("FLW-")
      ? new FlutterwaveProvider()
      : new PaystackProvider();
  }
}
