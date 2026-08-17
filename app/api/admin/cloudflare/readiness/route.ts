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
import {
  cloudflarePayloadParityReport,
  parsePayloadParityDomains,
  type CloudflarePayloadParityReport,
} from "@/lib/cloudflare/payload-parity";
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

  // `?payloadParity=` opens and hashes the JSON payload behind
  // progress_snapshots/subscriptions/provider_events, on both sides. It is
  // off by default and stricter than `?drift=`: an R2 read costs more than a
  // D1 row read, so this walks fewer rows per call by default (see
  // DEFAULT_PAYLOAD_PARITY_ROW_LIMIT in lib/cloudflare/payload-parity.ts).
  const wantedPayload = parsePayloadParityDomains(query.get("payloadParity"));
  const payloadRowLimit = Number(query.get("payloadParityRows"));
  const payloadSampleLimit = Number(query.get("payloadParitySample"));

  try {
    const report = await cloudflareMigrationReadinessReport();
    let rowDrift: CloudflareDomainDriftReport | null = null;
    let payloadParity: CloudflarePayloadParityReport | null = null;
    if (wanted || wantedPayload) {
      const bindings = await requireBandUpCloudflareBindings();
      if (wanted) {
        rowDrift = await cloudflareDomainDriftReport(bindings, wanted, {
          rowLimit: Number.isSafeInteger(rowLimit) && rowLimit > 0 ? rowLimit : undefined,
          sampleLimit: Number.isSafeInteger(sampleLimit) && sampleLimit > 0 ? sampleLimit : undefined,
        });
      }
      if (wantedPayload) {
        payloadParity = await cloudflarePayloadParityReport(bindings, wantedPayload, {
          rowLimit: Number.isSafeInteger(payloadRowLimit) && payloadRowLimit > 0 ? payloadRowLimit : undefined,
          sampleLimit: Number.isSafeInteger(payloadSampleLimit) && payloadSampleLimit > 0 ? payloadSampleLimit : undefined,
        });
      }
    }
    return NextResponse.json({ ...report, rowDrift, payloadParity }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    logInternal("admin/cloudflare/readiness", error);
    return safeJsonError("Cloudflare migration readiness is unavailable right now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
