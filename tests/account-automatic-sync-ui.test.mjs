import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

test("account progress sync has no manual destination or button", () => {
  const account = read("components/AccountPanel.tsx");
  const icons = read("components/CardIcon.tsx");

  assert.doesNotMatch(account, /\/account\/sync|Practice on other devices|icon: "sync"/);
  assert.doesNotMatch(icons, /"sync"|\bsync:/);
  assert.equal(existsSync(join(process.cwd(), "app", "account", "sync", "page.tsx")), false);
  assert.equal(existsSync(join(process.cwd(), "components", "account", "SyncSection.tsx")), false);
});

test("removing the manual control leaves automatic sync mounted", () => {
  const layout = read("app/layout.tsx");
  const autoSync = read("components/AutoSync.tsx");

  assert.match(layout, /<AutoSync\s*\/>/);
  assert.match(autoSync, /useSyncExternalStore\(subscribe, getSnapshot, getServerSnapshot\)/);
  assert.match(autoSync, /if \(accessToken\) flushProgressSync\(\)/);
  assert.match(autoSync, /PROGRESS_WRITE_EVENT/);
  assert.match(autoSync, /scheduleSync\(\)/);
  assert.match(autoSync, /addEventListener\("online", onOnline\)/);
  assert.match(autoSync, /addEventListener\("visibilitychange", onVisible\)/);
  assert.match(autoSync, /const onVisible = \(\) => \{[\s\S]*flushProgressSync\(\)/);
  assert.match(
    autoSync,
    /Hidden:[\s\S]*last attempt before background throttling[\s\S]*Visible:[\s\S]*reconcile/,
  );
  assert.match(autoSync, /else cancelScheduledSync\(\)/);
});
