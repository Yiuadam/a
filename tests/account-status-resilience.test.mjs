/*
  A stalled or failed /api/account/status call must stop being a dead end.

  Before this, lib/billing/useTier.ts's fetch had no timeout, so a stalled
  connection left every consumer sitting in phase "loading" indefinitely —
  including the paper tiles on the dashboard and on /practice, which stay
  dimmed and unclickable for exactly as long as that lasts (app/page.tsx,
  app/practice/page.tsx, components/TestChooser.tsx, components/SkillGate.tsx
  all gate on it). And every screen that already knew how to draw phase
  "unavailable" had no way back from it except a full reload: no button, and
  nothing that noticed the network coming back on its own.

  This mirrors tests/loading-indicator.test.mjs and tests/history-gate.test.mjs
  in checking source text rather than a rendered tree — the shape this
  codebase already uses for every other client-side hook and gate, because
  none of these files can be exercised without a bundler and a DOM.

  ---------------------------------------------------------------------------
  Since the fetch moved to a shared module-level store (see the WHY comment
  above `statusCache` in lib/billing/useTier.ts), the per-instance
  useState/useEffect/useCallback these tests used to pin — `revision`, the
  `alive` closure flag, `retry` built with useCallback — no longer exist by
  those names, so the handful of tests that pinned them by exact source text
  are replaced below with equivalents pinned against the new shared
  functions. tests/tier-status-dedup.test.mjs is the behavioural half: it
  imports the store and actually drives it (two mounts, one fetch; a session
  change invalidating a stale in-flight answer) rather than reading its
  source, the same way this file could not do for a per-instance hook with no
  rendered tree to mount.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const useTier = read("lib", "billing", "useTier.ts");

test("the status fetch carries a bounded timeout, so a stall resolves rather than hanging forever", () => {
  assert.match(useTier, /AbortSignal\.timeout\(STATUS_TIMEOUT_MS\)/);
  assert.match(useTier, /const STATUS_TIMEOUT_MS = 8_000;/);
  // The signal has to actually ride on the request this hook makes, not just
  // exist as an unused constant somewhere in the file.
  assert.match(
    useTier,
    /authedFetch\(apiUrl\("\/api\/account\/status"\), \{ signal: AbortSignal\.timeout\(STATUS_TIMEOUT_MS\) \}\)/,
  );
});

test("useTier returns a retry(), backed by the shared store's retryStatus rather than a per-instance callback", () => {
  assert.match(useTier, /retry: \(\) => void/);
  // The fetch effect depends on the session alone now — there is no
  // per-instance revision counter to bump, because retrying is a shared,
  // module-level action (see retryStatus) rather than something scoped to
  // whichever component happened to render the hook that asked for it.
  assert.match(useTier, /useEffect\(\(\) => \{\s*ensureStatus\(session\);\s*\}, \[session\]\);/);
  // And the hook has to hand retry back to callers, not just use it privately.
  assert.match(useTier, /return \{ \.\.\.state, retry: retryStatus \};/);
});

test("phase \"unavailable\" asks again on its own when the browser comes back online or this tab becomes visible", () => {
  assert.match(useTier, /window\.addEventListener\("online", onOnline\)/);
  assert.match(useTier, /document\.addEventListener\("visibilitychange", onVisibility\)/);
  assert.match(useTier, /document\.visibilityState === "visible"/);
  // Both triggers call the same shared retryStatus(), not a re-implementation
  // of the fetch.
  const autoEffect = useTier.slice(useTier.indexOf('if (state.phase !== "unavailable") return;'));
  assert.match(autoEffect, /const onOnline = \(\) => retryStatus\(\);/);
  assert.match(autoEffect, /if \(document\.visibilityState === "visible"\) retryStatus\(\);/);
  // And it only listens while genuinely unavailable — not on every phase.
  assert.match(useTier, /if \(state\.phase !== "unavailable"\) return;/);
});

test("a failed lookup carries accountsEnabled forward instead of resetting it to false", () => {
  // This is the other half of the useSessions.ts fix (see
  // tests/session-tier-outage.test.mjs): that file's "unavailable" branch is
  // only reachable if this one stops lying about accountsEnabled on failure.
  // tests/tier-status-dedup.test.mjs exercises this behaviourally; this pins
  // the source text stayed the deliberate shape rather than regressing to
  // the blunter reset.
  assert.match(
    useTier,
    /statusCache = \{ \.\.\.INITIAL, accountsEnabled: statusCache\.accountsEnabled, phase: "unavailable" \};/,
  );
  // The old, blunter reset must actually be gone, not merely joined by the new one.
  assert.doesNotMatch(useTier, /statusCache = \{ \.\.\.INITIAL, phase: "unavailable" \};/);
});

test("a superseded request's response cannot land — the shared generation counter replaces the old per-effect `alive` flag", () => {
  // The single-instance version guarded this with a boolean an effect closed
  // over (`alive`); the shared store cannot use a closure, since there is one
  // fetch now rather than one per mount, so a module-level counter plays the
  // same role — see the WHY comment above `statusGeneration`.
  assert.match(useTier, /let statusGeneration = 0;/);
  assert.match(useTier, /const generation = \+\+statusGeneration;/);
  // Both the success and the failure branch have to actually check it, or a
  // stale response can still land.
  assert.match(useTier, /if \(generation !== statusGeneration\) return;\s*statusCache = \{\s*phase: "ready",/);
  assert.match(
    useTier,
    /if \(generation !== statusGeneration\) return;\s*\/\*[\s\S]*?\*\/\s*statusCache = \{ \.\.\.INITIAL, accountsEnabled: statusCache\.accountsEnabled, phase: "unavailable" \};/,
  );
});

/*
  The four screens the audit named. Each gets its own "Try again" wired to a
  real retry, matching the shape components/organization/OrganizationPortal.tsx
  already uses (a button that asks again in place, not a sentence promising
  the page will sort itself out).
*/

test("app/account/onboarding: the unavailable card has a working retry, not just an idle sentence", () => {
  const source = read("app", "account", "onboarding", "page.tsx");
  assert.match(source, /const \{ phase, refresh \} = useAccountProfile\(\);/);
  const branch = source.slice(source.indexOf('if (phase === "unavailable")'));
  assert.match(branch, /<button type="button" className="btn-secondary mt-4" onClick=\{refresh\}>Try again<\/button>/);
});

test("components/AccountPanel: the unavailable card retries through the existing reload(), not a fresh mechanism", () => {
  const source = read("components", "AccountPanel.tsx");
  const branch = source.slice(
    source.indexOf('{resolvedPhase === "unavailable" && ('),
    source.indexOf("{accountsOff &&"),
  );
  assert.match(branch, /<button type="button" className="btn-secondary" onClick=\{reload\}>/);
  assert.match(branch, />\s*Try again\s*</);
  // reload() already exists — bumps reloadKey, which the fetch effect already
  // depends on — so this must not have grown a second, parallel retry path.
  assert.match(source, /const reload = useCallback\(\(\) => setReloadKey\(\(n\) => n \+ 1\), \[\]\);/);
});

test("app/billing/state.tsx: billingBlocker can call state.retry(), and no longer promises a fix-itself", () => {
  const source = read("app", "billing", "state.tsx");
  assert.match(source, /export default function billingBlocker\(state: ReturnType<typeof useTier>\): ReactNode \| null \{/);
  const branch = source.slice(
    source.indexOf('if (state.phase === "unavailable")'),
    source.indexOf('if (!state.accountsEnabled)'),
  );
  assert.match(branch, /<button type="button" className="btn-secondary" onClick=\{state\.retry\}>/);
  // The false claim the audit quoted must be gone.
  assert.doesNotMatch(source, /This page will fill in once the connection comes back/);
});

test("app/pricing/PricingPlans.tsx: only the account.phase \"unavailable\" branch grew a retry, not the configPhase one beside it", () => {
  const source = read("app", "pricing", "PricingPlans.tsx");
  const accountBranch = source.slice(
    source.indexOf('if (account.phase === "unavailable") {'),
    source.indexOf('if (configPhase === "unavailable") {'),
  );
  assert.match(accountBranch, /<button type="button" className="btn-secondary" onClick=\{account\.retry\}>/);
  assert.match(accountBranch, />\s*Try again\s*</);

  // The sibling branch — a different failure (the payment service config,
  // not the account) — is out of scope for this fix and must be untouched.
  const configBranch = source.slice(
    source.indexOf('if (configPhase === "unavailable") {'),
  );
  assert.doesNotMatch(configBranch.slice(0, configBranch.indexOf("\n  }\n") + 5), /btn-secondary/);
});
