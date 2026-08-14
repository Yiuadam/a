import { IS_MOBILE_BUILD } from "@/lib/platform";

/*
  Two shapes for the same two screens.

  The website's student history and sitting review live at ordinary paths —
  `/organization/students/<id>` and its `/sittings/<attemptId>` child — because
  a teacher may want to bookmark or share a particular student's record, and a
  path is the form a URL takes when it means to be linked to.

  The iOS bundle cannot have those routes at all: `output: export` needs a
  `generateStaticParams()` for every dynamic segment, and there is no fixed
  list of students to enumerate at build time — the whole point is that any
  organisation's roster works without a rebuild. So the mobile build instead
  ships two static shells, `/organization/student` and
  `/organization/student/sitting`, with no dynamic segment in the route at
  all, and reads which student (and which sitting) to show from the query
  string on the client. See app/organization/student/page.tsx and
  app/organization/student/sitting/page.tsx.

  Every place that used to hand-build one of these URLs now asks these
  functions for it instead, so the two forms cannot drift apart and a new call
  site cannot accidentally hard-code the path form into the mobile bundle.
*/

interface StudentLinkOptions {
  /** The organisation the viewer is acting within, if the link needs one. */
  organizationId?: string | null;
  /**
   * The isolated-preview role to carry across the navigation (see
   * lib/organizations/preview-client.ts), or the literal "manager" used by
   * the localhost fixture preview. Left generic here because both are just
   * strings by the time they reach a query parameter.
   */
  previewRole?: string | null;
}

interface SittingLinkOptions extends StudentLinkOptions {
  /** Set when the link is reached from a completed-assignment notification. */
  focus?: string | null;
  /** Set when "back" should return to the assignment directory, not the student. */
  from?: string | null;
}

/** The decorations both link kinds share, in the order they're written to the query string. */
function decoratedQuery(opts?: SittingLinkOptions): string {
  const params = new URLSearchParams();
  if (opts?.organizationId) params.set("organization", opts.organizationId);
  if (opts?.from) params.set("from", opts.from);
  if (opts?.focus) params.set("focus", opts.focus);
  if (opts?.previewRole) params.set("preview", opts.previewRole);
  return params.toString();
}

/** Where a student's history lives: a path on the website, a query on iOS. */
export function studentHistoryHref(studentId: string, opts?: StudentLinkOptions): string {
  const query = decoratedQuery(opts);
  if (IS_MOBILE_BUILD) {
    return `/organization/student?student=${encodeURIComponent(studentId)}${query ? `&${query}` : ""}`;
  }
  return `/organization/students/${encodeURIComponent(studentId)}${query ? `?${query}` : ""}`;
}

/** Where one saved sitting lives: a path on the website, a query on iOS. */
export function sittingReviewHref(
  studentId: string,
  attemptId: string,
  opts?: SittingLinkOptions,
): string {
  const query = decoratedQuery(opts);
  if (IS_MOBILE_BUILD) {
    return `/organization/student/sitting?student=${encodeURIComponent(studentId)}`
      + `&attempt=${encodeURIComponent(attemptId)}${query ? `&${query}` : ""}`;
  }
  return `/organization/students/${encodeURIComponent(studentId)}/sittings/${encodeURIComponent(attemptId)}`
    + `${query ? `?${query}` : ""}`;
}

/**
 * Rewrite an already-built website path into the mobile query form, on the
 * mobile build only.
 *
 * lib/cloudflare/notifications.ts builds a student or sitting link itself,
 * server-side, from a notification row — it has no reason to import a
 * client-adjacent helper for what is ordinary URL construction, and it is
 * correct as it stands for the website, which is the only place a server
 * builds it. But the same notification feed is read inside the iOS bundle,
 * which has no `/organization/students/<id>` route to land on. Rather than
 * teach the notifications module about the platform it happens to be
 * rendered on, the client component that turns a notification into an `href`
 * passes the result through here first, so a website path becomes the query
 * form exactly where the mobile build needs it to and nowhere else.
 *
 * Identity outside the mobile build, and identity for any href that isn't one
 * of these two shapes — this only ever narrows an existing link, never
 * invents one.
 */
export function normaliseStudentHref(href: string): string {
  if (!IS_MOBILE_BUILD) return href;
  const match = /^\/organization\/students\/([^/?#]+)(?:\/sittings\/([^/?#]+))?(\?[^#]*)?$/.exec(href);
  if (!match) return href;
  const [, encodedStudentId, encodedAttemptId, search] = match;
  const params = new URLSearchParams(search ?? "");
  const mobileParams = new URLSearchParams();
  mobileParams.set("student", decodeURIComponent(encodedStudentId));
  if (encodedAttemptId) mobileParams.set("attempt", decodeURIComponent(encodedAttemptId));
  for (const [key, value] of params) mobileParams.set(key, value);
  const path = encodedAttemptId ? "/organization/student/sitting" : "/organization/student";
  return `${path}?${mobileParams.toString()}`;
}
