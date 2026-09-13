/*
  The Anthropic client's timeout follows the route that is calling it.

  One shared number cannot serve both a word lookup and the marking of a
  3,000-token essay: sized for the lookup it cuts off nearly every real
  marking call; sized for marking it lets `define` outlive its own
  30-second route. So each costed route gets its declared maxDuration less a
  margin, and there is no retry, because a second attempt after a timeout
  can never fit inside the same route.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const source = readFileSync(join(root, "lib", "anthropic.ts"), "utf8");

function routeDuration(routePath) {
  const route = readFileSync(join(root, "app", "api", ...routePath.split("/"), "route.ts"), "utf8");
  const m = route.match(/export const maxDuration = (\d+);/);
  assert.ok(m, `${routePath} declares maxDuration`);
  return Number(m[1]) * 1000;
}

function timeoutFor(route) {
  const m = source.match(new RegExp(`(?:"${route}"|${route}):\\s*(\\d[\\d_]*),`));
  assert.ok(m, `ROUTE_TIMEOUT_MS names ${route}`);
  return Number(m[1].replace(/_/g, ""));
}

test("the client is built with the calling route's own timeout and no retries", () => {
  assert.match(source, /new Anthropic\(\{ timeout: ROUTE_TIMEOUT_MS\[opts\.route\], maxRetries: MAX_RETRIES \}\)/);
  assert.match(source, /const MAX_RETRIES = 0;/);
});

test("every route's timeout sits inside its declared maxDuration with a margin, and is long enough to mark", () => {
  const routes = {
    define: "define",
    chat: "chat",
    generate: "generate",
    "grade/writing": "grade/writing",
    "grade/speaking": "grade/speaking",
    examiner: "speaking/examiner-line",
  };
  for (const [route, path] of Object.entries(routes)) {
    const timeout = timeoutFor(route);
    const duration = routeDuration(path);
    assert.ok(timeout <= duration - 5_000, `${route}: ${timeout} leaves under 5s of ${duration}`);
    assert.ok(timeout >= 20_000, `${route}: ${timeout} is too short for any real model call`);
  }
  for (const route of ["grade/writing", "grade/speaking", "generate"]) {
    assert.ok(timeoutFor(route) >= 50_000, `${route} must have time for a 3,000-token reply`);
  }
});
