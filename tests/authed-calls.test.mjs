/*
  Every call to the API carries the session token.

  This is the check that was missing when three of the four AI routes shipped
  with a bare `fetch`. Identity travels in one place — the Authorization header
  — and `fetch` does not add it, so the server saw an anonymous caller. An
  anonymous caller's daily AI allowance is zero by design, so a signed-in
  learner was told, on their first attempt of the day, that they had used all
  of today's AI feedback.

  Nothing failed. No test failed, no build failed, and the message the learner
  saw was exactly right for the request that actually arrived. Only the request
  was wrong.

  So the rule is enforced by reading the source: in client code, a URL that
  starts with /api/ may be requested through `authedFetch` or `postJSON`, and
  not through a bare `fetch`. It is a blunt rule and that is the point — a
  subtler one would need judgement at the moment somebody is least likely to
  apply it.

  Three endpoints are exempt, and each has to be exempt rather than merely
  being allowed to be:

    /api/auth/* — these are how a session comes to exist. There is nothing to
      send yet, by definition.
    /api/billing/config — public. It answers what the plans cost, which is the
      same answer for everybody including nobody.
    GET /api/chat — an unmetered probe that answers whether an API key is
      configured. The POST on the same route is metered and does use
      authedFetch; a probe that required a session would make the tutor look
      broken to a signed-out visitor rather than merely unavailable.
*/
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { join, relative } from "node:path";

const ROOT = process.cwd();

function sources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      /* app/api is the server side of the wire; it has no session to send. */
      if (relative(ROOT, full).replace(/\\/g, "/") === "app/api") continue;
      sources(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...sources(join(ROOT, "app")),
  ...sources(join(ROOT, "components")),
  ...sources(join(ROOT, "lib")),
];

test("no client code requests /api/ through a bare fetch", () => {
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    /* lib/api.ts is where the authed helper is built, so it is allowed to
       mention fetch — it calls authedFetch, which calls fetch. */
    if (rel === "lib/account.ts" || rel === "lib/api.ts") continue;

    for (const [i, line] of text.split("\n").entries()) {
      /* A bare fetch( whose argument mentions /api/ — on this line or the next
         couple, since the URL is often on its own line. */
      if (!/(?<![.\w])fetch\s*\(/.test(line)) continue;
      if (/authedFetch\s*\(/.test(line)) continue;
      const window = text.split("\n").slice(i, i + 3).join(" ");
      if (!/["'`]\/api\//.test(window)) continue;
      /* See the header for why each of these three is exempt. */
      if (/["'`]\/api\/auth\//.test(window)) continue;
      if (/["'`]\/api\/billing\/config["'`]/.test(window)) continue;
      if (/["'`]\/api\/chat["'`]\s*\)\s*\)/.test(window) && !/method:\s*["'`]POST/.test(window)) continue;
      offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these call /api/ without the session token:\n  ${offenders.join("\n  ")}`,
  );
});

/*
  And the four AI routes specifically, by name, because they are the ones where
  a missing token turns into a wrong sentence on the learner's screen rather
  than into an obvious failure.
*/
test("each metered AI route is reached through an authed helper", () => {
  const wanted = ["/api/generate", "/api/grade/writing", "/api/grade/speaking", "/api/chat", "/api/define"];
  const found = new Map(wanted.map((r) => [r, []]));

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    for (const route of wanted) {
      /* Every occurrence, not the first. /api/chat appears twice — an
         unmetered GET probe and the metered POST — and checking only the first
         would have passed on the probe and never looked at the POST. */
      let from = 0;
      for (;;) {
        const idx = text.indexOf(`"${route}"`, from);
        if (idx === -1) break;
        from = idx + 1;
        const before = text.slice(Math.max(0, idx - 200), idx);
        /* Loose on purpose: a generic like postJSON<Omit<A, "b">> contains > and
           defeats anything tighter, and test 1 above already forbids the bare
           fetch this could otherwise wave through. */
        if (/authedFetch|postJSON/.test(before)) found.get(route).push(rel);
      }
    }
  }

  for (const route of wanted) {
    assert.ok(
      found.get(route).length > 0,
      `${route} is never called through authedFetch or postJSON`,
    );
  }
});
