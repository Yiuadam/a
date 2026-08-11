import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/*
  Adapts the Next.js build to run on Cloudflare Workers. Defaults are right for
  this app: the AI routes are plain request/response handlers with no
  incremental cache to configure.
*/
const cloudflareConfig = {
  ...defineCloudflareConfig(),
  /* Turbopack cannot create its CSS helper port inside the desktop sandbox.
     Webpack produces the same standalone Next output without that local IPC. */
  buildCommand: "npx next build --webpack",
};

export default cloudflareConfig;
