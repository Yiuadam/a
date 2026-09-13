/*
  CORS moved from proxy.ts onto the routes, which means it is now something a
  new route can forget. Middleware applied to everything under its matcher
  whether the author remembered it or not; a wrapper only applies where it is
  written.

  So the thing middleware gave for free is asserted instead: every route under
  app/api exports OPTIONS and wraps its handlers. A route that skips this is
  one the iOS build silently cannot call once accounts are switched on — and
  it would fail in a WebView on a device nobody here can test, which is the
  worst possible place to discover it.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { allowedOrigin, corsHeaders, OPTIONS, withCors } = await import(
  pathToFileURL(join(process.cwd(), "lib", "http", "cors.ts")).href
);

function routeFiles(dir = "app/api") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

test("every API route answers preflight", () => {
  const missing = routeFiles().filter(
    (f) => !readFileSync(f, "utf8").includes('export { OPTIONS } from "@/lib/http/cors"'),
  );
  assert.deepEqual(missing, [], `these routes never answer an OPTIONS preflight:\n  ${missing.join("\n  ")}`);
});

test("every exported API handler is wrapped", () => {
  const offenders = [];
  for (const file of routeFiles()) {
    const source = readFileSync(file, "utf8");
    // A bare `export async function GET` means the handler bypasses the
    // wrapper, which is exactly the shape this migration removed.
    if (/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/.test(source)) {
      offenders.push(`${file} exports a handler directly instead of via withCors`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n  "));
});

/* ------------------------------------------------------------------------ */

const ORIGINS = "ACCOUNTS_ALLOWED_ORIGINS";
const FLAG = "ACCOUNTS_ENABLED";

function withEnv(env, fn) {
  const saved = { [FLAG]: process.env[FLAG], [ORIGINS]: process.env[ORIGINS] };
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/*
  withEnv restores the environment the instant its callback *returns* — fine
  when the callback is synchronous, but withCors's response only resolves
  after an await, so restoring on return would undo the environment before
  the handler inside ever reads it.
*/
async function withEnvAsync(env, fn) {
  const saved = { [FLAG]: process.env[FLAG], [ORIGINS]: process.env[ORIGINS] };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function req(origin) {
  return new Request("https://bandup.test/api/define", {
    headers: origin ? { origin } : {},
  });
}

test("with accounts off, nothing is granted to anyone", () => {
  withEnv({ [FLAG]: "", [ORIGINS]: "capacitor://localhost" }, () => {
    assert.deepEqual(corsHeaders(req("capacitor://localhost")), {});
    const res = OPTIONS(req("capacitor://localhost"));
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });
});

test("an allowed origin is granted, and told the answer varies by origin", () => {
  withEnv({ [FLAG]: "1", [ORIGINS]: "capacitor://localhost,https://localhost" }, () => {
    const headers = corsHeaders(req("capacitor://localhost"));
    assert.equal(headers["Access-Control-Allow-Origin"], "capacitor://localhost");
    // Without Vary, a shared cache could hand one origin's grant to another.
    assert.equal(headers["Vary"], "Origin");

    const preflight = OPTIONS(req("capacitor://localhost"));
    assert.equal(
      preflight.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    // corsHeaders() and OPTIONS() build their headers from two separate
    // object literals, so the Vary assertion above says nothing about this one.
    assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Content-Type, Authorization");
    assert.equal(preflight.headers.get("Access-Control-Max-Age"), "600");
    assert.equal(preflight.headers.get("Vary"), "Origin");
  });
});

test("an origin that is not on the list gets nothing", () => {
  withEnv({ [FLAG]: "1", [ORIGINS]: "capacitor://localhost" }, () => {
    assert.deepEqual(corsHeaders(req("https://evil.example")), {});
    const res = OPTIONS(req("https://evil.example"));
    // 204 and no grant, rather than an error that would confirm the list.
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });
});

test("matching is exact, so a lookalike domain cannot slip in", () => {
  withEnv({ [FLAG]: "1", [ORIGINS]: "https://bandup.example" }, () => {
    // The failure a startsWith/endsWith test would have let through.
    assert.equal(allowedOrigin("https://bandup.example.evil.test"), null);
    assert.equal(allowedOrigin("https://evil-bandup.example"), null);
    assert.equal(allowedOrigin("https://bandup.example"), "https://bandup.example");
  });
});

test("a trailing slash on either side still matches", () => {
  withEnv({ [FLAG]: "1", [ORIGINS]: "https://bandup.example/" }, () => {
    assert.equal(allowedOrigin("https://bandup.example"), "https://bandup.example");
  });
});

test("a trailing slash on the caller's origin matches too, not only the configured side", () => {
  // The test above strips the slash from the configured entry; this is the
  // same strip applied to what the caller actually sent, a separate line.
  withEnv({ [FLAG]: "1", [ORIGINS]: "https://bandup.example" }, () => {
    assert.equal(allowedOrigin("https://bandup.example/"), "https://bandup.example");
  });
});

test("incidental whitespace around a configured origin does not stop it matching", () => {
  withEnv({ [FLAG]: "1", [ORIGINS]: " https://bandup.example ,https://other.example" }, () => {
    assert.equal(allowedOrigin("https://bandup.example"), "https://bandup.example");
  });
});

test("a blank entry from a stray comma is never itself treated as a configured origin", () => {
  // "/" is the one origin that normalises to "" (the trailing-slash strip
  // removes its only character). A config value that is nothing but a comma
  // must not let that "" through as if it had been a real allowed origin.
  withEnv({ [FLAG]: "1", [ORIGINS]: "," }, () => {
    assert.equal(allowedOrigin("/"), null);
  });
});

test("no configured origins grants nothing, even with the flag on", () => {
  withEnv({ [FLAG]: "1", [ORIGINS]: "" }, () => {
    assert.equal(allowedOrigin("https://bandup.example"), null);
  });
});

test("a request with no Origin header is not granted anything", () => {
  withEnv({ [FLAG]: "1", [ORIGINS]: "https://bandup.example" }, () => {
    assert.deepEqual(corsHeaders(req(null)), {});
  });
});

/*
  Nothing above calls withCors itself — every other test reaches corsHeaders
  or OPTIONS directly. Those two computing the right grant says nothing about
  whether the wrapper actually copies it onto the route handler's response.
*/
test("withCors copies the grant onto the wrapped handler's own response", async () => {
  await withEnvAsync({ [FLAG]: "1", [ORIGINS]: "capacitor://localhost" }, async () => {
    const handler = async () => new Response("ok");
    const res = await withCors(handler)(req("capacitor://localhost"));
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "capacitor://localhost");
    assert.equal(res.headers.get("Vary"), "Origin");
  });
});

test("withCors adds nothing when the caller's origin earns no grant", async () => {
  await withEnvAsync({ [FLAG]: "1", [ORIGINS]: "capacitor://localhost" }, async () => {
    const handler = async () => new Response("ok");
    const res = await withCors(handler)(req("https://evil.example"));
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });
});
