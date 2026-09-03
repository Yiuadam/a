"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ConsoleShell, { NotFound } from "@/components/admin/ConsoleShell";
import LoadingIndicator from "@/components/LoadingIndicator";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { useTier } from "@/lib/billing/useTier";
import type { MockExamReport, ModuleResult, PlacementResult } from "@/lib/types";
import { adminSittingKey } from "@/lib/admin/sitting-key";
import { adminSittingHref } from "@/lib/admin/user-links";

interface OrganizationSeat {
  organizationId: string;
  organizationName: string;
  status: string;
  endsAt: string | null;
}

interface DrillScore { correct: number; total: number; at: string }

interface UserDetail {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  registeredAt: string;
  plan: string;
  accessSource: string;
  organizationSeats: OrganizationSeat[];
  placement: PlacementResult | null;
  mockReports: MockExamReport[];
  drillScores: Record<string, DrillScore>;
  usage: { route: string; admitted: number; refused: number }[];
  results: ModuleResult[];
  profileSyncedAt?: string | null;
  drillsSyncedAt?: string | null;
  progressAvailable?: boolean;
  d1MirrorMissing?: boolean;
}

/*
  One account's history, given its id.

  A component rather than a page, because there are two routes onto it: the
  website's `/admin/users/<id>`, which reads the id from the path, and the
  app's `/admin/user?user=<id>`, which reads it from the query. See
  lib/admin/user-links.ts for why the app cannot have the dynamic segment.
*/
export default function AdminUserHistoryPage({ userId: id }: { userId: string }) {
  const account = useTier();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "denied" | "error">("loading");
  useEffect(() => {
    let live = true;
    authedFetch(apiUrl(`/api/admin/users/${encodeURIComponent(id)}`), { cache: "no-store" }).then(async (response) => {
      if (response.status === 404) { if (live) setPhase("denied"); return; }
      if (!response.ok) throw new Error("unavailable");
      const body = (await response.json()) as UserDetail;
      if (live) { setUser(body); setPhase("ready"); }
    }).catch(() => { if (live) setPhase("error"); });
    return () => { live = false; };
  }, [id]);
  if (phase === "denied") return <NotFound mayNeedSignIn={account.phase === "ready" && !account.signedIn} />;
  return <ConsoleShell title={user?.displayName || "User history"} lead={user?.email ?? "Effective access and the latest synced progress copy."} back={{ href: "/admin/users", label: "Users" }}>
    {phase === "loading" ? <p className="text-sm text-slate-500"><LoadingIndicator label="Loading account history…" /></p> : phase === "error" || !user ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">This account history is unavailable right now.</p> : <UserHistory user={user} />}
  </ConsoleShell>;
}

function UserHistory({ user }: { user: UserDetail }) {
  const drillScores = Object.entries(user.drillScores ?? {})
    .filter((entry): entry is [string, DrillScore] => validDrillScore(entry[1]))
    .sort((left, right) => right[1].at.localeCompare(left[1].at));
  const personalAccess = user.plan === "admin" ? "Admin" : `${user.plan} plan`;
  const progressAvailable = user.progressAvailable !== false;
  return <div className="space-y-3">
    <section className="card grid gap-2 rounded-2xl border border-slate-200 bg-surface p-3 sm:grid-cols-3"><Fact label="Username" value={user.username ? `@${user.username}` : "Not set"} /><Fact label="Effective access" value={personalAccess} /><Fact label="Registered" value={new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(user.registeredAt))} /></section>
    {user.d1MirrorMissing && <section className="card rounded-2xl border border-amber-200 bg-amber-50 p-3"><h2 className="text-sm font-semibold text-amber-950">Not yet mirrored to Cloudflare</h2><p className="mt-1 text-sm text-amber-900">Auth knows this account, but it has no Cloudflare mirror row yet, so the plan shown above may be stale.</p></section>}
    {user.organizationSeats?.length > 0 && <section className="card rounded-2xl border border-slate-200 bg-surface p-3"><div className="flex items-end justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-900">Organisation access</h2><p className="text-xs text-slate-500">Seats permit organisation membership; they do not change personal AI access.</p></div><span className="text-xs text-slate-500">{user.organizationSeats.length} seat{user.organizationSeats.length === 1 ? "" : "s"}</span></div><div className="mt-2 grid gap-2 sm:grid-cols-2">{user.organizationSeats.map((seat) => <div key={`${seat.organizationId}-${seat.status}`} className="rounded-xl border border-slate-200/70 p-2.5"><p className="truncate text-sm font-medium text-slate-900">{seat.organizationName}</p><p className="mt-0.5 text-xs capitalize text-slate-500">{seat.status}{seat.endsAt ? ` · until ${new Date(seat.endsAt).toLocaleDateString()}` : ""}</p></div>)}</div></section>}
    <section className="card rounded-2xl border border-slate-200 bg-surface p-3"><h2 className="text-sm font-semibold text-slate-900">AI access attempts · last 30 days</h2><p className="mt-0.5 text-xs text-slate-500">These are access-gate decisions, not completed AI responses.</p>{user.plan === "admin" && <p className="mt-1 text-xs text-slate-500">Older administrator totals may include automated diagnostic access checks from earlier builds.</p>}{user.usage.length ? <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{user.usage.map((usage) => <div key={usage.route} className="rounded-xl border border-slate-200/70 p-2.5"><p className="text-xs font-medium text-slate-600">{usage.route}</p><p className="mt-1 text-sm text-slate-900"><strong>{Number(usage.admitted)}</strong> allowed · {Number(usage.refused)} blocked before AI</p></div>)}</div> : <p className="mt-2 text-sm text-slate-500">No metered AI access attempts in this period.</p>}</section>
    {!progressAvailable ? <section className="card rounded-2xl border border-amber-200 bg-amber-50 p-3"><h2 className="text-sm font-semibold text-amber-950">Synced progress is temporarily unavailable</h2><p className="mt-1 text-sm text-amber-900">The current progress store could not be reached, so this page is not showing an older database copy as if it were current.</p></section> : <>
      <section className="grid gap-2 sm:grid-cols-2"><div className="card rounded-2xl border border-slate-200 bg-surface p-3"><h2 className="text-sm font-semibold text-slate-900">Placement estimate</h2>{user.placement ? <><p className="mt-2 text-3xl font-semibold tabular-nums text-slate-900">{user.placement.band}</p><p className="text-xs text-slate-500">Latest estimate · {new Date(user.placement.date).toLocaleDateString()}</p><SyncTime value={user.profileSyncedAt} /></> : <><p className="mt-2 text-sm text-slate-500">No synced placement estimate.</p><SyncTime value={user.profileSyncedAt} /></>}</div><div className="card rounded-2xl border border-slate-200 bg-surface p-3"><div className="flex items-end justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-900">Drill progress</h2><p className="text-xs text-slate-500">Latest score for each topic.</p><SyncTime value={user.drillsSyncedAt} /></div><span className="text-xs text-slate-500">{drillScores.length} topic{drillScores.length === 1 ? "" : "s"}</span></div>{drillScores.length ? <div className="mt-2 flex max-h-40 flex-wrap gap-2 overflow-y-auto">{drillScores.map(([topic, score]) => <span key={topic} className="rounded-full border border-slate-200/70 px-2.5 py-1 text-xs text-slate-700"><strong>{topicLabel(topic)}</strong> · {score.correct}/{score.total}</span>)}</div> : <p className="mt-2 text-sm text-slate-500">No synced drill scores.</p>}</div></section>
      <section><div className="mb-2 flex items-end justify-between"><div><h2 className="text-sm font-semibold text-slate-900">Full mock sittings</h2><p className="text-xs text-slate-500">Saved full mock reports in the synced database copy.</p><SyncTime value={user.profileSyncedAt} /></div><span className="text-xs text-slate-500">{user.mockReports?.length ?? 0} sitting{user.mockReports?.length === 1 ? "" : "s"}</span></div>{user.mockReports?.length ? <div className="grid gap-2 sm:grid-cols-2">{user.mockReports.map((report) => <article key={report.id} className="card flex items-center justify-between gap-3 !rounded-[var(--radius-lg)] !p-3"><span className="min-w-0"><strong className="block truncate text-sm text-slate-900">Full mock exam</strong><span className="block text-xs text-slate-500">{new Date(report.completedAt).toLocaleDateString()} · {mockModuleSummary(report)}</span></span><span className="text-xl font-semibold tabular-nums text-slate-900">{report.marks.overall ?? "—"}</span></article>)}</div> : <p className="rounded-2xl border border-slate-200 bg-surface p-4 text-sm text-slate-500">No synced full mock sittings.</p>}</section>
      <section><div className="mb-2 flex items-end justify-between"><div><h2 className="text-sm font-semibold text-slate-900">Practice sitting history</h2><p className="text-xs text-slate-500">Saved practice sittings in the synced database copy.</p><SyncTime value={user.profileSyncedAt} /></div><span className="text-xs text-slate-500">{user.results.length} sitting{user.results.length === 1 ? "" : "s"}</span></div><div className="grid gap-2 sm:grid-cols-2">{user.results.map((result) => <Link key={`${result.module}-${result.testId}-${result.date}`} href={adminSittingHref(user.id, adminSittingKey(result))} className="card flex items-center justify-between gap-3 !rounded-[var(--radius-lg)] !p-3"><span className="min-w-0"><strong className="block truncate text-sm text-slate-900">{result.testTitle}</strong><span className="block text-xs capitalize text-slate-500">{new Date(result.date).toLocaleDateString()} · {result.module}</span></span><span className="text-xl font-semibold tabular-nums text-slate-900">{result.band}</span></Link>)}</div>{user.results.length === 0 && <p className="rounded-2xl border border-slate-200 bg-surface p-4 text-sm text-slate-500">No synced practice sittings.</p>}</section>
    </>}
  </div>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div><p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</p><p className="mt-0.5 truncate text-sm font-semibold capitalize text-slate-900">{value}</p></div>; }

function SyncTime({ value }: { value?: string | null }) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return <p className="mt-0.5 text-[11px] text-slate-400">Synced {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date)}</p>;
}

function validDrillScore(value: unknown): value is DrillScore {
  if (!value || typeof value !== "object") return false;
  const score = value as Partial<DrillScore>;
  return Number.isFinite(score.correct) && Number.isFinite(score.total) && Number(score.total) > 0 && typeof score.at === "string";
}

function topicLabel(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function mockModuleSummary(report: MockExamReport): string {
  const marks = report.marks;
  return [marks.listening?.band, marks.reading?.band, marks.writing?.band, marks.speaking?.band]
    .map((band) => band ?? "—")
    .join(" · ");
}
