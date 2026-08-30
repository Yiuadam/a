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
  plan: "pro",
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
