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
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const maintenanceToggle = await import(
  pathToFileURL(join(process.cwd(), "lib", "admin", "maintenance-toggle.ts")).href
);
import ts from "typescript";

const deploy = readFileSync("lib/admin/deploy.ts", "utf8");
const route = readFileSync("app/api/admin/maintenance/route.ts", "utf8");
const settings = readFileSync("lib/admin/settings.ts", "utf8");
const consoleHook = readFileSync("lib/admin/useConsole.ts", "utf8");
const consoleParts = readFileSync("components/admin/ConsoleParts.tsx", "utf8");

/* Comments describe the trap; they must not be what satisfies the test. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/*
  Node's test runner deliberately knows nothing about the app's @/* alias.
  Compile this one dependency-free module after replacing its server guard so
  the real dispatcher can be exercised without changing production imports.
*/
const executableDeploy = deploy.replace(
  'import { assertServerOnly } from "@/lib/auth/server-only";',
  "const assertServerOnly = () => {};",
);
const compiledDeploy = ts.transpileModule(executableDeploy, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { dispatchDeploy } = await import(
  `data:text/javascript;base64,${Buffer.from(compiledDeploy).toString("base64")}`
);

const SECRET = "github_pat_never-show-this";
const PRIVATE_BODY = "provider diagnostic body that must stay server-side";
const env = Object.freeze({
  GITHUB_DEPLOY_TOKEN: SECRET,
  GITHUB_REPOSITORY: "BandUp/example",
});

async function resultFor(status, body = PRIVATE_BODY) {
  return dispatchDeploy(true, {
    env,
    fetch: async () => new Response(status === 204 ? null : body, { status }),
  });
}

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

test("a failed close and failed reopen retry the saved choice instead of inverting it", () => {
  const failedClose = { closed: true, closedByDeploy: false, deployStarted: false };
  assert.equal(maintenanceToggle.nextMaintenanceClosed(failedClose), true);
  assert.equal(maintenanceToggle.maintenanceActionLabel(failedClose), "Retry closing");

  const failedReopen = { closed: false, closedByDeploy: true, deployStarted: false };
  assert.equal(maintenanceToggle.nextMaintenanceClosed(failedReopen), false);
  assert.equal(maintenanceToggle.maintenanceActionLabel(failedReopen), "Retry reopening");
});

test("normal settled and accepted-dispatch states still invert the desired state", () => {
  assert.equal(
    maintenanceToggle.nextMaintenanceClosed({ closed: false, closedByDeploy: false }),
    true,
  );
  assert.equal(
    maintenanceToggle.nextMaintenanceClosed({ closed: true, closedByDeploy: true }),
    false,
  );
  assert.equal(
    maintenanceToggle.nextMaintenanceClosed({
      closed: true,
      closedByDeploy: false,
      deployStarted: true,
    }),
    false,
  );
});

test("an unmatched old decision with no saved dispatch result retries safely", () => {
  const unknownClose = { closed: true, closedByDeploy: false };
  assert.equal(maintenanceToggle.nextMaintenanceClosed(unknownClose), true);
  assert.equal(maintenanceToggle.maintenanceActionLabel(unknownClose), "Retry closing");
});

test("the failed-dispatch state is wired through the API, hook and visible control", () => {
  assert.match(consoleHook, /nextMaintenanceClosed\(state\)/);
  assert.match(consoleParts, /Closing was not deployed/);
  assert.match(consoleParts, /Reopening was not deployed/);
  assert.match(consoleParts, /Deployment status is unknown/);
  assert.match(consoleParts, /maintenanceActionLabel\(state\)/);

  assert.match(settings, /MAINTENANCE_DISPATCH_KEY\s*=\s*"maintenance_dispatch"/);
  assert.match(route, /maintenanceDispatchSetting\(\)/);
  assert.match(route, /dispatch\.decisionAt\s*===\s*setting\.at/);
  assert.match(route, /recordMaintenanceDispatch\(/);
  assert.match(route, /deployStarted:\s*matchingDispatch\.started/);
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

test("GitHub dispatch success accepts both 200 and 204", async () => {
  for (const status of [200, 204]) {
    assert.deepEqual(await resultFor(status), { started: true, problem: null });
  }
});

test("401 authentication and 403 authorization failures are distinct", async () => {
  const unauthenticated = await resultFor(401);
  const forbidden = await resultFor(403);

  assert.equal(unauthenticated.started, false);
  assert.match(unauthenticated.problem, /could not authenticate/i);
  assert.equal(forbidden.started, false);
  assert.match(forbidden.problem, /authenticated[\s\S]*blocked workflow dispatch/i);
  assert.match(forbidden.problem, /Actions[\s\S]*Read and write/i);
  assert.notEqual(unauthenticated.problem, forbidden.problem);
});

test("dispatcher errors never expose the token or GitHub response body", async () => {
  for (const status of [401, 403, 404, 422, 500]) {
    const result = await resultFor(status, `${PRIVATE_BODY}: ${SECRET}`);
    assert.equal(result.started, false);
    assert.doesNotMatch(result.problem, new RegExp(SECRET));
    assert.doesNotMatch(result.problem, new RegExp(PRIVATE_BODY));
  }

  const networkFailure = await dispatchDeploy(false, {
    env,
    fetch: async () => {
      throw new Error(`${PRIVATE_BODY}: ${SECRET}`);
    },
  });
  assert.equal(networkFailure.started, false);
  assert.doesNotMatch(networkFailure.problem, new RegExp(SECRET));
  assert.doesNotMatch(networkFailure.problem, new RegExp(PRIVATE_BODY));
});
