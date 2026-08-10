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

  Set MAINTENANCE_MODE=1 in the build environment. The deploy workflow offers it
  as a dropdown so it can be done from the Actions tab without editing anything.
*/
export const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === "1";
