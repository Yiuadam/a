import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { logInternal } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { anthropicCostConfigured, anthropicCostSnapshot } from "@/lib/admin/anthropic-cost";
import { financeContribution } from "@/lib/admin/finance";
import { FINANCE_LIFETIME_START, financePeriod } from "@/lib/admin/finance-period";
import type { AdminFinanceResponse } from "@/lib/admin/finance-types";
import { stripeSecretKey } from "@/lib/billing/env";
import { financialSnapshot } from "@/lib/billing/stripe";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function safe<T>(source: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    logInternal(`admin/finance:${source}`, error);
    return null;
  }
}

async function handleGET(req: Request) {
  /* The same indistinguishable 404 gate as every other owner-only endpoint. */
  if (!accountsEnabled() || !supabaseConfigured()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const user = await getSessionUser(req).catch(() => null);
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const period = financePeriod();
  const stripeConfigured = Boolean(stripeSecretKey());
  const anthropicConfigured = anthropicCostConfigured();

  /* Independent sources: a failed finance provider must not erase the other. */
  const [stripe, anthropic] = await Promise.all([
    stripeConfigured
      ? safe("stripe", () => financialSnapshot(period, FINANCE_LIFETIME_START))
      : Promise.resolve(null),
    anthropicConfigured
      ? safe("anthropic", () => anthropicCostSnapshot(period, FINANCE_LIFETIME_START))
      : Promise.resolve(null),
  ]);

  const body: AdminFinanceResponse = {
    period,
    lifetimeStartingAt: FINANCE_LIFETIME_START,
    stripeConfigured,
    anthropicConfigured,
    stripe,
    anthropic,
    contribution: financeContribution(stripe, anthropic),
  };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
