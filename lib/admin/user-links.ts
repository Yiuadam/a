import { IS_MOBILE_BUILD } from "@/lib/platform";

/*
  Two shapes for the same two console screens.

  The website's user history and sitting detail live at ordinary paths —
  `/admin/users/<id>` and its `/sittings/<key>` child — because an owner
  looking into an account may well want to keep the URL, and a path is what a
  URL takes when it means to be kept.

  The iOS bundle cannot have those routes at all. `output: export` needs a
  `generateStaticParams()` for every dynamic segment, and there is no fixed
  list of accounts to enumerate at build time — the console exists precisely to
  look at whoever has signed up since the last build. So the app ships two
  static shells with no dynamic segment in the route, `/admin/user` and
  `/admin/user/sitting`, and reads which account to show from the query string
  on the client.

  This is the same problem the organisation pages solved, and deliberately the
  same solution — see lib/organizations/student-links.ts. Every place that
  builds one of these URLs asks here for it, so the two forms cannot drift and
  a new call site cannot hard-code the path form into the app bundle.
*/

/** Where one account's history lives: a path on the website, a query on iOS. */
export function adminUserHref(userId: string): string {
  const id = encodeURIComponent(userId);
  return IS_MOBILE_BUILD ? `/admin/user?user=${id}` : `/admin/users/${id}`;
}

/** Where one saved sitting lives, under the account it belongs to. */
export function adminSittingHref(userId: string, sittingKey: string): string {
  const id = encodeURIComponent(userId);
  const key = encodeURIComponent(sittingKey);
  return IS_MOBILE_BUILD
    ? `/admin/user/sitting?user=${id}&sitting=${key}`
    : `/admin/users/${id}/sittings/${key}`;
}
