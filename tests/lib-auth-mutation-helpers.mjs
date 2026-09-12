/*
  Shared plumbing for this mutation-kill pass over lib/auth/native-email.ts,
  native-session.ts, native-password.ts, session.ts and bcrypt-verifier.ts
  (tests/native-email-mutation.test.mjs, tests/native-session-mutation.test.mjs,
  tests/native-password-mutation.test.mjs, tests/session-mutation.test.mjs,
  tests/bcrypt-verifier-mutation.test.mjs).

  Each of those files still calls register(...) itself: node:test runs every
  *.test.mjs in its own process, so a loader hook registered here would not
  reach them. What is safe to share is everything else -- the D1-over-
  node:sqlite adapter tests/native-registration-writes.test.mjs and
  tests/cutover-write-barrier.test.mjs already use, a header-only fake Request,
  and an env-var save/restore helper -- and copying those five times across
  files would be its own source of drift between them.
*/
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const ROOT = process.cwd();

/** Wraps a node:sqlite DatabaseSync as the D1 binding shape lib/ code expects. */
export function runtimeD1(database) {
  const execute = (statement) => {
    const result = database.prepare(statement.sql).run(...statement.values);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    async run() { return execute({ sql, values }); },
    async first(column) {
      const row = database.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] ?? null : row;
    },
    async all() {
      return { success: true, results: database.prepare(sql).all(...values), meta: {} };
    },
  });
  return {
    prepare(sql) {
      return { bind: (...values) => bound(sql, values), ...bound(sql, []) };
    },
    // D1's batch() is one atomic unit -- see native-registration-writes.test.mjs's
    // copy of this same adapter for why that matters to the code under test.
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** A fresh in-memory D1 with every real migration replayed in order, so CHECK
    constraints and triggers are the ones D1 actually enforces. */
export function freshD1() {
  const database = new DatabaseSync(":memory:");
  const dir = join(ROOT, "cloudflare", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(dir, file), "utf8"));
  }
  return database;
}

export function fakeR2() {
  return { async put() {}, async get() { return null; }, async delete() {} };
}

/** Stands in for the `EMAIL` Cloudflare binding; records every message handed to it. */
export function fakeEmailBinding() {
  const sent = [];
  return { sent, async send(message) { sent.push(message); } };
}

/**
 * A minimal stand-in for `Request`, exposing only what
 * lib/auth/session.ts's bearerToken() reads (`req.headers.get(name)`).
 *
 * The real Fetch API's Headers class normalises a header value (trims outer
 * whitespace, and some runtimes reject embedded control characters outright),
 * which would silently erase exactly the malformed-input cases this file's
 * tests aim to hand to bearerToken() directly -- a bare interior "\n", a
 * value carrying its own leading/trailing spaces before session.ts gets to
 * trim it itself. A plain object sidesteps that: bearerToken() only ever
 * calls `.headers.get(...)`, and TypeScript's `Request` parameter type is
 * erased at runtime, so nothing else about the real function changes.
 */
export function fakeRequest(authorization) {
  return {
    headers: {
      get(name) {
        return String(name).toLowerCase() === "authorization" ? authorization ?? null : null;
      },
    },
  };
}

/** Saves and restores exactly the named env vars, tolerating an absent one. */
export async function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Runs `fn` with `globalThis.window` set to a plain object, so
 * assertServerOnly(MODULE) throws the way it would if one of these
 * server-only modules were ever pulled into a client bundle. Always deletes
 * `window` again afterwards, pass or throw.
 */
export async function withBrowserWindow(fn) {
  const had = "window" in globalThis;
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    return await fn();
  } finally {
    if (had) globalThis.window = previous;
    else delete globalThis.window;
  }
}
