/*
  The mini program is a shell, not a second copy of the app.

  A WeChat mini program cannot run this codebase: its pages are WXML and its
  runtime is not a browser, so a React app either has to be ported wholesale
  or hosted. Hosting is what this does — one page holding a `<web-view>`
  pointed at the live deployment — and it is the right trade here for a
  reason beyond effort. The content is the product, and it changes: a port
  would have to be rebuilt and re-reviewed every time a question bank or a
  study plan changed, while a shell shows whatever bandup.life is serving.

  What that costs is the parts of the site that need a real browser. The
  refractive glass is deliberately switched off inside the shell — see
  isMiniProgramShell in lib/platform.ts — and the shell says so in the URL it
  opens rather than leaving the page to guess.
*/
App({
  onLaunch() {
    /* Nothing to restore or prefetch: the page inside the web-view owns all
       of the app's state, and it is reached over the network anyway. */
  },
});
