"use client";

import { useEffect, useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import type { CloudflareDomainDriftReport } from "@/lib/cloudflare/domain-drift";
import type { CloudflareMigrationReadinessReport } from "@/lib/cloudflare/migration-readiness";

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function age(seconds: number): string {
  if (seconds < 90) return `${seconds}s old`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m old`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)}h old`;
  return `${Math.round(seconds / 86400)}d old`;
}

export default function CloudflareMigrationReadiness() {
  const [report, setReport] = useState<CloudflareMigrationReadinessReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [drift, setDrift] = useState<CloudflareDomainDriftReport | null>(null);
  const [driftState, setDriftState] = useState<"idle" | "loading" | "failed">("idle");

  function nameDriftingRows() {
    setDriftState("loading");
    void authedFetch(apiUrl("/api/admin/cloudflare/readiness?drift=all"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("drift unavailable");
        const next = await response.json() as { rowDrift: CloudflareDomainDriftReport | null };
        if (!next.rowDrift) throw new Error("drift unavailable");
        setDrift(next.rowDrift);
        setDriftState("idle");
      })
      .catch(() => setDriftState("failed"));
  }

  useEffect(() => {
    let live = true;
    void authedFetch(apiUrl("/api/admin/cloudflare/readiness"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("readiness unavailable");
        const next = await response.json() as CloudflareMigrationReadinessReport;
        if (live) setReport(next);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  return (
    <section className="card rounded-2xl border border-slate-200 bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Cloudflare-only readiness</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            Exact source and target evidence. Supabase Auth is deliberately excluded and remains the sign-in authority.
          </p>
        </div>
        {report && (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${report.readyForCloudflareOnly ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-800"}`}>
            {report.readyForCloudflareOnly ? "Ready" : "Not ready"}
          </span>
        )}
      </div>

      {!report && !failed && <p className="mt-3 text-xs text-slate-500"><LoadingIndicator label="Comparing systems…" /></p>}
      {failed && <p role="alert" className="mt-3 text-xs text-rose-700">Migration readiness could not be checked.</p>}

      {report && (
        <>
          {report.sourceEvidence.status !== "available" && (
            <div className="mt-3 rounded-xl border border-amber-300/70 bg-amber-50/60 px-3 py-3 text-xs text-amber-900">
              <strong className="block">Supabase fingerprint evidence {report.sourceEvidence.status}</strong>
              <p className="mt-1 leading-5">
                {report.sourceEvidence.status === "unavailable"
                  ? "The restricted source-fingerprint RPC could not be read. Verify that Supabase migration 0029 is applied, its service-role grant is present, and PostgREST has reloaded before retrying."
                  : "The restricted source-fingerprint RPC returned incomplete or malformed evidence. The report stays fail-closed until it returns exactly one valid fingerprint for every domain."}
              </p>
            </div>
          )}
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {report.domains.map((domain) => (
              <div key={domain.domain} className="rounded-xl border border-slate-200/80 px-3 py-2.5 text-xs">
                <strong className="block text-slate-800">{label(domain.domain)}</strong>
                <span className={domain.ready ? "text-emerald-700" : "text-amber-700"}>{label(domain.status)}</span>
                {domain.sourceCount !== null && domain.targetCount !== null && (
                  <span className="mt-1 block tabular-nums text-slate-500">Supabase {domain.sourceCount.toLocaleString()} · Cloudflare {domain.targetCount.toLocaleString()}</span>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-xl border border-slate-200/80 px-3 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-slate-800">Which rows are drifting</strong>
              <button
                type="button"
                onClick={nameDriftingRows}
                disabled={driftState === "loading"}
                className="rounded-full border border-slate-300 px-3 py-1 font-semibold text-slate-700 disabled:opacity-60"
              >
                {driftState === "loading" ? "Comparing rows…" : "Name the drifting rows"}
              </button>
            </div>
            <p className="mt-1 leading-5 text-slate-500">
              Reads both databases row by row and reports keys only — never a stored value. Run it when a domain above is not equal.
            </p>
            {driftState === "failed" && (
              <p role="alert" className="mt-2 text-rose-700">Row comparison could not be run.</p>
            )}
            {drift && (
              <ul className="mt-2 space-y-2">
                {drift.domains.map((entry) => (
                  <li key={entry.domain} className="rounded-lg bg-slate-50 px-2.5 py-2">
                    <strong className="text-slate-800">{label(entry.domain)}</strong>{" "}
                    <span className={entry.status === "equal" ? "text-emerald-700" : "text-amber-700"}>{label(entry.status)}</span>
                    <span className="mt-1 block tabular-nums text-slate-500">
                      Missing from Cloudflare {entry.missingInTarget.total} · only in Cloudflare {entry.missingInSource.total} · differing {entry.fingerprintMismatch.total}
                      {entry.complete ? "" : ` · compared ${entry.comparedSourceRows} source and ${entry.comparedTargetRows} target rows only`}
                    </span>
                    {entry.missingInTarget.sample.length > 0 && (
                      <span className="mt-1 block break-all text-slate-500">Missing from Cloudflare: {entry.missingInTarget.sample.join(", ")}</span>
                    )}
                    {entry.missingInSource.sample.length > 0 && (
                      <span className="mt-1 block break-all text-slate-500">
                        Only in Cloudflare: {entry.missingInSource.sample.join(", ")}
                        {entry.deletionTombstones && ` (${entry.deletionTombstones.withTombstone} of ${entry.deletionTombstones.sampled} already have a deletion tombstone)`}
                      </span>
                    )}
                    {entry.fingerprintMismatch.sample.length > 0 && (
                      <span className="mt-1 block break-all text-slate-500">Differing rows: {entry.fingerprintMismatch.sample.join(", ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200/80 px-3 py-2.5 text-xs">
              <strong className="block text-slate-800">App settings</strong>
              <span className={report.appSettings?.readyForAppSettingsCutover ? "text-emerald-700" : "text-amber-700"}>
                {report.appSettings?.readyForAppSettingsCutover ? "Exact records match" : "Not proven equal"}
              </span>
              {report.appSettings && (
                <span className="mt-1 block text-slate-500">
                  {report.appSettings.items.map((item) => `${label(item.key)}: ${label(item.status)}`).join(" · ")}
                </span>
              )}
            </div>
            <div className="rounded-xl border border-slate-200/80 px-3 py-2.5 text-xs">
              <strong className="block text-slate-800">Replica queues</strong>
              <span className={report.outbox && report.outbox.pending + report.outbox.dead + report.outbox.cleanupPending + report.outbox.cleanupDead === 0 ? "text-emerald-700" : "text-amber-700"}>
                {report.outbox ? `${report.outbox.pending} pending · ${report.outbox.dead} dead · ${report.outbox.cleanupPending} cleanup pending · ${report.outbox.cleanupDead} cleanup dead` : "Unavailable"}
              </span>
              {report.outbox?.oldestPendingAt && (
                <span className="mt-1 block text-slate-500">Oldest pending {new Date(report.outbox.oldestPendingAt).toLocaleString()}</span>
              )}
            </div>
          </div>

          {report.outbox && (
            (report.outbox.failures?.length ?? 0) > 0
            || (report.outbox.cleanupFailures?.length ?? 0) > 0
            || (report.outbox.blockedByAccountDeletion ?? 0) > 0
          ) && (
            <div className="mt-3 rounded-xl border border-amber-300/70 bg-amber-50/60 px-3 py-3 text-xs text-amber-900">
              <strong className="block">Why the replica queues are stuck</strong>
              <ul className="mt-1 space-y-1 leading-5">
                {(report.outbox.failures ?? []).map((failure) => (
                  <li key={`task-${failure.status}-${failure.code}`}>
                    Outbox · {failure.count} {failure.status} · {label(failure.code)} · up to {failure.maxAttempts} attempts · {failure.detail.map(label).join(", ")}
                    {failure.oldestAgeSeconds !== null && ` · oldest ${age(failure.oldestAgeSeconds)}`}
                  </li>
                ))}
                {(report.outbox.cleanupFailures ?? []).map((failure) => (
                  <li key={`object-${failure.status}-${failure.code}`}>
                    Object cleanup · {failure.count} {failure.status} · {label(failure.code)} · up to {failure.maxAttempts} attempts · {failure.detail.join(", ")}
                    {failure.oldestAgeSeconds !== null && ` · oldest ${age(failure.oldestAgeSeconds)}`}
                  </li>
                ))}
                {(report.outbox.blockedByAccountDeletion ?? 0) > 0 && (
                  <li>
                    Outbox · {report.outbox.blockedByAccountDeletion} row(s) whose subject has an account-deletion tombstone. The deletion guard aborts every lease, so these never attempt, never record a reason and never die. Finish or clear that deletion.
                  </li>
                )}
              </ul>
            </div>
          )}

          {report.unsupportedDomains.length > 0 && (
            <div className="mt-3 rounded-xl border border-amber-300/70 bg-amber-50/60 px-3 py-3 text-xs text-amber-900">
              <strong className="block">Runtime paths still using Supabase</strong>
              <p className="mt-1 leading-5">{report.unsupportedDomains.map(label).join(" · ")}</p>
            </div>
          )}
          {report.blockers.length > 0 && (
            <div className="mt-3 rounded-xl border border-slate-200/80 px-3 py-3 text-xs text-slate-700">
              <strong className="block text-slate-800">Cutover blockers</strong>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {report.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-3 text-[11px] leading-4 text-slate-400">
            Learner mode {report.modes.learner}; organisation mode {report.modes.organization}. Evidence format {report.fingerprintVersion}. Checked {new Date(report.generatedAt).toLocaleString()}.
          </p>
        </>
      )}
    </section>
  );
}
