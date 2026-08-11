/*
  The switch that closes the site deploys, and the thing it deploys exists.

  The site closes on NEXT_PUBLIC_MAINTENANCE_MODE, substituted into the
  compiled code at build time. Two attempts to read the flag at runtime have
  now failed in production — a plain process.env lookup that the Cloudflare
  Worker never had, and a database read from the root layout that answered 500
  on every page — so the switch stopped trying and started asking for a
  deployment instead.

  That makes three things load-bearing and none of them look it:

    the workflow file name the API dispatches has to be a workflow that is
      there, or the button 404s and nobody finds out until the day the site
      needs closing;

    the workflow has to keep taking an input called `maintenance`, or the
      dispatch is rejected 422 for a reason the message does not explain;

    the input has to be sent as a string, because GitHub rejects a JSON boolean
      for a boolean input with "Unexpected inputs provided" — which reads like
      the name is wrong when the type is.

  A rename or a tidy-up breaks any of them silently. This is the thing that
  notices.
*/
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const deploy = readFileSync("lib/admin/deploy.ts", "utf8");
const route = readFileSync("app/api/admin/maintenance/route.ts", "utf8");

/* Comments describe the trap; they must not be what satisfies the test. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The workflow file the dispatcher names, read out of the source. */
const named = /DEPLOY_WORKFLOW\s*=\s*"([^"]+)"/.exec(code(deploy))?.[1];

test("the workflow it dispatches is a workflow that exists", () => {
  assert.ok(named, "lib/admin/deploy.ts no longer names a workflow file");
  assert.ok(
    existsSync(`.github/workflows/${named}`),
    `lib/admin/deploy.ts dispatches ${named}, which is not in .github/workflows`,
  );
});

test("that workflow still takes a maintenance input", () => {
  const workflow = readFileSync(`.github/workflows/${named}`, "utf8");
  assert.match(workflow, /workflow_dispatch:/, `${named} can no longer be dispatched at all`);
  assert.match(
    workflow,
    /inputs:[\s\S]{0,200}?maintenance:/,
    `${named} no longer declares a "maintenance" input — the switch would be rejected 422`,
  );
});

test("the input is sent as a string, not a JSON boolean", () => {
  const body = code(deploy);
  assert.match(
    body,
    /maintenance:\s*closed\s*\?\s*"true"\s*:\s*"false"/,
    'GitHub rejects a JSON boolean for a boolean workflow input — send "true" / "false"',
  );
});

test("throwing the switch actually asks for a deployment", () => {
  const body = code(route);
  assert.match(body, /dispatchDeploy\(/, "the POST handler no longer starts a deployment");
  assert.match(
    body,
    /setMaintenance\([\s\S]{0,200}?dispatchDeploy\(/,
    "the decision must be recorded before the deployment is asked for, so an unreachable GitHub does not lose it",
  );
});

test("the token is never sent to the browser", () => {
  const body = code(deploy);
  assert.doesNotMatch(
    body,
    /NEXT_PUBLIC_GITHUB|NEXT_PUBLIC_DEPLOY/,
    "a deploy token behind a NEXT_PUBLIC_ name is a deploy token in the client bundle",
  );
  /* The route may report *whether* a hook is configured; never what it is. */
  assert.doesNotMatch(
    code(route),
    /GITHUB_DEPLOY_TOKEN/,
    "the route must ask lib/admin/deploy whether a token exists, never read or echo the value",
  );
});
