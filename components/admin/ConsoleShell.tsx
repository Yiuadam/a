"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import RefractiveGlassLayer from "@/components/RefractiveGlassLayer";
import styles from "@/components/admin/AdminConsole.module.css";

/*
  The console's frame: a compact glass rail on a wide screen, a title window on
  a narrow one, and the page beside or below it. It uses one detailed refractive
  layer for the entire rail; individual cards use the cheaper shared backdrop
  glass so a data-heavy owner screen does not start dozens of SVG filters.

  Below `lg` the rail is gone and so is the room for it. The rail's job there is
  done by the compact back control in the title window.
*/

export default function ConsoleShell({
  title,
  lead,
  back,
  compact = false,
  children,
}: {
  title: string;
  lead?: string;
  /** Where the back control goes. Absent on the overview. */
  back?: { href: Route; label: string };
  /** Tighter wide-screen chrome for the glanceable all-in-one overview. */
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`${styles.root} flex min-h-[100dvh]`}>
      <aside
        className={`${styles.sidebar} premade-glass relative hidden w-60 shrink-0 overflow-hidden p-3 lg:flex`}
      >
        <RefractiveGlassLayer radius={32} interactive />
        <div className={styles.sidebarContent}>
          <Link href="/" prefetch={false} className={styles.brand}>
            <span className={styles.brandMark}>
              <Image
                src="/icons/final/steps-five-mark.svg"
                alt=""
                fill
                sizes="38px"
                className="object-cover"
                unoptimized
                priority
              />
            </span>
            <span>
              <strong className="block text-[15px] font-semibold tracking-tight">BandUp</strong>
              <span className="block text-[10px] font-medium uppercase tracking-[0.13em] text-slate-500">
                Owner console
              </span>
            </span>
          </Link>

          <p className={styles.eyebrow}>Workspace</p>
          <nav className={styles.navigation} aria-label="Owner console">
            {CONSOLE_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                className={`${styles.navItem} ${item.title === title ? styles.navActive : ""}`}
              >
                <span className={styles.navIcon}>
                  <ConsoleNavIcon href={item.href} />
                </span>
                {item.title}
              </Link>
            ))}
          </nav>

          <div className="mt-auto pt-3">
            <Link href="/" prefetch={false} className={styles.appLink}>
              Return to BandUp
            </Link>
          </div>
        </div>
      </aside>

      <div className={`${styles.page} min-w-0 flex-1 ${compact ? "lg:py-0" : ""}`}>
        <header className={`${styles.pageHeader} liquid-glass`}>
          <div className={`${styles.pageHeaderRow} flex min-w-0 flex-wrap items-center justify-between gap-2`}>
            <div className="flex min-w-0 items-center gap-2.5">
              {back && (
                <Link
                  href={back.href}
                  prefetch={false}
                  className={`${styles.mobileBack} shrink-0 lg:hidden`}
                >
                  <span className={styles.mobileBackIcon} aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only">{back.label}</span>
                </Link>
              )}
              <div className="min-w-0">
                <h1 className={styles.title}>{title}</h1>
                {lead && <p className={styles.lead}>{lead}</p>}
              </div>
            </div>
            {!back && (
              <Link href="/" prefetch={false} className={`${styles.mobileAppLink} lg:hidden`}>
                BandUp
              </Link>
            )}
          </div>
        </header>

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}

export const CONSOLE_NAV: { href: Route; title: string; detail: string }[] = [
  { href: "/admin", title: "Overview", detail: "The four numbers, at a glance" },
  { href: "/admin/traffic", title: "Signups and usage", detail: "Thirty days, as charts" },
  { href: "/admin/users", title: "Users", detail: "Accounts, plans, usage and score histories" },
  { href: "/admin/finance", title: "Money & AI cost", detail: "Payments, fees, money received and after AI" },
  { href: "/admin/site", title: "Site status", detail: "Open the site, or close it" },
  { href: "/admin/config", title: "Configuration", detail: "What is wired up, and what isn't" },
];

/*
  The same answer a stranger gets, for the same reason the API returns 404: a
  page that said "you are not an admin" would confirm there is an admin page to
  find.
*/
export function NotFound({ mayNeedSignIn }: { mayNeedSignIn: boolean }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-[22px] font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        {mayNeedSignIn ? "You may need to sign in." : "There's nothing at this address."}
      </p>
      <Link href="/" prefetch={false} className="btn-secondary mt-5 inline-block">
        Back to BandUp
      </Link>
    </div>
  );
}

/** One consistent line-icon family for the owner rail. */
function ConsoleNavIcon({ href }: { href: Route }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 19,
    height: 19,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (href === "/admin") {
    return <svg {...common}><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></svg>;
  }
  if (href === "/admin/traffic") {
    return <svg {...common}><path d="M4 18.5V13m5.3 5.5V9m5.4 9.5V5.5m5.3 13V3.5" /></svg>;
  }
  if (href === "/admin/users") {
    return <svg {...common}><path d="M16 20v-1.8a4.2 4.2 0 0 0-4.2-4.2H7.7a4.2 4.2 0 0 0-4.2 4.2V20" /><circle cx="9.7" cy="7.2" r="3.7" /><path d="M17 10.5a3.4 3.4 0 0 0 0-6.6m3.5 16.1v-1.8a4.2 4.2 0 0 0-3.1-4" /></svg>;
  }
  if (href === "/admin/finance") {
    return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M14.7 8.4c-.6-.5-1.4-.8-2.5-.8-1.5 0-2.6.8-2.6 2 0 3.2 5.3 1.5 5.3 4.7 0 1.1-1 2.1-2.8 2.1-1.2 0-2.2-.4-2.9-1M12 5.8v12.4" /></svg>;
  }
  if (href === "/admin/site") {
    return <svg {...common}><path d="M4 7.5h16M7 4v3.5m10-3.5v3.5M5.5 7.5v11A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-11" /><path d="m9.2 14 1.8 1.8 3.8-4" /></svg>;
  }
  return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>;
}
