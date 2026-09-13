/*
  RequiredAccountGate must redirect an unfinished account to onboarding at most
  once per app load, never in a loop.

  The gate lives in the root layout, so it persists across navigations; a plain
  `if (blocked) router.replace(...)` there will fire again every time the
  learner is bounced back (a lagging D1 mirror, or "do this later"), and each
  bounce is a Worker request. A single stuck client cost ~90k requests in a day
  this way. The guard is a ref that survives navigation, so the redirect fires
  once and the learner is then let through rather than trapped.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync(
  join(process.cwd(), "components", "account", "RequiredAccountGate.tsx"),
  "utf8",
);

test("the onboarding redirect is guarded by a ref so it cannot loop", () => {
  assert.match(source, /const redirected = useRef\(false\);/);
  // The effect must bail when the redirect has already been spent, and set the
  // guard before navigating — not after, or a fast re-render fires it twice.
  const effect = source.slice(source.indexOf("useEffect(() => {", source.indexOf("redirected")));
  const body = effect.slice(0, effect.indexOf("}, ["));
  assert.match(body, /if \(!blocked \|\| redirected\.current\) return;/);
  assert.ok(
    body.indexOf("redirected.current = true;") < body.indexOf("router.replace("),
    "the guard must be set before the redirect, not after",
  );
});

test("a blocked account is never trapped on a spinner — the app renders", () => {
  // The old `if (blocked) return <spinner>` trapped a learner who came back
  // from onboarding still unfinished. Render must fall through to children.
  assert.doesNotMatch(source, /if \(blocked[^)]*\) \{\s*return \(/);
  assert.match(source, /return children;/);
});
