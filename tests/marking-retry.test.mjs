/*
  What happens when marking fails, which is the case a report is least likely to
  be tested for and most likely to matter in.

  A full sitting is two and three-quarter hours and ends with two essays going
  to a model. If that call fails — the model timing out, a 5xx, a connection
  that dropped between the last full stop and Submit — the report used to say
  Writing was not marked and stop there. The essays were still in the session,
  nothing was wrong with them, and there was no way to ask again.

  The fix has two halves and both are pinned here: a failure has to carry enough
  information to tell "your plan does not include marking" from "that did not
  work, try again", and the retry has to add only what is missing rather than
  re-running a pass that already wrote to the learner's history.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const api = readFileSync("lib/api.ts", "utf8");
const results = readFileSync("components/exam/MockResults.tsx", "utf8");
const retake = readFileSync("components/exam/MockRetakeResults.tsx", "utf8");

test("a failed request carries its status, so a caller can tell the two cases apart", () => {
  assert.match(api, /export class ApiError extends Error/);
  assert.match(api, /readonly status: number/);
  // Every throw in postJSON: unreachable server, unreadable body, and a
  // response that arrived and said no.
  assert.equal(api.match(/throw new ApiError\(/g)?.length, 3);
  assert.doesNotMatch(
    api.replace(/\* .*/g, ""),
    /throw new Error\(/,
    "a bare Error loses the status the report needs",
  );
});

test("only a failure that could go the other way next time is retryable", () => {
  const retryable = api.match(/get retryable\(\): boolean \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  assert.match(retryable, /status === 0/, "a request that never arrived is worth repeating");
  assert.match(retryable, /status === 429/, "a rate limit clears");
  assert.match(retryable, /status >= 500/, "the server or the model having a bad moment");
  // 402 is the plan not including marking. Nothing is wrong and asking again
  // fails identically, so it must not offer a button that cannot work.
  assert.doesNotMatch(retryable, /402/);
});

test("the sitting offers to mark the essays again, and only when that could work", () => {
  assert.match(results, /markingFailure !== null && marks\.writing === null && wroteSomething/);
  assert.match(results, /const wroteSomething = tasks\.some\(/);
  assert.match(results, /onClick=\{\(\) => void remark\(\)\}/);
  assert.match(results, /err instanceof ApiError && err\.retryable/);
});

test("marking again adds what is missing rather than repeating what worked", () => {
  const remark = results.match(/const remark = useCallback\([\s\S]*?\n {2}\}, \[/)?.[0] ?? "";
  assert.notEqual(remark, "", "MockResults should define a remark callback");
  // addResult prepends rather than replaces — a learner sitting the same paper
  // twice should see two rows — so re-marking must not touch the two modules
  // that were marked correctly the first time.
  assert.doesNotMatch(remark, /module: "listening"/);
  assert.doesNotMatch(remark, /module: "reading"/);
  assert.match(remark, /module: "writing"/);
  // The overall band has to be recomputed, or the ring keeps saying there is
  // no overall band after the missing one has arrived.
  assert.match(remark, /overallFrom\(\{/);
  assert.match(remark, /addMockReport\(/, "the sitting's report is replaced by id");
});

test("a retake retries by running the same pass, because a failed one wrote nothing", () => {
  assert.match(retake, /markingFailure !== null && mark === null/);
  const remark = retake.match(/const remark = useCallback\([\s\S]*?\n {2}\}, \[run\]\);/)?.[0] ?? "";
  assert.match(remark, /void run\(\)/);
  assert.match(remark, /setMarkingFailure\(null\)/);
  // The guard that makes re-running safe.
  assert.match(retake, /if \(!scored\) return;/);
});
