"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ConsoleShell, { NotFound } from "@/components/admin/ConsoleShell";
import LoadingIndicator from "@/components/LoadingIndicator";
import { adminUserHref } from "@/lib/admin/user-links";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { useTier } from "@/lib/billing/useTier";

interface UserRow {
  id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  registered_at: string;
  plan: string;
  access_source: string;
  organization_seat_count: number;
  usage_30d: number;
  d1_mirror_missing?: boolean;
}

export default function AdminUsersPage() {
  const account = useTier();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "denied" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const response = await authedFetch(apiUrl(`/api/admin/users?q=${encodeURIComponent(appliedQuery)}&page=${page}`), { cache: "no-store" });
      if (response.status === 404) return setPhase("denied");
      if (!response.ok) throw new Error("unavailable");
      const body = (await response.json()) as { users: UserRow[]; total: number };
      setUsers(body.users);
      setTotal(body.total);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, [appliedQuery, page]);

  useEffect(() => { const frame = requestAnimationFrame(() => void load()); return () => cancelAnimationFrame(frame); }, [load]);
  if (phase === "denied") return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;

  return (
    <ConsoleShell title="Users" lead="Accounts, effective access, AI access attempts and synced score histories." back={{ href: "/admin", label: "Overview" }}>
      <form className="mb-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); setPhase("loading"); setPage(1); setAppliedQuery(query.trim()); }}>
        <label className="sr-only" htmlFor="admin-user-search">Search users</label>
        <input id="admin-user-search" className="input min-w-0 flex-1" placeholder="Search email, username or display name" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="btn-secondary">Search</button>
      </form>
      {phase === "loading" ? <p className="py-8 text-sm text-slate-500"><LoadingIndicator label="Loading users…" /></p> : phase === "error" ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">The user directory is unavailable right now.</p> : (
        <>
          <div className="grid gap-2 sm:hidden" aria-label="User accounts">
            {users.map((user) => (
              <article key={user.id} className="card min-w-0 rounded-2xl border border-slate-200 bg-surface p-3.5">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <strong className="block truncate text-sm text-slate-900">{user.display_name || "No display name"}</strong>
                    <span className="block truncate text-xs text-slate-500">{user.email}</span>
                    <span className="mt-1 block truncate text-xs text-indigo-700">{user.username ? `@${user.username}` : "Username not set"}</span>
                  </div>
                  <span className="rounded-full bg-indigo-100/70 px-2.5 py-1 text-[0.6875rem] font-semibold capitalize text-indigo-700">{effectiveAccess(user)}</span>
                </div>
                {user.d1_mirror_missing && <MirrorMissingNotice />}
                <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-200/70 pt-3 text-xs">
                  <div><dt className="text-slate-400">Registered</dt><dd className="mt-0.5 text-slate-700">{dateTime(user.registered_at)}</dd></div>
                  <div><dt className="text-slate-400">AI access attempts · 30d</dt><dd className="mt-0.5 font-semibold tabular-nums text-slate-900">{Number(user.usage_30d).toLocaleString()}</dd></div>
                </dl>
                <Link href={adminUserHref(user.id)} className="btn-secondary mt-3 flex min-h-9 w-full items-center justify-center !px-3 text-xs">Open history</Link>
              </article>
            ))}
          </div>
          <div className="card hidden overflow-x-auto rounded-2xl border border-slate-200 bg-surface sm:block">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-200 text-[0.6875rem] uppercase tracking-wide text-slate-400"><tr><th className="px-3 py-2.5">User</th><th className="px-3 py-2.5">Username</th><th className="px-3 py-2.5">Registered</th><th className="px-3 py-2.5">Effective access</th><th className="px-3 py-2.5">AI attempts · 30d</th><th className="px-3 py-2.5"><span className="sr-only">Open</span></th></tr></thead>
              <tbody>{users.map((user) => <tr key={user.id} className="border-b border-slate-200/70 last:border-b-0"><td className="px-3 py-3"><strong className="block text-slate-900">{user.display_name || "No display name"}</strong><span className="block text-xs text-slate-500">{user.email}</span></td><td className="px-3 py-3 text-slate-600">{user.username ? `@${user.username}` : "—"}</td><td className="px-3 py-3 text-slate-600">{dateTime(user.registered_at)}</td><td className="px-3 py-3 capitalize text-slate-600">{effectiveAccess(user)}{user.d1_mirror_missing && <span className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.625rem] normal-case font-semibold text-amber-800" title="Auth knows this account; it has no Cloudflare mirror row yet, so this plan may be stale.">Not mirrored</span>}</td><td className="px-3 py-3 tabular-nums text-slate-600">{Number(user.usage_30d).toLocaleString()}</td><td className="px-3 py-3"><Link href={adminUserHref(user.id)} className="btn-secondary min-h-9 !px-3 text-xs">History</Link></td></tr>)}</tbody>
            </table>
          </div>
          {users.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No users match that search.</p>}
          <div className="mt-3 flex items-center justify-between gap-3"><p className="text-xs text-slate-500">{total.toLocaleString()} account{total === 1 ? "" : "s"}</p><div className="flex gap-2"><button className="btn-secondary min-h-9 !px-3 text-xs" disabled={page === 1} onClick={() => { setPhase("loading"); setPage((value) => Math.max(1, value - 1)); }}>Previous</button><button className="btn-secondary min-h-9 !px-3 text-xs" disabled={page * 50 >= total} onClick={() => { setPhase("loading"); setPage((value) => value + 1); }}>Next</button></div></div>
        </>
      )}
    </ConsoleShell>
  );
}

/** See AdminUserRow.d1_mirror_missing in app/api/admin/users/route.ts. */
function MirrorMissingNotice() {
  return (
    <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[0.6875rem] text-amber-800">
      Not yet mirrored to Cloudflare — this plan may be stale.
    </p>
  );
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function effectiveAccess(user: UserRow): string {
  const personal = user.plan === "admin" ? "Admin" : `${user.plan.charAt(0).toUpperCase()}${user.plan.slice(1)} plan`;
  const seats = Number(user.organization_seat_count) || 0;
  return seats > 0 ? `${personal} · ${seats} organisation seat${seats === 1 ? "" : "s"}` : personal;
}
