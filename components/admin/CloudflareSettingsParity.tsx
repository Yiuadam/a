"use client";

import { useEffect, useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import type { AppSettingsParityReport } from "@/lib/cloudflare/app-settings-parity";

export default function CloudflareSettingsParity() {
  const [report, setReport] = useState<AppSettingsParityReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function fetchReport(method: "GET" | "POST" = "GET") {
    const response = await authedFetch(apiUrl("/api/admin/cloudflare/app-settings"), {
      method,
    });
    if (!response.ok) throw new Error("parity unavailable");
    return await response.json() as AppSettingsParityReport;
  }

  useEffect(() => {
    let live = true;
    void fetchReport().then((next) => {
      if (live) setReport(next);
    }).catch(() => {
      if (live) setFailed(true);
    });
    return () => { live = false; };
  }, []);

  const repair = async () => {
    setBusy(true);
    setFailed(false);
    try {
      setReport(await fetchReport("POST"));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card rounded-2xl border border-slate-200 bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Cloudflare app-settings parity</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            Exact JSON, source clock and actor comparison for the running-site settings.
            This does not claim that learner, billing or metering migration is complete.
          </p>
        </div>
        {report?.mode === "dual" && !report.readyForAppSettingsCutover && (
          <button type="button" className="btn-secondary min-h-9 !px-3 text-xs" disabled={busy} onClick={repair}>
            {busy ? <LoadingIndicator label="Reconciling…" announce={false} /> : "Reconcile copy"}
          </button>
        )}
      </div>

      {!report && !failed && <p className="mt-3 text-xs text-slate-500"><LoadingIndicator label="Checking parity…" /></p>}
      {failed && <p role="alert" className="mt-3 text-xs text-rose-700">Parity could not be checked.</p>}
      {report && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {report.items.map((item) => (
            <div key={item.key} className="rounded-xl border border-slate-200/80 px-3 py-2.5 text-xs">
              <strong className="block text-slate-800">{item.key.replaceAll("_", " ")}</strong>
              <span className={item.status === "equal" || item.status === "absent" ? "text-emerald-700" : "text-amber-700"}>
                {item.status === "equal" ? "Synchronised" : item.status === "absent" ? "Not set on either system" : item.status.replaceAll("_", " ")}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
