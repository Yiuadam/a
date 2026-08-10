/*
  Whether the app is closed for maintenance.

  Read at build time, deliberately. The alternative — a runtime flag — sounds
  more convenient and is worse here for one reason: most of this app's pages are
  prerendered, so a runtime check in the layout would not run for them and the
  gate would cover some pages and not others. A half-closed site is worse than
  either state, because the pages that leaked through are exactly the ones
  somebody would then use.

  Baked in at build, every page carries the gate or none of them does. Turning
  it off is a deploy, which is the same act as turning it on, and on this
  project a deploy is already how anything reaches production.

  ---------------------------------------------------------------------------
  Why NEXT_PUBLIC_, for a value nothing in the browser reads

  Because it is the only prefix Next *substitutes into the code* at build time.
  Everything else is an ordinary runtime lookup, and this app's pages are
  re-rendered on each request by the Cloudflare Worker — where no build
  variable exists. So `process.env.MAINTENANCE_MODE` compiled to a lookup that
  returned undefined on every request in production, the flag read false, and
  the site served the app while every check said it was closed.

  It survived three deploys and two rounds of my own verification, because
  every check I ran tested the wrong pipeline: the prerendered HTML did contain
  the notice, and `next start` serves that HTML. Only the Worker re-renders,
  and only `wrangler dev` against a real `cf:build` shows it. That is now the
  test — see tests/maintenance.test.mjs, which reads the compiled Worker.

  With the NEXT_PUBLIC_ prefix the value is inlined as a literal, so the
  compiled Worker carries the answer instead of looking for it.

  Set NEXT_PUBLIC_MAINTENANCE_MODE=1 in the build environment. The deploy
  workflow offers it as a dropdown so it can be done from the Actions tab
  without editing anything.
*/
export const MAINTENANCE_MODE = process.env.NEXT_PUBLIC_MAINTENANCE_MODE === "1";
