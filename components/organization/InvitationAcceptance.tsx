"use client";

import Link from "next/link";
import LoadingIndicator from "@/components/LoadingIndicator";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { authedFetch, getServerSnapshot, getSnapshot, subscribe } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";
import { GlassSection } from "./OrganizationUI";

function subscribeHash(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function hashToken(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
}

function serverToken(): string {
  return "";
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

export default function InvitationAcceptance({ requestId }: { requestId: string | null }) {
  const router = useRouter();
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const token = useSyncExternalStore(subscribeHash, hashToken, serverToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  // Username invitations are already bound to one authenticated account, so
  // their private notification needs only the opaque request id. Email links
  // still carry their strong secret in the fragment. A malformed non-empty
  // fragment is never downgraded into the account-bound flow.
  const valid = Boolean(
    requestId
    && /^[0-9a-f-]{36}$/i.test(requestId)
    && (token.length === 0 || token.length >= 24),
  );

  if (!valid) {
    return (
      <InvitationFrame>
        <GlassSection title="This invitation link is incomplete" lead="Ask the organisation manager to create and share a new invitation link.">
          <Link href="/organization" className="btn-secondary">Organisation</Link>
        </GlassSection>
      </InvitationFrame>
    );
  }

  if (!session) {
    return (
      <InvitationFrame>
        <GlassSection title="You’ve been invited" lead="Sign in with the same email address that received this invitation. BandUp will bring you back here automatically.">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              rememberAuthReturnPath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
              router.push("/account/");
            }}
          >
            Sign in to accept
          </button>
        </GlassSection>
      </InvitationFrame>
    );
  }

  return (
    <InvitationFrame>
      {error && <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50/75 px-4 py-3 text-sm text-rose-800">{error}</div>}
      <GlassSection title="Accept organisation invitation" lead={`This invitation will be attached to ${session.email ?? "your signed-in BandUp account"}.`}>
        <label className="mb-3 flex min-w-0 items-start gap-3 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/35 px-3.5 py-3 text-[0.8125rem] leading-5 text-slate-600">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-indigo-600"
          />
          <span className="min-w-0">If this invitation is for a student role, I agree to share future practice scores, saved feedback, essays and speaking transcripts while the membership is active. Earlier history needs separate consent.</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !consent}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const response = await authedFetch(apiUrl("/api/organization"), {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "accept_invitation",
                    payload: {
                      requestId,
                      ...(token ? { token } : {}),
                      shareFutureHistoryConsent: consent,
                    },
                    idempotencyKey: idempotencyKey(),
                  }),
                });
                const body = (await response.json().catch(() => null)) as { error?: string } | null;
                if (!response.ok) throw new Error(body?.error ?? "The invitation could not be accepted.");
                window.history.replaceState(null, "", window.location.pathname);
                router.replace("/organization");
                router.refresh();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "The invitation could not be accepted.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoadingIndicator label="Accepting…" announce={false} /> : "Accept invitation"}
          </button>
          <Link href="/organization" className="btn-secondary">Not now</Link>
        </div>
      </GlassSection>
    </InvitationFrame>
  );
}

function InvitationFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-xl space-y-3 px-4 py-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-700">BandUp for organisations</p>
        <h1 className="mt-1 text-[1.5rem] font-semibold tracking-tight text-slate-900">Invitation</h1>
      </div>
      {children}
    </div>
  );
}
