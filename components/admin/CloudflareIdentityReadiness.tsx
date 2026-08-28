"use client";

import { useEffect, useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import type { NativeIdentityReadinessReport } from "@/lib/cloudflare/native-identity-audit";

interface BackfillResult {
  sourceGoogleIdentities: number;
  mappingsCreated: number;
  mappingsAlreadyCorrect: number;
}

function count(value: number): string {
  return value.toLocaleString();
}

/**
 * Aggregate-only owner view for the identity cutover. It never renders an
 * email address, account id, provider subject or password verifier; the only
 * mutable action is an explicitly confirmed, stable-id Google mapping copy.
 */
export default function CloudflareIdentityReadiness() {
  const [report, setReport] = useState<NativeIdentityReadinessReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "working" | "failed">("idle");
  const [result, setResult] = useState<BackfillResult | null>(null);

  async function load() {
    setFailed(false);
    try {
      const response = await authedFetch(apiUrl("/api/admin/cloudflare/identity-readiness"), {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("identity readiness unavailable");
      setReport(await response.json() as NativeIdentityReadinessReport);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    let live = true;
    void authedFetch(apiUrl("/api/admin/cloudflare/identity-readiness"), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("identity readiness unavailable");
        const next = await response.json() as NativeIdentityReadinessReport;
        if (live) setReport(next);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  async function copyMappings() {
    setCopyState("working");
    try {
      const response = await authedFetch(apiUrl("/api/admin/cloudflare/identity-backfill"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) throw new Error("identity backfill unavailable");
      setResult(await response.json() as BackfillResult);
      setConfirming(false);
      setCopyState("idle");
      await load();
    } catch {
      setCopyState("failed");
    }
  }

  const canCopy = report?.readyForBackfill === true && report.mappings.missing > 0;
  return (
    <section className="card rounded-2xl border border-slate-200 bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Cloudflare account identity</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
            Checks immutable Google subjects and existing D1 account ids before native sign-in. No
            identifiers, addresses or password material are shown here.
          </p>
        </div>
        {report && (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
            report.readyForNativeAuthCutover ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
          }`}>
            {report.readyForNativeAuthCutover ? "Native auth ready" : "Action required"}
          </span>
        )}
      </div>

      {!report && !failed && <p className="mt-3 text-xs text-slate-500"><LoadingIndicator label="Checking identity mappings…" /></p>}
      {failed && <p role="alert" className="mt-3 text-xs text-rose-700">Identity readiness could not be checked.</p>}

      {report && (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200/80 px-3 py-2.5 text-xs">
              <strong className="block text-slate-800">Source Google identities</strong>
              <span className="text-slate-600">{count(report.source.googleIdentities)} Google · {count(report.source.appleIdentities)} Apple · {count(report.source.emailIdentities)} email</span>
            </div>
            <div className="rounded-xl border border-slate-200/80 px-3 py-2.5 text-xs">
              <strong className="block text-slate-800">D1 account records</strong>
              <span className="text-slate-600">{count(report.accounts.liveD1UsersPresent)} matched · {count(report.accounts.liveD1UsersMissing)} missing</span>
            </div>
            <div className="rounded-xl border border-slate-200/80 px-3 py-2.5 text-xs">
              <strong className="block text-slate-800">Google mappings</strong>
              <span className="text-slate-600">{count(report.mappings.correct)} correct · {count(report.mappings.missing)} to copy · {count(report.mappings.mismatched)} conflicted</span>
            </div>
          </div>

          {report.blockers.length > 0 ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5 text-amber-800">
              {report.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-emerald-700">All current identity checks pass.</p>
          )}

          {result && (
            <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
              Copied {count(result.mappingsCreated)} audited mapping(s); {count(result.mappingsAlreadyCorrect)} already matched.
            </p>
          )}
          {copyState === "failed" && (
            <p role="alert" className="mt-3 text-xs text-rose-700">The mapping copy was not completed. No native sign-in setting was changed.</p>
          )}

          {canCopy && !confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="mt-4 rounded-full border border-indigo-300 px-3 py-1.5 text-xs font-semibold text-indigo-800"
            >
              Copy audited Google mappings
            </button>
          )}
          {canCopy && confirming && (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-xs text-amber-900">
              <p>This adds only the audited Google-subject → existing-D1-account links. It does not enable native sign-in.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copyMappings()}
                  disabled={copyState === "working"}
                  className="rounded-full bg-amber-700 px-3 py-1.5 font-semibold text-white disabled:opacity-60"
                >
                  {copyState === "working" ? "Copying…" : "Confirm copy"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={copyState === "working"}
                  className="rounded-full border border-amber-400 px-3 py-1.5 font-semibold disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
