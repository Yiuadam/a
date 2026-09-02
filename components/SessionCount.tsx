"use client";

import Link from "next/link";
import ExternalPlansLink from "@/components/billing/ExternalPlansLink";
import { useExternalPlansUrl } from "@/lib/billing/storefront";
import { IS_MOBILE_BUILD } from "@/lib/platform";
import type { SkillAccess } from "@/lib/entitlements/useSessions";

/*
  How many sittings are left in this skill this week.

  Three states, and the third is the one that earns the component.

    unlimited — nothing is drawn. A subscriber does not need to be told each
      week that they are not being counted; a counter reading "unlimited" is a
      limit reminding you it exists.

    some left — "2 left this week", quietly. Not a warning, not a colour, just
      the number, because most of the time it is not news.

    none left — the number becomes a link to the thing that fixes it: sign in
      for a visitor, the plans for a free account. A learner told "0 left"
      with nothing to press has been given a problem and no door.

  The word "left" rather than "remaining" and "this week" rather than "in the
  current period", because these are read in half a second by somebody deciding
  whether to start a test.
*/

export default function SessionCount({ access }: { access: SkillAccess }) {
  /* Above the early returns, because a hook has to run on every render of a
     component or React loses track of which hook is which. */
  const externalUrl = useExternalPlansUrl();

  /* Locked outright is the card's job, not the counter's — it would say the
     same thing twice, once in small grey text next to a padlock. */
  if (access.locked) return null;
  if (access.left === null) return null;

  if (access.left > 0) {
    return (
      <span className="shrink-0 text-xs tabular-nums text-slate-500">
        {access.left} left this week
      </span>
    );
  }

  /*
    /pricing is not in the iOS bundle, so the door out of "none left" is the
    website — on the storefronts where an app is allowed to point at one. Where
    it is not, the count still tells the truth and simply stops offering to fix
    it. See lib/billing/storefront.ts.
  */
  if (IS_MOBILE_BUILD) {
    if (!externalUrl) {
      return (
        <span className="shrink-0 text-xs font-medium text-slate-500">None left this week</span>
      );
    }
    return (
      <ExternalPlansLink
        url={externalUrl}
        className="shrink-0 text-xs font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-800"
      >
        None left — get more
      </ExternalPlansLink>
    );
  }

  return (
    <Link
      href="/pricing"
      className="shrink-0 text-xs font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-800"
    >
      None left — get more
    </Link>
  );
}
