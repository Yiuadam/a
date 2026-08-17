import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const load = (...parts) => import(pathToFileURL(join(process.cwd(), ...parts)).href);
const settings = await load("lib", "cloudflare", "app-settings.ts");
const parity = await load("lib", "cloudflare", "app-settings-parity.ts");

function runtimeD1(database) {
  const bound = (sql, values) => ({
    async run() {
      const result = database.prepare(sql).run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
    },
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
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of readdirSync(join(process.cwd(), "cloudflare", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "cloudflare", "migrations", file), "utf8"));
  }
  return { database, bindings: { db: runtimeD1(database), files: {} } };
}

const ACTOR = "10000000-0000-4000-8000-000000000001";
const OLD = "2026-08-14T08:00:00.000Z";
const NEW = "2026-08-14T09:00:00.000Z";

function seedActor(context) {
  context.database.prepare(`
    INSERT INTO app_users (id,email,role,created_at,updated_at)
    VALUES (?, 'owner@example.test', 'admin', ?, ?)
  `).run(ACTOR, OLD, OLD);
}

test("app-settings mirror is exact, idempotent and ordered by the Supabase clock", async () => {
  const context = fixture();
  seedActor(context);
  const oldRecord = {
    key: "maintenance",
    value: { at: OLD, closed: false },
    updatedAt: OLD,
    updatedBy: ACTOR,
  };
  const newRecord = {
    key: "maintenance",
    value: { closed: true, at: NEW },
    updatedAt: NEW,
    updatedBy: ACTOR,
  };

  assert.equal(await settings.putCloudflareAppSetting(oldRecord, context.bindings), true);
  assert.equal(await settings.putCloudflareAppSetting(newRecord, context.bindings), true);
  assert.equal(await settings.putCloudflareAppSetting(oldRecord, context.bindings), true);

  const stored = await settings.getCloudflareAppSetting("maintenance", context.bindings);
  assert.equal(stored.updatedAt, NEW);
  assert.equal(stored.updatedBy, ACTOR);
  assert.deepEqual(stored.value, newRecord.value);
  assert.equal(settings.appSettingRecordsEqual(newRecord, stored), true);
  assert.equal(settings.appSettingRecordsEqual(oldRecord, stored), false);
});

test("future Cloudflare authority bootstraps only the verified Supabase Auth actor", async () => {
  const context = fixture();
  const actor = { id: ACTOR, email: "owner@example.test", createdAt: OLD };
  const stored = await settings.setCloudflareAppSetting(
    "maintenance",
    { closed: false },
    actor,
    context.bindings,
  );
  assert.equal(stored.updatedBy, ACTOR);
  assert.equal(
    context.database.prepare("SELECT updated_by FROM app_settings WHERE key = 'maintenance'")
      .get().updated_by,
    ACTOR,
  );
  assert.equal(
    context.database.prepare("SELECT email FROM app_users WHERE id = ?").get(ACTOR).email,
    actor.email,
  );

  await assert.rejects(
    () => settings.putCloudflareAppSetting(
      { ...stored, updatedBy: "20000000-0000-4000-8000-000000000002" },
      context.bindings,
      actor,
    ),
    /does not match the verified session/,
  );
});

for (const mode of ["dual", "read_cloudflare"]) {
  test(`${mode}-mode report names exact drift and reconciliation removes target-only settings`, async () => {
    const context = fixture();
    seedActor(context);
    const source = {
      key: "maintenance",
      value: { closed: false, at: NEW },
      updatedAt: NEW,
      updatedBy: ACTOR,
    };
    await settings.putCloudflareAppSetting(source, context.bindings);
    await settings.putCloudflareAppSetting({
      key: "maintenance_dispatch",
      value: { stale: true },
      updatedAt: OLD,
      updatedBy: ACTOR,
    }, context.bindings);

    const previous = process.env.CLOUDFLARE_DATA_MODE;
    process.env.CLOUDFLARE_DATA_MODE = mode;
    const readSource = async (key) => key === "maintenance" ? source : null;
    try {
      const before = await parity.appSettingsParityReport(context.bindings, readSource);
      assert.equal(before.readyForAppSettingsCutover, false);
      assert.deepEqual(before.items.map((item) => [item.key, item.status]), [
        ["maintenance", "equal"],
        ["maintenance_dispatch", "target_only"],
      ]);
      // read_cloudflare reads app settings from D1 exactly as bare `cloudflare`
      // does; `dual` still reads Supabase. Either way the report's authority
      // label must match what readsFromCloudflare() actually decided.
      assert.equal(before.authority, mode === "read_cloudflare" ? "cloudflare" : "supabase");

      const after = await parity.reconcileAppSettingsReplica(context.bindings, readSource);
      assert.equal(after.readyForAppSettingsCutover, true);
      assert.deepEqual(after.items.map((item) => [item.key, item.status]), [
        ["maintenance", "equal"],
        ["maintenance_dispatch", "absent"],
      ]);
      assert.equal(
        context.database.prepare("SELECT count(*) AS total FROM app_settings").get().total,
        1,
      );
    } finally {
      if (previous === undefined) delete process.env.CLOUDFLARE_DATA_MODE;
      else process.env.CLOUDFLARE_DATA_MODE = previous;
    }
  });
}

test("reconciliation refuses to copy a retired Supabase authority forwards", async () => {
  const context = fixture();
  const previous = process.env.CLOUDFLARE_DATA_MODE;
  process.env.CLOUDFLARE_DATA_MODE = "cloudflare";
  try {
    await assert.rejects(
      () => parity.reconcileAppSettingsReplica(context.bindings, async () => null),
      /available only while writes are mirrored/,
    );
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_DATA_MODE;
    else process.env.CLOUDFLARE_DATA_MODE = previous;
  }
});

test("app settings are included in immutable migration evidence and runtime routing", () => {
  const migration = readFileSync(
    join(process.cwd(), "scripts", "migrate-supabase-to-cloudflare.mjs"),
    "utf8",
  );
  const runtime = readFileSync(join(process.cwd(), "lib", "admin", "settings.ts"), "utf8");
  const route = readFileSync(
    join(process.cwd(), "app", "api", "admin", "cloudflare", "app-settings", "route.ts"),
    "utf8",
  );

  const descriptor = migration.match(
    /source: "app_settings",[\s\S]*?source: "progress_snapshots"/,
  )?.[0] ?? "";
  assert.match(descriptor, /select: "key,value,updated_at,updated_by"/);
  assert.match(descriptor, /subjectUserIds: \(row\) => \[row\.updated_by\]/);
  assert.match(descriptor, /excluded\.source_updated_at >= app_settings\.source_updated_at/);

  const sourceWrite = runtime.indexOf('rpc<unknown>("set_app_setting"');
  const targetWrite = runtime.indexOf("putCloudflareAppSetting(record, undefined, actor)");
  assert.ok(sourceWrite >= 0 && targetWrite > sourceWrite, "dual/read_cloudflare writes must keep Supabase first");
  // writesToCloudflareOnly() is exactly `mode === "cloudflare"` today, but the
  // call site must ask the named question rather than re-derive it, so a
  // future state change to that predicate is not silently missed here too.
  assert.match(runtime, /writesToCloudflareOnly\(\)[\s\S]*setCloudflareAppSetting/);
  assert.match(route, /isAdminEmail/);
  // The reconciliation gate mirrors the widened thing it reconciles: it must
  // open for read_cloudflare exactly as it does for dual, not just dual.
  assert.match(route, /mirrorsWritesToCloudflare\(\)/);
});
