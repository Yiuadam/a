import { NextResponse } from "next/server";
import { accountsEnabled, isAdminEmail } from "@/lib/auth/env";
import { logInternal, safeJsonError } from "@/lib/auth/errors";
import { getSessionUser } from "@/lib/auth/session";
import { supabaseConfigured } from "@/lib/auth/supabase";
import { requireBandUpCloudflareBindings } from "@/lib/cloudflare/bindings";
import {
  cloudflareDomainDriftReport,
  parseDriftDomains,
  type CloudflareDomainDriftReport,
} from "@/lib/cloudflare/domain-drift";
import { cloudflareMigrationReadinessReport } from "@/lib/cloudflare/migration-readiness";
import { withCors } from "@/lib/http/cors";

export const dynamic = "force-dynamic";

async function handleGET(req: Request) {
  if (!accountsEnabled() || !supabaseConfigured()) {
    return safeJsonError("Not found.", 404);
  }
  const actor = await getSessionUser(req).catch(() => null);
  if (!actor || !isAdminEmail(actor.email)) return safeJsonError("Not found.", 404);

  // `?drift=` names the rows behind a domain that is not equal. It is off by
  // default because it walks both databases row by row, which costs far more
  // than the one fingerprint per domain the report itself compares.
  const query = new URL(req.url).searchParams;
  const wanted = parseDriftDomains(query.get("drift"));
  const rowLimit = Number(query.get("driftRows"));
  const sampleLimit = Number(query.get("driftSample"));

  try {
    const report = await cloudflareMigrationReadinessReport();
    let rowDrift: CloudflareDomainDriftReport | null = null;
    if (wanted) {
      const bindings = await requireBandUpCloudflareBindings();
      rowDrift = await cloudflareDomainDriftReport(bindings, wanted, {
        rowLimit: Number.isSafeInteger(rowLimit) && rowLimit > 0 ? rowLimit : undefined,
        sampleLimit: Number.isSafeInteger(sampleLimit) && sampleLimit > 0 ? sampleLimit : undefined,
      });
    }
    return NextResponse.json({ ...report, rowDrift }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    logInternal("admin/cloudflare/readiness", error);
    return safeJsonError("Cloudflare migration readiness is unavailable right now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
