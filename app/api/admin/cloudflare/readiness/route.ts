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
  avatarObjectParityReport,
  parseAvatarObjectParityFlag,
  type AvatarObjectParityReport,
} from "@/lib/cloudflare/avatar-parity";
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

  // `?avatarObjectParity=` hashes real Supabase Storage and R2 objects and
  // counts profiles a read cutover would leave without a picture. Off by
  // default for the same reason `?drift=` is: it costs far more than the
  // report itself, which never reads avatar bytes at all.
  const wantsAvatarParity = parseAvatarObjectParityFlag(query.get("avatarObjectParity"));
  const avatarRowLimit = Number(query.get("avatarParityRows"));
  const avatarSampleLimit = Number(query.get("avatarParitySample"));
  const avatarByteLimit = Number(query.get("avatarParityBytes"));

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
    let avatarParity: AvatarObjectParityReport | null = null;
    if (wantsAvatarParity) {
      const bindings = await requireBandUpCloudflareBindings();
      avatarParity = await avatarObjectParityReport(bindings, {
        rowLimit: Number.isSafeInteger(avatarRowLimit) && avatarRowLimit > 0 ? avatarRowLimit : undefined,
        sampleLimit: Number.isSafeInteger(avatarSampleLimit) && avatarSampleLimit > 0 ? avatarSampleLimit : undefined,
        byteCheckLimit: Number.isSafeInteger(avatarByteLimit) && avatarByteLimit >= 0 ? avatarByteLimit : undefined,
      });
    }
    return NextResponse.json({ ...report, rowDrift, avatarParity }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    logInternal("admin/cloudflare/readiness", error);
    return safeJsonError("Cloudflare migration readiness is unavailable right now.", 503);
  }
}

export { OPTIONS } from "@/lib/http/cors";
export const GET = withCors(handleGET);
