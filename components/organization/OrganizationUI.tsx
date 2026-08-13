"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function GlassSection({
  title,
  lead,
  action,
  children,
  className = "",
  headerClassName = "",
}: {
  title: string;
  lead?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
}) {
  return (
    <section className={`card min-w-0 max-w-full !rounded-[var(--radius-xl)] !p-3.5 sm:!p-4 ${className}`}>
      <div className={`flex flex-wrap items-start justify-between gap-2.5 ${headerClassName}`}>
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold tracking-tight text-slate-900 sm:text-[19px]">
            {title}
          </h2>
          {lead && <p className="mt-0.5 text-[12px] leading-4 text-slate-600 sm:text-[13px]">{lead}</p>}
        </div>
        {action}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export function StatusPill({
  children,
  tone = "plain",
}: {
  children: ReactNode;
  tone?: "plain" | "good" | "warn" | "bad";
}) {
  const colors = {
    plain: "bg-slate-200/60 text-slate-700",
    good: "bg-emerald-100/70 text-emerald-800",
    warn: "bg-amber-100/70 text-amber-800",
    bad: "bg-rose-100/70 text-rose-800",
  };
  return (
    <span
      data-tone={tone}
      className={`organization-status-pill inline-flex rounded-full border border-transparent px-2.5 py-1 text-[11px] font-semibold ${colors[tone]}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/20 px-3.5 py-3 text-sm leading-5 text-slate-600">
      {children}
    </div>
  );
}

export function Person({
  name,
  email,
  avatarUrl,
}: {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}) {
  const label = name?.trim() || email?.trim() || "BandUp member";
  return (
    <div className="flex min-w-0 items-center gap-3">
      {avatarUrl ? (
        // User-supplied signed URLs are not guaranteed to match next/image's
        // configured hosts. The tiny fixed canvas prevents a large source
        // image from changing layout while it decodes.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt=""
          width={38}
          height={38}
          loading="lazy"
          className="h-9.5 w-9.5 shrink-0 rounded-[var(--radius-lg)] object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-9.5 w-9.5 shrink-0 place-items-center rounded-[var(--radius-lg)] bg-indigo-100/70 text-sm font-semibold text-indigo-700"
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-900">{label}</span>
        {name && email && <span className="block truncate text-xs text-slate-500">{email}</span>}
      </span>
    </div>
  );
}

export function StudentLink({
  id,
  children,
  className = "",
  previewRole = null,
}: {
  id: string;
  children: ReactNode;
  className?: string;
  previewRole?: "manager" | "teacher" | null;
}) {
  return (
    <Link
      href={`/organization/students/${encodeURIComponent(id)}${previewRole ? `?preview=${previewRole}` : ""}`}
      className={`card block min-w-0 max-w-full !rounded-[var(--radius-lg)] !px-3.5 !py-3 active:translate-y-px ${className}`}
    >
      {children}
    </Link>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "input min-h-11 w-full rounded-xl border border-slate-300 bg-surface/60 px-3.5 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-400";

export function formatDate(value: string | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  // Explicit locale + UTC keeps server HTML identical to the hydrated client.
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
