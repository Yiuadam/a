import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

test("the shared loading indicator is accessible and respects reduced motion", () => {
  const source = read("components", "LoadingIndicator.tsx");
  assert.match(source, /role: "status"/);
  assert.match(source, /"aria-live": "polite"/);
  assert.match(source, /aria-hidden="true"/);
  assert.match(source, /motion-safe:animate-spin/);
  assert.match(source, /motion-reduce:animate-none/);
});

test("major account, practice, organisation and admin loading states use one indicator", () => {
  for (const path of [
    ["components", "account", "AccountIdentityForm.tsx"],
    ["components", "account", "DangerSection.tsx"],
    ["components", "account", "NotificationInbox.tsx"],
    ["components", "TutorChat.tsx"],
    ["app", "practice", "page.tsx"],
    ["app", "practice", "writing", "page.tsx"],
    ["components", "speaking", "SpeakingSession.tsx"],
    ["components", "exam", "MockResults.tsx"],
    ["components", "organization", "OrganizationPortal.tsx"],
    ["components", "organization", "StudentHistoryPage.tsx"],
    ["app", "admin", "page.tsx"],
  ]) {
    assert.match(read(...path), /LoadingIndicator/, path.join("/"));
  }
});

test("busy buttons keep their written status alongside the animation", () => {
  const identity = read("components", "account", "AccountIdentityForm.tsx");
  const deletion = read("components", "account", "DangerSection.tsx");
  const practice = read("app", "practice", "page.tsx");
  assert.match(identity, /LoadingIndicator label="Saving…"/);
  assert.match(deletion, /LoadingIndicator label="Deleting securely…"/);
  assert.match(practice, /LoadingIndicator label="Generating \(about a minute\)…"/);
});
