/*
  The shape /api/account/status actually returns.

  Kept in step with that route by hand — a mismatch here does not fail the
  build, it renders a confident wrong number, which is the failure this app can
  least afford. It lives in its own file now that the panel is split up, so
  that the component asking the server for it and the component drawing it are
  reading one description rather than each keeping a copy that can drift.
*/
export interface AccountStatus {
  enabled: boolean;
  /*
    Which sign-in buttons to draw. Comes from the server, which asks Supabase,
    so a provider that was never configured cannot get a button. Apple waits on
    an Apple Developer membership; until that exists the project reports Google
    alone and only Google is offered.
  */
  providers?: string[];
  signedIn?: boolean;
  tier?: string;
  unlimited?: boolean;
  usage?: {
    /** A rolling 30 days, in seconds. */
    windowSeconds: number;
    oldestAt: string | null;
    /** One entry per metered route, in a fixed order. */
    routes: {
      route: string;
      label: string;
      used: number;
      /** Null is no cap; zero is "not on this plan". */
      quota: number | null;
      remaining: number | null;
    }[];
  };
}

/** What /api/account/profile returns, and what a PATCH to it answers with. */
export interface ProfileFields {
  displayName: string | null;
  username: string | null;
  /** False only when the organization replica is known to need a retry. */
  organizationUsernameReady?: boolean | null;
  accountKind: import("@/lib/auth/account-identity").AccountKind | null;
  birthDate: string | null;
  avatarUrl: string | null;
  email: string | null;
}
