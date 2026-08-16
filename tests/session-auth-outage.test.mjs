/*
  A Supabase Auth outage must never look like a signed-out visitor.

  getSessionUser returns null for "not signed in" and every billing caller
  (lib/billing/gate.ts, app/api/account/status/route.ts) takes a null user as
  license to answer with the anonymous/free case. If userFromAccessToken folded
  a network failure or a GoTrue 5xx into that same null, a paying subscriber
  hitting an outage would be silently served the free tier — no error, no log,
  nothing to notice. This file locks in that the two are distinguishable: a
  genuine "your token is not valid" (401/403) is null, and everything else
  GoTrue could do wrong is a throw.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const supabase = await import(
  pathToFileURL(join(process.cwd(), "lib", "auth", "supabase.ts")).href
);

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

const CONFIG = {
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

test("a token GoTrue actually rejects (401) is read as not signed in", () =>
  withEnv(CONFIG, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    try {
      assert.equal(await supabase.userFromAccessToken("bad-token"), null);
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("a network failure reaching GoTrue throws rather than reading as signed out", () =>
  withEnv(CONFIG, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    try {
      await assert.rejects(() => supabase.userFromAccessToken("a-real-token"));
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("GoTrue answering with a server error throws rather than reading as signed out", () =>
  withEnv(CONFIG, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("upstream down", { status: 503 });
    try {
      await assert.rejects(() => supabase.userFromAccessToken("a-real-token"));
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("a 200 whose body cannot be parsed throws rather than reading as signed out", () =>
  withEnv(CONFIG, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    try {
      await assert.rejects(() => supabase.userFromAccessToken("a-real-token"));
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

test("a genuine user answer still resolves normally", () =>
  withEnv(CONFIG, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", email: "learner@example.test" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    try {
      const user = await supabase.userFromAccessToken("a-real-token");
      assert.equal(user.id, "11111111-1111-4111-8111-111111111111");
      assert.equal(user.email, "learner@example.test");
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));
