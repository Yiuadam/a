"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { accountUsernameReady } from "@/lib/auth/account-identity";
import { routePath } from "@/lib/platform";
import { useAccountProfile } from "./AccountProfileProvider";

const ALWAYS_REACHABLE = [
  "/account/onboarding",
  "/account/callback",
  "/account/close",
  "/privacy",
  "/terms",
];

/** Required setup is a registration step, not a permission or paid-plan gate. */
export default function RequiredAccountGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { phase, profile } = useAccountProfile();
  /*
    The raw pathname is kept as well as the normalised route, and the two are
    used for different things on purpose. The list above is a list of route
    names, so it is asked against the route; `returnTo` below is somewhere the
    learner is about to be sent back to, and inside the iOS app the trailing
    slash is the form that actually resolves. Trimming a destination to make it
    look like the website's is how a redirect ends up nowhere. See routePath in
    lib/platform.ts.
  */
  const route = routePath(pathname);
  const allowed = ALWAYS_REACHABLE.some((path) => route === path || route.startsWith(`${path}/`));
  /*
    ---------------------------------------------------------------------------
    Why the app is no longer replaced by a spinner while the profile loads

    It used to be. `waiting` was `phase === "loading" && !allowed`, and it sat
    in the same condition as `blocked` below — so every signed-in page did
    this: the server sent the real page, the browser painted it, hydration
    found a session, the phase flipped to "loading", and this component threw
    the painted page away and rendered "Checking account setup…" until
    /api/account/profile answered.

    That request is not quick. It reads the user from Supabase Auth, reads the
    profile, and — in dual mode — awaits a fourteen-statement D1 mirror whose
    result its own answer never uses. From Hong Kong to Supabase and back,
    several times, while the learner watches a spinner sit on top of a page
    that had already arrived.

    So it cost every signed-in page load, and what it bought was avoiding one
    frame of the app for a learner who has no username yet and is about to be
    redirected. That is a brand-new account, once. The trade was the wrong way
    round.

    `blocked` still holds, and it is the real gate: it requires `phase ===
    "ready"`, so it fires on a settled answer rather than on the absence of
    one. Nothing here is enforcement in any case — this is a registration step
    and the server is what enforces it.
  */
  /*
    A username is required to continue. Its copy reaching D1 is not.

    The organisation-search readiness flag is false while that replica is
    behind, and it used to be part of the same condition — so a learner
    whose profile had saved perfectly was still held on the setup screen,
    with "Do this later" running through the same failing path and no way
    past it. A replica that is behind means a brand-new learner is briefly
    not findable by username inside an organisation. It should never have
    meant they could not have an account.

    The read in app/api/account/profile/route.ts now re-attempts the copy
    every time a profile loads, so this resolves itself rather than needing
    a person to be stuck until it does.
  */
  const usernameReady = accountUsernameReady(profile);
  const blocked = phase === "ready" && !usernameReady && !allowed;

  /*
    Send an unfinished account to onboarding once, and only once.

    This gate lives in the root layout, so it does not unmount as the learner
    moves between pages — which means a ref here survives every navigation for
    the life of the app load. That is deliberate: `usernameReady` can stay
    false after onboarding has genuinely been dealt with — a D1 mirror running
    behind, or "do this later" — and without this guard the gate would send
    /account (or /) to onboarding, onboarding's own router.refresh would bring
    the learner back, the gate would fire again, and the two would ping-pong as
    fast as the network allows. One learner sitting on that loop is tens of
    thousands of Worker requests an hour. So: redirect at most once; if the
    learner comes back still unfinished, let them be rather than trap them (the
    server is the real gate on anything that matters).
  */
  const redirected = useRef(false);
  useEffect(() => {
    if (!blocked || redirected.current) return;
    redirected.current = true;
    const returnTo = `${pathname}${window.location.search}`;
    router.replace(`/account/onboarding?returnTo=${encodeURIComponent(returnTo)}`);
  }, [blocked, pathname, router]);

  /*
    No spinner branch. It used to return one while `blocked`, but a ref cannot
    be read during render to tell "about to redirect" from "came back still
    unfinished", and the second must show the app rather than a spinner that
    never resolves. The redirect above is a soft navigation that happens on the
    next tick anyway, and this file already argues (above) against throwing an
    already-painted page away — so the children render, and a genuinely blocked
    new account is moved to onboarding a frame later.
  */
  return children;
}
