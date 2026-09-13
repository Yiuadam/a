import assert from "node:assert/strict";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const directory = await import(
  pathToFileURL(join(process.cwd(), "lib", "cloudflare", "admin-directory.ts")).href
);

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "learner@example.com",
  username: "learner.one",
  display_name: "Learner One",
  account_kind: "student",
  registered_at: "2026-08-28T00:00:00.000Z",
  plan: "ai",
  access_source: "stripe",
  organization_seat_count: 2,
  usage_30d: 7,
  total_count: 3,
};

function bindings({ detail = row, page = [row], usage = [] } = {}) {
  const prepared = [];
  return {
    prepared,
    bindings: {
      db: {
        prepare(query) {
          return {
            bind(...values) {
              const statement = {
                query,
                values,
                first: async () => detail,
                all: async () => ({ results: query.includes("GROUP BY route") ? usage : page }),
              };
              prepared.push(statement);
              return statement;
            },
          };
        },
      },
    },
  };
}

test("Cloudflare directory pages bind search text and return only D1 fields", async () => {
  const fixture = bindings();
  const maliciousLookingQuery = "x%' OR 1=1 --";
  const page = await directory.cloudflareAdminDirectoryPage({
    query: maliciousLookingQuery,
    limit: 10_000,
    offset: -10,
  }, fixture.bindings);

  assert.deepEqual(page, {
    users: [{
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.display_name,
      accountKind: row.account_kind,
      registeredAt: row.registered_at,
      plan: row.plan,
      accessSource: row.access_source,
      organizationSeatCount: 2,
      usage30d: 7,
      totalCount: 3,
    }],
    total: 3,
  });
  assert.equal(fixture.prepared.length, 1);
  assert.match(fixture.prepared[0].query, /FROM app_users u/);
  assert.match(fixture.prepared[0].query, /LIKE '%' \|\| lower\(\?\) \|\| '%'/);
  assert.doesNotMatch(fixture.prepared[0].query, /x%' OR 1=1/);
  assert.equal(fixture.prepared[0].values.filter((value) => value === maliciousLookingQuery).length, 4);
  assert.equal(fixture.prepared[0].values.at(-2), 100, "page size is bounded");
  assert.equal(fixture.prepared[0].values.at(-1), 0, "negative offsets are bounded");
});

test("Cloudflare directory details do not fabricate a missing account and group D1 usage", async () => {
  const fixture = bindings({
    usage: [
      { route: "chat", admitted: 4, refused: 1 },
      { route: "feedback", admitted: 2, refused: 0 },
    ],
  });
  const detail = await directory.cloudflareAdminDirectoryDetail(row.id, fixture.bindings);
  assert.equal(detail?.displayName, row.display_name);
  assert.deepEqual(detail?.usage, [
    { route: "chat", admitted: 4, refused: 1 },
    { route: "feedback", admitted: 2, refused: 0 },
  ]);
  assert.equal(fixture.prepared.length, 2);
  assert.match(fixture.prepared[1].query, /GROUP BY route/);
  assert.equal(await directory.cloudflareAdminDirectoryDetail("not-a-user", fixture.bindings), null);
});

test("Cloudflare directory preserves an empty page's total as zero", async () => {
  const fixture = bindings({ page: [] });
  const page = await directory.cloudflareAdminDirectoryPage({ query: "", limit: 50, offset: 0 }, fixture.bindings);
  assert.deepEqual(page, { users: [], total: 0 });
});

/*
  Runs `fn` with `globalThis.window` set to a plain object, so
  assertServerOnly(MODULE) throws the way it would if one of these
  server-only modules were ever pulled into a client bundle. Always deletes
  `window` again afterwards, pass or throw.
*/
async function withBrowserWindow(fn) {
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

test("assertServerOnly guards both directory entry points, naming this exact module", async () => {
  const fixture = bindings();
  await withBrowserWindow(async () => {
    await assert.rejects(
      () => directory.cloudflareAdminDirectoryPage({ query: "", limit: 10, offset: 0 }, fixture.bindings),
      /lib\/cloudflare\/admin-directory\.ts is server-only/,
    );
    await assert.rejects(
      () => directory.cloudflareAdminDirectoryDetail(row.id, fixture.bindings),
      /lib\/cloudflare\/admin-directory\.ts is server-only/,
    );
  });
});

test("a non-finite limit or offset is bounded to its minimum rather than propagated as NaN", async () => {
  const fixture = bindings();
  await directory.cloudflareAdminDirectoryPage({ query: "", limit: NaN, offset: Infinity }, fixture.bindings);
  const values = fixture.prepared[0].values;
  assert.equal(values.at(-2), 1, "a non-finite limit must fall back to the page-size minimum, not NaN");
  assert.equal(values.at(-1), 0, "a non-finite offset must fall back to the offset minimum, not NaN");
});

test("an unmirrored plan and access source fall back to the exact 'free'/'default' text", async () => {
  const bareRow = { ...row, plan: null, access_source: null };
  const fixture = bindings({ detail: bareRow, page: [bareRow] });
  const page = await directory.cloudflareAdminDirectoryPage({ query: "", limit: 10, offset: 0 }, fixture.bindings);
  assert.equal(page.users[0].plan, "free");
  assert.equal(page.users[0].accessSource, "default");
  const detail = await directory.cloudflareAdminDirectoryDetail(row.id, fixture.bindings);
  assert.equal(detail.plan, "free");
  assert.equal(detail.accessSource, "default");
});

test("the search query is trimmed and bounded to 120 characters before it is bound", async () => {
  const fixture = bindings();
  const padded = `  ${"q".repeat(130)}  `;
  await directory.cloudflareAdminDirectoryPage({ query: padded, limit: 10, offset: 0 }, fixture.bindings);
  const boundQuery = fixture.prepared[0].values[6]; // commonParameters: now x5, usageStart, query x4...
  assert.equal(boundQuery, "q".repeat(120), "the bound search text must be trimmed and cut to 120 characters");
});

test("cloudflareAdminDirectoryDetail's id shape is anchored at both ends, not merely a substring match", async () => {
  const fixture = bindings();
  const valid = "11111111-1111-4111-8111-111111111111";
  await assert.equal(await directory.cloudflareAdminDirectoryDetail(`!${valid}`, fixture.bindings), null,
    "a leading character outside the id shape must be rejected");
  await assert.equal(await directory.cloudflareAdminDirectoryDetail(`${valid}!`, fixture.bindings), null,
    "a trailing character outside the id shape must be rejected");
});

test("the 30-day usage window is bound as exactly 30 days before now, not a different arithmetic result", async () => {
  const fixture = bindings();
  const before = Date.now();
  await directory.cloudflareAdminDirectoryPage({ query: "", limit: 10, offset: 0 }, fixture.bindings);
  const after = Date.now();
  const usageStartBound = fixture.prepared[0].values[5]; // commonParameters: [now,now,now,now,now,usageStart,...]
  const usageStartMs = Date.parse(usageStartBound);
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  assert.ok(
    usageStartMs >= before - THIRTY_DAYS_MS - 1000 && usageStartMs <= after - THIRTY_DAYS_MS + 1000,
    `usage window start ${usageStartBound} is not ~30 days before now (got ${new Date(usageStartMs).toISOString()})`,
  );
});
