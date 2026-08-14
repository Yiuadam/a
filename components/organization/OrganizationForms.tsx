"use client";

import { useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import type { OrganizationDiscoveryResponse } from "@/lib/organizations/types";
import { organizationPreviewRequestHeaders, type OrganizationLivePreviewRole } from "@/lib/organizations/preview-client";
import { Field, GlassSection, inputClass } from "./OrganizationUI";
import type { OrganizationAction, OrganizationActionResponse } from "@/lib/organizations/types";

type Act = (action: OrganizationAction, payload: Record<string, unknown>) => Promise<OrganizationActionResponse | null>;

export function JoinOrganizationForm({
  act,
  busy,
  title = "Join an organisation",
  onRequested,
  previewRole = null,
}: {
  act: Act;
  busy: boolean;
  title?: string;
  onRequested?: () => void;
  previewRole?: OrganizationLivePreviewRole | null;
}) {
  const [code, setCode] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ organizationId: string; name: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  return (
    <GlassSection title={title} lead="Search for your school or learning organisation, then send a join request.">
      <form
        className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          const clean = query.trim();
          if (clean.length < 2) return;
          setSearching(true);
          setSearchError(null);
          try {
            const response = await authedFetch(apiUrl(`/api/organization/search?kind=organization&q=${encodeURIComponent(clean)}`), {
              cache: "no-store",
              headers: organizationPreviewRequestHeaders(previewRole),
            });
            if (!response.ok) throw new Error("Organisation search is unavailable just now.");
            const body = await response.json() as OrganizationDiscoveryResponse;
            setResults(body.kind === "organization" ? body.results : []);
            setSearched(true);
          } catch (error) {
            setResults([]);
            setSearched(false);
            setSearchError(error instanceof Error ? error.message : "Organisation search is unavailable just now.");
          } finally {
            setSearching(false);
          }
        }}
      >
        <Field label="Organisation name">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={inputClass}
            autoComplete="off"
            placeholder="Search by name"
            minLength={2}
            maxLength={80}
          />
        </Field>
        <button type="submit" className="btn-secondary min-h-11 !rounded-[var(--radius-lg)] !px-4" disabled={searching || query.trim().length < 2}>
          {searching ? <LoadingIndicator label="Searching…" announce={false} /> : "Search"}
        </button>
      </form>
      {searchError && <p role="alert" className="mt-2 text-xs text-rose-700">{searchError}</p>}
      {searched && (
        <div className="mt-2 space-y-2" aria-live="polite">
          {results.length === 0 ? (
            <p className="rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/25 px-3 py-2.5 text-sm text-slate-500">No active organisation matched that name.</p>
          ) : results.map((organization) => (
            <div key={organization.organizationId} className="flex min-w-0 items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/25 px-3 py-2.5">
              <strong className="min-w-0 truncate text-sm text-slate-900">{organization.name}</strong>
              <button
                type="button"
                className="btn-primary shrink-0 !min-h-9 !rounded-[var(--radius-lg)] !px-3 text-xs"
                disabled={busy}
                onClick={async () => {
                  if (await act("request_to_join", {
                    organizationId: organization.organizationId,
                    shareFutureHistoryConsent: true,
                  })) {
                    setResults([]);
                    setSearched(false);
                    onRequested?.();
                  }
                }}
              >
                Request to join
              </button>
            </div>
          ))}
        </div>
      )}
      <details className="mt-3 rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/15 px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold text-slate-600">Have an organisation code?</summary>
      <form
        className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!code.trim()) return;
          if (await act("request_to_join", {
            code: code.trim(),
            shareFutureHistoryConsent: true,
          })) {
            setCode("");
            onRequested?.();
          }
        }}
      >
        <Field label="Organisation code">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className={inputClass}
              autoComplete="off"
              placeholder="Enter code"
              maxLength={80}
              required
            />
        </Field>
          <button type="submit" className="btn-primary min-h-11 !rounded-[var(--radius-lg)] !px-4" disabled={busy || !code.trim()}>
            Use code
          </button>
      </form>
      </details>
    </GlassSection>
  );
}

export function OrganizationApplicationForm({ act, busy }: { act: Act; busy: boolean }) {
  const [form, setForm] = useState({
    organizationName: "",
    country: "",
    contactEmail: "",
    applicantRole: "",
  });
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  return (
    // This card sits beside JoinOrganizationForm in a two-up grid that the
    // parent now stretches to equal height, and h-full is what lets this
    // card take up that stretched cell instead of shrink-wrapping its own,
    // shorter content.
    <details
      className="card group min-w-0 max-w-full h-full !rounded-[var(--radius-xl)] !p-0"
      data-organization-application
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 sm:px-4 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold tracking-tight text-slate-900 sm:text-[17px]">
            Create an organisation
          </span>
          <span className="mt-0.5 block text-[12px] leading-4 text-slate-500">
            For people who run a school or teaching team.
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-indigo-700">
          <span>Apply</span>
          <span aria-hidden="true" className="text-base leading-none transition-transform group-open:rotate-90">›</span>
        </span>
      </summary>
      <div className="border-t border-slate-200/65 px-3.5 pb-3.5 pt-3 sm:px-4 sm:pb-4">
        <p className="mb-3 text-[12px] leading-4 text-slate-600 sm:text-[13px]">
          Send an application to BandUp. Nothing is created until a BandUp administrator approves it.
        </p>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (event) => {
            event.preventDefault();
            await act("submit_application", form);
          }}
        >
          <Field label="Organisation name">
            <input className={inputClass} required maxLength={120} value={form.organizationName} onChange={(e) => set("organizationName", e.target.value)} />
          </Field>
          <Field label="Country or region">
            <input className={inputClass} required maxLength={80} value={form.country} onChange={(e) => set("country", e.target.value)} />
          </Field>
          <Field label="Contact email">
            <input className={inputClass} required type="email" maxLength={254} value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} />
          </Field>
          <Field label="Your role">
            <input className={inputClass} required maxLength={80} placeholder="For example, school director" value={form.applicantRole} onChange={(e) => set("applicantRole", e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <button type="submit" className="btn-primary" disabled={busy}>
              Submit application
            </button>
          </div>
        </form>
      </div>
    </details>
  );
}
