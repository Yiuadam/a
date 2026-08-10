/*
  The maintenance switch is wired to a variable that survives compilation.

  This test exists because the switch shipped broken and reported success three
  times. The flag was read as `process.env.MAINTENANCE_MODE`, which Next
  compiles to an ordinary runtime lookup — and this app's pages are re-rendered
  on each request by the Cloudflare Worker, where no build-machine variable
  exists. So the lookup returned undefined on every request, the flag read
  false, and the site served the app while the deploy log, the build output and
  two rounds of local checking all said it was closed.

  What made it survive verification is worth recording, because the same trap is
  set for anything else read this way. The prerendered HTML *did* contain the
  notice, and `next start` serves that HTML — so every local check passed. Only
  the Worker re-renders, and only `wrangler dev` against a real `cf:build`
  reproduces it.

  `NEXT_PUBLIC_` is the one prefix Next substitutes into the code as a literal,
  so the compiled Worker carries the answer instead of going looking for it.
  That is the whole fix, and it is one word long, which is exactly why it needs
  a test: nothing about the name looks load-bearing.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const VAR = "NEXT_PUBLIC_MAINTENANCE_MODE";

const read = (p) => readFileSync(p, "utf8");

/*
  Comments are prose about the code, not the code. This file's own explanation
  of the bug quotes the broken expression, and a check that could not tell the
  two apart would fail on a correct file that documents why it is correct —
  which teaches the next person to delete the explanation.
*/
const code = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the flag is read from a variable that is inlined at build time", () => {
  const source = code("lib/maintenance.ts");

  assert.match(
    source,
    new RegExp(`process\\.env\\.${VAR}`),
    `lib/maintenance.ts must read ${VAR}. Without the NEXT_PUBLIC_ prefix the ` +
      "value is looked up at runtime on the Worker, where it does not exist, and " +
      "the site stays open while every check says it is closed.",
  );

  /*
    And specifically not the bare name. A file that read both would look
    correct and behave like the broken version, since the runtime lookup wins
    wherever it appears.
  */
  assert.doesNotMatch(
    source,
    /process\.env\.MAINTENANCE_MODE\b/,
    "lib/maintenance.ts still reads the un-prefixed MAINTENANCE_MODE, which is " +
      "the bug this test exists to prevent",
  );
});

test("the header rule and the gate agree on the variable", () => {
  /*
    next.config.ts decides whether the closed sign may be cached. If it read a
    different variable from the gate, the two would disagree — a closed site
    served with the app's caching rules, which is how the first attempt at this
    ended up being blamed on a stale cache.
  */
  assert.match(code("next.config.ts"), new RegExp(`process\\.env\\.${VAR}`));
});

test("the deploy workflow sets the variable the code reads", () => {
  const workflow = read(".github/workflows/deploy-cloudflare.yml");
  assert.match(
    workflow,
    new RegExp(`${VAR}:`),
    `the deploy workflow must set ${VAR}; setting any other name is a switch ` +
      "that is wired to nothing",
  );
  assert.match(
    workflow,
    /inputs\.maintenance/,
    "the workflow input must still drive it, or the checkbox does nothing",
  );
});
