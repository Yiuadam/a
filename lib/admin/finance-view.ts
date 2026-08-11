import type { ExactMoney, StripeCurrencyFinance } from "@/lib/admin/finance-types";
import { addDecimal } from "@/lib/admin/finance-decimal";

/* Stripe initially records some asynchronous or separately-captured payments
   as `charge`, then offsets the amount in one of these two categories when the
   payment fails or part of the authorisation is never captured. Gross customer
   payments must include those offsets or it reports money never received. */
const GROSS_PAYMENT_CATEGORIES = new Set([
  "charge",
  "charge_failure",
  "partial_capture_reversal",
]);

export function grossCustomerPayments(
  stripe: StripeCurrencyFinance,
  range: "lifetime" | "period",
): ExactMoney {
  return {
    currency: stripe.currency,
    minorUnits: addDecimal(
      ...stripe.categories
        .filter((row) => GROSS_PAYMENT_CATEGORIES.has(row.category))
        .map((row) => row[range].amount.minorUnits),
    ),
  };
}
