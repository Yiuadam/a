import { assertServerOnly } from "@/lib/auth/server-only";

const MODULE = "lib/admin/deploy.ts";

/*
  Turning the switch into a deployment.

  ---------------------------------------------------------------------------
  Why a deployment and not a flag read at runtime

  Because that is the mechanism that has ever actually worked. The site closes
  on `NEXT_PUBLIC_MAINTENANCE_MODE`, which Next substitutes into the compiled
  code at build time — the one prefix it inlines — and the deploy workflow sets
  it from a checkbox. Everything else that has been tried read a value the
  Cloudflare Worker did not have at render time: a plain `process.env` lookup
  found nothing and the site stayed open through three deploys that all
  reported success, and a database read from the root layout answered 500 on
  every page of a preview and could not be reproduced locally in five
  configurations.

  So the switch stops trying to be clever and asks for the thing that works:
  it dispatches .github/workflows/deploy-cloudflare.yml, which already takes a
  `maintenance` boolean and has taken it since the day it was written. Two
  minutes rather than ten seconds, and correct rather than nearly.

  The database setting is still written first and still shows on the console —
  it is the record of what the owner decided, which is worth keeping whether or
  not the deploy that carries it out succeeds.

  ---------------------------------------------------------------------------
  What it needs, and what happens without it

  GITHUB_DEPLOY_TOKEN, a fine-grained token with Actions: read and write on
  this repository and nothing else. Held as a Worker secret. Never
  NEXT_PUBLIC_, never logged, never returned to a caller — the response says
  whether a run was started, not what was used to start it.

  Unset, this returns "not configured" and the console keeps telling the owner
  to run the workflow by hand. That is the honest degradation: the button does
  not silently do nothing, and it does not pretend.
*/

/** Where the deployment lives. Overridable so a fork can point at itself. */
const DEFAULT_REPO = "Yiuadam/a";

/**
 * The workflow file, by name.
 *
 * GitHub accepts either a numeric id or the file name, and the file name is
 * the one a person can check against the repository. tests/deploy-switch.test.mjs
 * fails if this names a workflow that is not there, because a rename would
 * otherwise turn the button into a 404 nobody notices until the day the site
 * needs closing.
 */
export const DEPLOY_WORKFLOW = "deploy-cloudflare.yml";

/** The branch production is built from. */
const DEPLOY_REF = "main";

export interface DispatchResult {
  /** Whether a deployment was actually asked for. */
  started: boolean;
  /** Why not, in words the owner can act on. Null when it started. */
  problem: string | null;
}

/**
 * Injectable edges for deterministic tests. Production callers omit this and
 * use the Worker's environment and fetch implementation.
 */
export interface DispatchDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
}

export function deployHookConfigured(): boolean {
  assertServerOnly(MODULE);
  return (process.env.GITHUB_DEPLOY_TOKEN ?? "").trim().length > 0;
}

function repo(env: Readonly<Record<string, string | undefined>>): string {
  const configured = (env.GITHUB_REPOSITORY ?? "").trim();
  return /^[\w.-]+\/[\w.-]+$/.test(configured) ? configured : DEFAULT_REPO;
}

function dispatchProblem(status: number): string {
  switch (status) {
    case 401:
      return "GitHub could not authenticate the deploy token. It may be expired, revoked or malformed. Replace it using DEPLOY.md.";
    case 403:
      return "GitHub authenticated the deploy token but blocked workflow dispatch. Confirm Actions is set to Read and write for this repository, and check organisation or SSO restrictions. See DEPLOY.md.";
    case 404:
      return `GitHub could not find the ${DEPLOY_WORKFLOW} workflow, or the token cannot see this repository.`;
    case 422:
      return "GitHub rejected the deployment request. The workflow may no longer take a maintenance input.";
    default:
      return `GitHub answered ${status} when asked to deploy.`;
  }
}

/**
 * Asks GitHub to run the deploy workflow with the site closed, or open.
 *
 * Never throws. The caller has already written the owner's decision to the
 * database and must be able to report both halves — what was recorded, and
 * whether the deployment that carries it out was started.
 */
export async function dispatchDeploy(
  closed: boolean,
  dependencies: DispatchDependencies = {},
): Promise<DispatchResult> {
  assertServerOnly(MODULE);

  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const token = (env.GITHUB_DEPLOY_TOKEN ?? "").trim();
  if (!token) {
    return {
      started: false,
      problem:
        /* Named in DEPLOY.md rather than here: this string is rendered by a
           client component, and tests/no-secret-leak forbids a server-only
           secret's *name* from reaching the browser bundle at all. */
        "No deploy token is set on the Worker, so nothing was deployed. Add one (see DEPLOY.md) or run the Deploy to Cloudflare workflow yourself.",
    };
  }

  let res: Response;
  try {
    res = await fetcher(
      `https://api.github.com/repos/${repo(env)}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          /* GitHub rejects an API request with no User-Agent. */
          "User-Agent": "bandup-admin-console",
          "Content-Type": "application/json",
        },
        /*
          Workflow inputs are strings on the wire even when the workflow
          declares them as booleans — GitHub coerces them on the way in. Sending
          a JSON `true` is rejected with 422 "Unexpected inputs provided",
          which is a confusing way to be told the type is wrong.
        */
        body: JSON.stringify({
          ref: DEPLOY_REF,
          inputs: { maintenance: closed ? "true" : "false" },
        }),
      },
    );
  } catch {
    return {
      started: false,
      problem: "Couldn't reach GitHub to start the deployment. Your choice was saved.",
    };
  }

  /*
    GitHub documents 204 No Content for workflow dispatches. Some compatible
    gateways return 200 after accepting the same request, so both are success.
  */
  if (res.status === 200 || res.status === 204) {
    return { started: true, problem: null };
  }

  /*
    The statuses that mean something specific to the person reading. Everything
    else is reported by number rather than guessed at: a wrong guess about why
    a deployment failed is worse than a status code, because it sends the owner
    to fix something that was never broken.
  */
  return {
    started: false,
    problem: `${dispatchProblem(res.status)} Your choice was saved.`,
  };
}
