"use client";

import { useEffect, useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import type { CloudflareMigrationReadinessReport } from "@/lib/cloudflare/migration-readiness";

function label(value: string): string {
  return value.replaceAll("_", " ");
}

export default function CloudflareMigrationReadiness() {
  const [report, setReport] = useState<CloudflareMigrationReadinessReport | null>(null);
  const [failed, setFailed] = useState(false);

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
