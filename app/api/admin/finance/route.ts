import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { logInternal } from "@/lib/auth/errors";
import { accountRuntimeEnabled } from "@/lib/auth/runtime";
import { getSessionUser } from "@/lib/auth/session";
import {
  AnthropicCostError,
  anthropicCostConfigured,
  anthropicCostSnapshot,
} from "@/lib/admin/anthropic-cost";
import { FinanceFxError, hkmaFxSnapshot } from "@/lib/admin/finance-fx";
import {
  LocalAiCostError,
  localAiCostSnapshot,
} from "@/lib/admin/finance-local-cost";
import { estimatedHkdFinance, financeContribution } from "@/lib/admin/finance";
import { FINANCE_LIFETIME_START, financePeriod } from "@/lib/admin/finance-period";
import type {
  AdminFinanceResponse,
  ContributionAvailability,
  FinanceAvailabilityCode,
  FinanceProviderAvailability,
} from "@/lib/admin/finance-types";
import { stripeSecretKey } from "@/lib/billing/env";
import { financialSnapshot } from "@/lib/billing/stripe";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

interface ProviderLoad<T> {
  data: T | null;
  availability: FinanceProviderAvailability;
}

type FinanceSource = NonNullable<FinanceProviderAvailability["source"]>;

function available<T>(
  data: T,
  source: FinanceSource,
  configured = true,
): ProviderLoad<T> {
  return { data, availability: { configured, available: true, source, reason: null } };
}

function unavailable(
  configured: boolean,
  code: FinanceAvailabilityCode,
  message: string,
): ProviderLoad<never> {
  return {
    data: null,
    availability: { configured, available: false, source: null, reason: { code, message } },
  };
}

async function loadStripe<T>(run: () => Promise<T>): Promise<ProviderLoad<T>> {
  try {
    return available(await run(), "stripe_balance");
  } catch (error) {
    logInternal("admin/finance:stripe", error);
    return unavailable(
      true,
      "provider_unavailable",
      "Stripe financial data could not be loaded just now.",
    );
  }
}

function anthropicFailure(error: unknown): ProviderLoad<never> {
  const code = error instanceof AnthropicCostError ? error.code : "provider_unavailable";
  const message =
    code === "authentication_failed"
      ? "Anthropic rejected the Admin API key. Verify or replace it."
      : code === "permission_denied"
        ? "The Anthropic Admin key cannot read Cost Reports. Check its permissions."
        : code === "workspace_rejected"
          ? "Anthropic rejected the configured workspace filter. Verify the workspace ID."
          : code === "invalid_response"
            ? "Anthropic returned cost data the dashboard could not safely read."
            : code === "request_rejected"
              ? "Anthropic rejected the Cost Report request."
              : "Anthropic Cost Reports could not be loaded just now.";
  return unavailable(true, code, message);
}

async function loadAnthropic<T>(run: () => Promise<T>): Promise<ProviderLoad<T>> {
  try {
    return available(await run(), "anthropic_cost_api");
  } catch (error) {
    logInternal("admin/finance:anthropic", error);
    return anthropicFailure(error);
  }
}

async function loadLocalAiCost<T>(run: () => Promise<T>): Promise<ProviderLoad<T>> {
  try {
    return available(await run(), "local_cost_ledger");
  } catch (error) {
    logInternal("admin/finance:local-ai-cost", error);
    const code = error instanceof LocalAiCostError ? error.code : "provider_unavailable";
    return unavailable(
      true,
      code,
      code === "invalid_response"
        ? "The local AI-cost ledger returned data the dashboard could not safely read."
        : "The local AI-cost ledger could not be loaded just now.",
    );
  }
}

async function loadPreferredAiCost(
  period: ReturnType<typeof financePeriod>,
  lifetimeStartingAt: string,
  providerConfigured: boolean,
) {
  if (!providerConfigured) {
    return loadLocalAiCost(() => localAiCostSnapshot(period));
  }

  const provider = await loadAnthropic(() =>
    anthropicCostSnapshot(period, lifetimeStartingAt),
  );
  if (provider.availability.available) return provider;

  /* Individual Anthropic organisations cannot use the Admin Cost API. A
     configured-but-ineligible key must not hide BandUp's own actual-token
     ledger. The provider failure remains in the server log. */
  const local = await loadLocalAiCost(() => localAiCostSnapshot(period));
  return local.availability.available ? local : provider;
}

async function loadFx<T>(run: () => Promise<T>): Promise<ProviderLoad<T>> {
  try {
    return available(await run(), "hkma");
  } catch (error) {
    logInternal("admin/finance:fx", error);
    const code = error instanceof FinanceFxError ? error.code : "provider_unavailable";
    return unavailable(
      true,
      code,
      code === "stale_data"
        ? "The latest HKMA exchange rate is too old to use for an estimate."
        : code === "invalid_response"
          ? "HKMA returned exchange-rate data the dashboard could not safely read."
          : "HKMA exchange-rate data could not be loaded just now.",
    );
  }
}

function contributionAvailability(args: {
  exact: AdminFinanceResponse["contribution"];
  estimate: AdminFinanceResponse["hkdEstimate"];
  stripe: ProviderLoad<unknown>;
  anthropic: ProviderLoad<unknown>;
  fx: ProviderLoad<unknown>;
  hasReceipts: boolean;
}): ContributionAvailability {
  if (args.exact) return { available: true, basis: "exact", reason: null };
  if (args.estimate) return { available: true, basis: "estimated", reason: null };
  if (!args.stripe.availability.available) {
    return {
      available: false,
      basis: null,
      reason: {
        code: "stripe_unavailable",
        message: args.stripe.availability.reason?.message ?? "Stripe data is unavailable.",
      },
    };
  }
  if (!args.hasReceipts) {
    return {
      available: false,
      basis: null,
      reason: { code: "no_receipts", message: "No Stripe receipt currency is available yet." },
    };
  }
  if (!args.anthropic.availability.available) {
    return {
      available: false,
      basis: null,
      reason: {
        code: "anthropic_unavailable",
        message: args.anthropic.availability.reason?.message ?? "Anthropic cost data is unavailable.",
      },
    };
  }
  if (!args.fx.availability.available) {
    return {
      available: false,
      basis: null,
      reason: {
        code: "fx_unavailable",
        message: args.fx.availability.reason?.message ?? "Exchange-rate data is unavailable.",
      },
    };
  }
  return {
    available: false,
    basis: null,
    reason: {
      code: "unsupported_currency",
      message: "HKMA has no current rate for one of the provider currencies.",
    },
  };
}

async function handleGET(req: Request) {
  /* The same indistinguishable 404 gate as every other owner-only endpoint. */
  if (!accountsEnabled() || !accountRuntimeEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = await getSessionUser(req).catch(() => null);
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const period = financePeriod();
  const stripeConfigured = Boolean(stripeSecretKey());
  const anthropicConfigured = anthropicCostConfigured();

  /* Independent sources: one failed provider must not erase the others. */
  const [stripeResult, anthropicResult, fxResult] = await Promise.all([
    stripeConfigured
      ? loadStripe(() => financialSnapshot(period, FINANCE_LIFETIME_START))
      : Promise.resolve(
          unavailable(
            false,
            "not_configured",
            "Add the Stripe secret key to show financial receipts.",
          ),
        ),
    loadPreferredAiCost(period, FINANCE_LIFETIME_START, anthropicConfigured),
    loadFx(() => hkmaFxSnapshot()),
  ]);

  const stripe = stripeResult.data;
  const anthropic = anthropicResult.data;
  const fx = fxResult.data;
  const contribution = financeContribution(stripe, anthropic);
  const hkdEstimate = estimatedHkdFinance(stripe, anthropic, fx);
  const contributionStatus = contributionAvailability({
    exact: contribution,
    estimate: hkdEstimate,
    stripe: stripeResult,
    anthropic: anthropicResult,
    fx: fxResult,
    hasReceipts: (stripe?.currencies.length ?? 0) > 0,
  });

  const body: AdminFinanceResponse = {
    period,
    lifetimeStartingAt: FINANCE_LIFETIME_START,
    stripeConfigured,
    anthropicConfigured,
    providers: {
      stripe: stripeResult.availability,
      anthropic: anthropicResult.availability,
      fx: fxResult.availability,
    },
    stripe,
    anthropic,
    contribution,
    hkdEstimate,
    contributionStatus,
  };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
