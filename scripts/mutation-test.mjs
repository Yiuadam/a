#!/usr/bin/env node
/*
  A deliberately small, deterministic mutation suite for the highest-risk
  local-only code paths.  It runs each mutant in an isolated disposable copy
  of the worktree, with node_modules linked read-only from the original.

  This is not a percentage for the whole product. It is a repeatable measure
  for the listed security and data-loss behaviours: progress merging, native
  session verification, Google token verification, native identity cutover,
  Cloudflare finance/deletion, and Stripe historical-payment preservation.
  Add a mutant only when it represents a concrete regression that would be
  harmful in production; do not inflate the score with cosmetic mutations.

  No Worker, D1, R2, Supabase, Stripe or external network request is needed.
*/
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const focus = process.argv.find((argument) => argument.startsWith("--focus="))?.slice("--focus=".length);
const json = process.argv.includes("--json");
const keep = process.argv.includes("--keep-sandbox");

const tests = [
  "tests/mutation-progress-boundaries.test.mjs",
  "tests/mutation-native-auth-boundaries.test.mjs",
  "tests/native-auth-readiness.test.mjs",
  "tests/native-password-migration-proof.test.mjs",
  "tests/native-session-continuity.test.mjs",
  "tests/cloudflare-account-status.test.mjs",
  "tests/cloudflare-ai-cost-read-authority.test.mjs",
  "tests/cloudflare-account-deletion.test.mjs",
  "tests/stripe-prepaid-backfill.test.mjs",
];

const mutants = [
  {
    area: "progress",
    id: "placement-newest-date-wins",
    file: "lib/progress/merge.ts",
    from: "return remoteStamp > localStamp ? remoteOk : localOk;",
    to: "return remoteStamp > localStamp ? localOk : remoteOk;",
  },
  {
    area: "progress",
    id: "placement-clear-is-strict",
    file: "lib/progress/merge.ts",
    from: "return stamp !== null && stamp > clearedAt;",
    to: "return stamp !== null && stamp >= clearedAt;",
  },
  {
    area: "progress",
    id: "invalid-placement-date-cannot-win",
    file: "lib/progress/merge.ts",
    from: "return date ? Date.parse(date) : null;",
    to: "return date ? Date.parse(date) : Date.now();",
  },
  {
    area: "progress",
    id: "history-clear-is-strict",
    file: "lib/progress/merge.ts",
    from: ".filter((result) => !historyClearedAt || result.date > historyClearedAt)",
    to: ".filter((result) => !historyClearedAt || result.date >= historyClearedAt)",
  },
  {
    area: "native-session",
    id: "access-token-signature-required",
    file: "lib/auth/native-session.ts",
    from: "if (!verified || payload.exp * 1000 <= now || payload.iat * 1000 > now) return null;",
    to: "if (false || payload.exp * 1000 <= now || payload.iat * 1000 > now) return null;",
  },
  {
    area: "native-session",
    id: "access-token-expiry-is-inclusive",
    file: "lib/auth/native-session.ts",
    from: "payload.exp * 1000 <= now",
    to: "payload.exp * 1000 < now",
  },
  {
    area: "native-session",
    id: "access-token-issued-in-future-rejected",
    file: "lib/auth/native-session.ts",
    from: "payload.iat * 1000 > now",
    to: "payload.iat * 1000 < now",
  },
  {
    area: "native-session",
    id: "native-token-marker-checks-claims",
    file: "lib/auth/native-session.ts",
    from: "return payload?.iss === ISSUER && payload?.aud === AUDIENCE;",
    to: "return true;",
  },
  {
    area: "google-token",
    id: "google-audience-required",
    file: "lib/auth/google-token.ts",
    from: "|| payload.aud !== expectedAudience",
    to: "|| false",
  },
  {
    area: "google-token",
    id: "google-issuer-required",
    file: "lib/auth/google-token.ts",
    from: "|| typeof payload.iss !== \"string\" || !GOOGLE_ISSUERS.has(payload.iss)",
    to: "|| false",
  },
  {
    area: "google-token",
    id: "google-token-expiry-is-strict",
    file: "lib/auth/google-token.ts",
    from: "payload.exp <= nowSeconds",
    to: "payload.exp < nowSeconds",
  },
  {
    area: "google-token",
    id: "google-nonce-required",
    file: "lib/auth/google-token.ts",
    from: "|| nonce !== (nonceEncoding === \"raw\" ? rawNonce : await nonceDigest(rawNonce))",
    to: "|| false",
  },
  {
    area: "cutover",
    id: "both-data-authorities-required",
    file: "lib/cloudflare/native-auth-readiness.ts",
    from: "ready: writesToCloudflareOnly() && organizationWritesToCloudflareOnly(),",
    to: "ready: writesToCloudflareOnly() || organizationWritesToCloudflareOnly(),",
  },
  {
    area: "cutover",
    id: "native-flag-required",
    file: "lib/cloudflare/native-auth-readiness.ts",
    from: "return nativeAuthEnabled() && nativeAuthDataAuthority().ready;",
    to: "return nativeAuthDataAuthority().ready;",
  },
  {
    area: "native-finance",
    id: "provider-backfill-provenance-retained",
    file: "lib/cloudflare/ai-cost-read-authority.ts",
    from: "if (row.source === \"provider_backfill\") includesProviderBackfill = true;",
    to: "if (false) includesProviderBackfill = true;",
  },
  {
    area: "native-deletion",
    id: "native-and-legacy-deletion-authorities-cannot-cross",
    file: "app/api/account/delete/route.ts",
    from: "&& cloudflarePreparation.authAuthority !== (nativeSession ? \"cloudflare\" : \"supabase\")",
    to: "&& false",
  },
  {
    area: "native-identity",
    id: "apple-and-unknown-providers-block-native-only-cutover",
    file: "lib/cloudflare/native-identity-audit.ts",
    from: "const readyForNativeAuthCutover = readyForGoogleCutover && providersClean;",
    to: "const readyForNativeAuthCutover = readyForGoogleCutover && true;",
  },
  {
    area: "native-password-evidence",
    id: "password-proof-hash-must-match-complete-import",
    file: "lib/cloudflare/native-password-migration-audit.ts",
    from: "|| manifest !== sourceManifestSha256",
    to: "|| false",
  },
  {
    area: "stripe-backfill",
    id: "mismatched-prepaid-ledger-blocks-write",
    file: "scripts/backfill-stripe-prepaid-purchases.mjs",
    from: "|| report.mismatchedTarget > 0",
    to: "|| false",
  },
];

function command(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      NO_COLOR: "1",
      NODE_OPTIONS: "",
    },
  });
}

function copyWorktree(destination) {
  const result = command("rsync", [
    "-a",
    "--exclude", ".git",
    "--exclude", "node_modules",
    "--exclude", ".next",
    "--exclude", ".open-next",
    "--exclude", ".wrangler",
    `${root}/`,
    `${destination}/`,
  ], root);
  if (result.status !== 0) {
    throw new Error(`could not prepare mutation sandbox: ${result.stderr || result.stdout}`);
  }
  symlinkSync(join(root, "node_modules"), join(destination, "node_modules"), "dir");
}

function replaceExactlyOnce(source, mutant) {
  const first = source.indexOf(mutant.from);
  if (first === -1) throw new Error(`${mutant.id}: source pattern was not found`);
  if (source.indexOf(mutant.from, first + mutant.from.length) !== -1) {
    throw new Error(`${mutant.id}: source pattern is ambiguous`);
  }
  return `${source.slice(0, first)}${mutant.to}${source.slice(first + mutant.from.length)}`;
}

function runTests(cwd) {
  return command(process.execPath, ["--test", ...tests], cwd);
}

function failureSummary(result) {
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter((line) => /not ok|fail|error|assert/i.test(line))
    .slice(0, 4)
    .join(" | ")
    .slice(0, 600);
}

const selected = focus ? mutants.filter((mutant) => mutant.area === focus) : mutants;
if (focus && selected.length === 0) {
  throw new Error(`Unknown mutation focus \"${focus}\". Use one of: ${[...new Set(mutants.map((mutant) => mutant.area))].join(", ")}`);
}

const sandbox = mkdtempSync(join(tmpdir(), "bandup-mutation-"));
let report;
try {
  copyWorktree(sandbox);
  const baseline = runTests(sandbox);
  if (baseline.status !== 0) {
    throw new Error(`baseline tests failed; refusing to score mutants:\n${baseline.stdout}\n${baseline.stderr}`);
  }

  const outcomes = [];
  for (const mutant of selected) {
    const path = join(sandbox, mutant.file);
    const source = readFileSync(path, "utf8");
    writeFileSync(path, replaceExactlyOnce(source, mutant));
    const result = runTests(sandbox);
    writeFileSync(path, source);
    outcomes.push({
      area: mutant.area,
      id: mutant.id,
      outcome: result.status === 0 ? "survived" : "killed",
      detail: result.status === 0 ? undefined : failureSummary(result),
    });
  }
  const killed = outcomes.filter((outcome) => outcome.outcome === "killed").length;
  report = {
    scope: "local-only curated security and data-integrity mutants",
    tests,
    mutants: outcomes,
    killed,
    survived: outcomes.length - killed,
    score: Number(((killed / outcomes.length) * 100).toFixed(2)),
    sandboxRetained: keep ? sandbox : undefined,
  };
} finally {
  if (!keep) rmSync(sandbox, { recursive: true, force: true });
}

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Mutation score: ${report.killed}/${report.mutants.length} killed (${report.score}%)`);
  for (const outcome of report.mutants) {
    console.log(`${outcome.outcome === "killed" ? "KILLED  " : "SURVIVED"} ${outcome.area}: ${outcome.id}`);
  }
  if (report.survived > 0) {
    console.log("Surviving mutants are test gaps, not accepted behaviour. Add focused tests before relying on this score for a cutover.");
  }
}
