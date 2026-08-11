import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("../scripts/ts-resolve.mjs", import.meta.url);

const overview = await import(
  pathToFileURL(join(process.cwd(), "lib", "admin", "overview.ts")).href
);

const {
  ADMIN_OVERVIEW_CHART_IDS,
  ADMIN_OVERVIEW_STORAGE_KEY,
  defaultAdminOverviewPreference,
  parseAdminOverviewPreference,
  serializeAdminOverviewPreference,
} = overview;

test("the overview defaults to new accounts and AI requests", () => {
  assert.equal(ADMIN_OVERVIEW_STORAGE_KEY, "bandup.admin.overview.v1");
  assert.deepEqual(defaultAdminOverviewPreference(), {
    version: 1,
    slots: ["signups", "usage"],
  });
});

test("the stable registry has extension points for the two finance charts", () => {
  assert.deepEqual(ADMIN_OVERVIEW_CHART_IDS, [
    "signups",
    "usage",
    "net-receipts",
    "contribution",
  ]);
});

test("valid saved finance choices survive when those charts are available", () => {
  const saved = JSON.stringify({ version: 1, slots: ["net-receipts", "contribution"] });
  assert.deepEqual(parseAdminOverviewPreference(saved), {
    version: 1,
    slots: ["net-receipts", "contribution"],
  });
});

test("None can hide one or both slots without counting as a duplicate chart", () => {
  assert.deepEqual(
    parseAdminOverviewPreference(JSON.stringify({ version: 1, slots: ["none", "usage"] })),
    { version: 1, slots: ["none", "usage"] },
  );
  assert.deepEqual(
    parseAdminOverviewPreference(JSON.stringify({ version: 1, slots: ["none", "none"] })),
    { version: 1, slots: ["none", "none"] },
  );
});

test("duplicate charts, unknown ids and malformed storage reset together", () => {
  const fallback = { version: 1, slots: ["signups", "usage"] };
  const bad = [
    "not json",
    JSON.stringify({ version: 2, slots: ["signups", "usage"] }),
    JSON.stringify({ version: 1, slots: ["signups"] }),
    JSON.stringify({ version: 1, slots: ["signups", "signups"] }),
    JSON.stringify({ version: 1, slots: ["signups", "made-up"] }),
    JSON.stringify({ version: 1, slots: [3, "usage"] }),
  ];
  for (const raw of bad) assert.deepEqual(parseAdminOverviewPreference(raw), fallback, raw);
});

test("a stored chart not offered by this build cannot leave a blank chooser value", () => {
  const available = ["signups", "usage"];
  const saved = JSON.stringify({ version: 1, slots: ["signups", "net-receipts"] });
  assert.deepEqual(parseAdminOverviewPreference(saved, available), {
    version: 1,
    slots: ["signups", "usage"],
  });
});

test("serialisation keeps only the version and the two slots", () => {
  const raw = serializeAdminOverviewPreference({
    version: 1,
    slots: ["contribution", "none"],
  });
  assert.deepEqual(JSON.parse(raw), {
    version: 1,
    slots: ["contribution", "none"],
  });
});

test("the chooser is wired to both browser sync paths and an accessible dialog", () => {
  const component = readFileSync(
    join(process.cwd(), "components", "admin", "AdminOverviewCharts.tsx"),
    "utf8",
  );
  const store = readFileSync(join(process.cwd(), "lib", "admin", "overview.ts"), "utf8");
  const page = readFileSync(join(process.cwd(), "app", "admin", "page.tsx"), "utf8");
  const privacy = readFileSync(join(process.cwd(), "app", "privacy", "page.tsx"), "utf8");

  assert.match(page, /<AdminOverviewCharts options=\{overviewCharts\}/);
  assert.match(component, /role="dialog"/);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /aria-haspopup="dialog"/);
  assert.match(store, /addEventListener\("storage"/);
  assert.match(store, /addEventListener\(ADMIN_OVERVIEW_EVENT/);
  assert.match(privacy, /ADMIN_OVERVIEW_STORAGE_KEY/);
  assert.match(privacy, /For a site administrator only/);
});
