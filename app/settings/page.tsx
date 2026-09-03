"use client";

import Link from "next/link";
import CardIcon from "@/components/CardIcon";
import { Icon } from "@/components/Icons";
import { NAV_ICONS, RAIL_OVERFLOW, SKILL_ICONS } from "@/lib/nav";

/*
  Everything the rail does not carry.

  The rail was cut to what a learner opens on an ordinary evening — the four
  skills, where they stand, what to do next, the tutor. That was the right cut
  and it left nine destinations reachable only from the menu button, which is
  fine for a thing you look for and poor for a thing you did not know was there.
  This is the page that holds them, and Settings in the rail is the door to it.

  The list is derived, not written: RAIL_OVERFLOW is NAV_GROUPS minus the rail,
  so a destination added to the app appears here without anyone remembering to
  add it, and one promoted to the rail leaves here by the same arithmetic. A
  page of links that has to be maintained in parallel with the links is a page
  that is quietly wrong within two releases.
*/
export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="space-y-1">
        <h1 className="text-[1.375rem] font-semibold tracking-tight text-slate-900 sm:text-[1.625rem]">
          Settings
        </h1>
        <p className="text-[0.9375rem] leading-7 text-slate-600">
          Everything that is not in the sidebar: your plan and billing, the guides, and the rest
          of the app.
        </p>
      </div>

      <ul className="grid gap-2.5 sm:grid-cols-2">
        {RAIL_OVERFLOW.map((item) => {
          const skill = SKILL_ICONS[item.href];
          const icon = NAV_ICONS[item.href];
          return (
            <li key={item.href} className="min-w-0">
              <Link
                href={item.href}
                prefetch={false}
                className="card hub-menu-card flex min-h-[4.5rem] items-center gap-3 !px-4 !py-3.5 active:translate-y-px"
              >
                {skill ? (
                  <Icon name={skill} className="h-6 w-6 shrink-0 text-indigo-600" />
                ) : icon ? (
                  <CardIcon name={icon} size={26} />
                ) : null}
                <span className="min-w-0 flex-1 text-[0.9375rem] font-semibold text-slate-900">
                  {item.label}
                </span>
                <span aria-hidden="true" className="shrink-0 text-slate-300">
                  ›
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
