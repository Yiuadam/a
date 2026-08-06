import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/*
  Adapts the Next.js build to run on Cloudflare Workers. Defaults are right for
  this app: the AI routes are plain request/response handlers with no
  incremental cache to configure.
*/
export default defineCloudflareConfig();
