import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const client = await import(pathToFileURL(join(process.cwd(), "lib", "notifications", "client.ts")).href);

const notification = (overrides = {}) => ({
  id: "notice-1",
  type: "practice_assigned",
  createdAt: "2026-08-13T10:00:00.000Z",
  readAt: null,
  actor: { displayName: "Ms Wong", username: "ms-wong" },
  organization: { id: "org-1", name: "Harbour English Academy" },
  assignment: {
    id: "assignment-1",
    title: "Reading: Matching headings",
    practiceKind: "reading",
    practiceId: "reading-4",
    dueAt: "2026-08-18T10:00:00.000Z",
  },
  requestKind: null,
  actionPath: "/organization?section=assignments",
  ...overrides,
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

test("notification links remain same-origin relative paths", () => {
  assert.equal(client.safeNotificationActionPath("/organization?section=assignments"), "/organization?section=assignments");
  assert.equal(client.safeNotificationActionPath("https://attacker.example/steal"), null);
  assert.equal(client.safeNotificationActionPath("//attacker.example/steal"), null);
  assert.equal(client.safeNotificationActionPath("/\\attacker.example"), null);
  assert.equal(
    client.notificationPathForPreview("/organization?section=assignments", "student"),
    "/organization?section=assignments&preview=student",
  );
  assert.equal(
    client.notificationPathForPreview(
      "/practice/reading/reading-4?assignment=assignment-1&from=notification#question-7",
      "student",
    ),
    "/practice/reading/reading-4?assignment=assignment-1&from=notification&preview=student#question-7",
    "the exact notification target survives preview decoration",
  );
  assert.equal(
    client.notificationActionDestination(
      "/organization?organization=org-1&section=requests&request=request-1&focus=request&requestKind=join",
      "manager",
    ),
    "/organization?organization=org-1&section=requests&request=request-1&focus=request&requestKind=join&preview=manager",
    "a same-path navigation keeps every query value needed to focus the request",
  );
  assert.equal(
    client.notificationActionDestination("javascript:alert(1)", "manager"),
    null,
  );
});

test("notification wording is derived from typed data rather than server HTML", () => {
  assert.deepEqual(client.notificationCopy(notification()), {
    title: "New practice assigned",
    body: "Ms Wong assigned “Reading: Matching headings” in Harbour English Academy.",
    actionLabel: "Open practice",
    attentionLabel: "To do",
  });
  assert.deepEqual(client.notificationCopy(notification({ type: "teacher_feedback" })), {
    title: "New teacher feedback",
    body: "Ms Wong added feedback for “Reading: Matching headings”.",
    actionLabel: "Read feedback",
    attentionLabel: "Review",
  });
  assert.deepEqual(client.notificationCopy(notification({ type: "assignment_completed" })), {
    title: "Assignment completed",
    body: "Ms Wong completed “Reading: Matching headings”.",
    actionLabel: "Review sitting",
    attentionLabel: "Ready to review",
  });
  assert.deepEqual(client.notificationCopy(notification({ type: "organization_request" })), {
    title: "Organisation request update",
    body: "Ms Wong has an update waiting in Harbour English Academy.",
    actionLabel: "Review request",
    attentionLabel: "Decision needed",
  });
  assert.deepEqual(client.notificationCopy(notification({ type: "organization_request", requestKind: "join" })), {
    title: "Join request",
    body: "Ms Wong wants to join Harbour English Academy.",
    actionLabel: "Review join request",
    attentionLabel: "Decision needed",
  });
  assert.deepEqual(client.notificationCopy(notification({ type: "organization_invitation" })), {
    title: "Organisation invitation",
    body: "You have been invited to join Harbour English Academy.",
    actionLabel: "Review invitation",
    attentionLabel: "Response needed",
  });
});

test("notification responses are decoded and preview identity stays in a header", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/account/notifications?limit=5");
    assert.equal(new Headers(init?.headers).get("x-bandup-organization-preview-role"), "student");
    return new Response(JSON.stringify({
      notifications: [
        notification({ actionPath: "https://attacker.example/steal" }),
        notification({ id: "unknown", type: "server_html" }),
      ],
      unreadCount: 1,
      nextCursor: "2026-08-13T10:00:00.000Z~notice-1",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await client.fetchNotifications(5, { previewRole: "student" });
    assert.equal(result.unreadCount, 1);
    assert.equal(result.notifications.length, 1);
    assert.equal(result.notifications[0].actionPath, null);
    assert.equal(result.nextCursor, "2026-08-13T10:00:00.000Z~notice-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a notification read receipt survives navigation away from the page", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/account/notifications");
    assert.equal(init?.method, "POST");
    assert.equal(init?.keepalive, true);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      action: "mark_read",
      notificationId: "notice-1",
    });
    return new Response(JSON.stringify({ ok: true, unreadCount: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    assert.deepEqual(await client.markNotificationRead("notice-1"), { ok: true, unreadCount: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview read state is browser-local, survives reload and leaves later notifications new", () => {
  const storage = memoryStorage();
  const first = notification();
  const second = notification({
    id: "notice-2",
    createdAt: "2026-08-13T11:00:00.000Z",
    actionPath: null,
  });
  const readAt = "2026-08-13T12:00:00.000Z";

  client.rememberPreviewNotificationRead(first, "student", readAt, storage);
  const reloaded = client.applyPreviewNotificationReadState({
    notifications: [second, first],
    unreadCount: 2,
    nextCursor: null,
  }, "student", { storage, completeSnapshot: true });

  assert.equal(reloaded.unreadCount, 1);
  assert.equal(reloaded.notifications.find((item) => item.id === first.id).readAt, readAt);
  assert.equal(reloaded.notifications.find((item) => item.id === second.id).readAt, null);
  assert.equal(
    JSON.parse(storage.getItem(client.previewNotificationReadStorageKey("student"))).records.length,
    1,
  );

  const next = notification({ id: "notice-3", createdAt: "2026-08-13T13:00:00.000Z" });
  const withNext = client.applyPreviewNotificationReadState({
    notifications: [next, second, first],
    unreadCount: 3,
    nextCursor: null,
  }, "student", { storage, completeSnapshot: true });
  assert.equal(withNext.unreadCount, 2);
  assert.equal(withNext.notifications[0].readAt, null, "a later unseen notification stays new");

  const otherRole = client.applyPreviewNotificationReadState({
    notifications: [first], unreadCount: 1, nextCursor: null,
  }, "teacher", { storage, completeSnapshot: true });
  assert.equal(otherRole.unreadCount, 1, "preview roles do not share browser read state");
});

test("a complete preview snapshot drops stale markers instead of hiding a replaced notification", () => {
  const storage = memoryStorage();
  client.rememberPreviewNotificationRead(notification(), "manager", "2026-08-13T12:00:00.000Z", storage);
  const replacement = notification({ id: "replacement", createdAt: "2026-08-14T10:00:00.000Z" });
  const result = client.applyPreviewNotificationReadState({
    notifications: [replacement], unreadCount: 1, nextCursor: null,
  }, "manager", { storage, completeSnapshot: true });
  assert.equal(result.unreadCount, 1);
  assert.equal(result.notifications[0].readAt, null);
  assert.deepEqual(
    JSON.parse(storage.getItem(client.previewNotificationReadStorageKey("manager"))).records,
    [],
  );
});

test("bell and full inbox keep refresh, read controls and setup reminder", () => {
  const bell = readFileSync(join(process.cwd(), "components", "account", "NotificationBell.tsx"), "utf8");
  const inbox = readFileSync(join(process.cwd(), "components", "account", "NotificationInbox.tsx"), "utf8");
  const page = readFileSync(join(process.cwd(), "app", "notifications", "page.tsx"), "utf8");
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.match(bell, /fetchNotifications\(previewRole \? 50 : 1, \{ previewRole/);
  assert.match(bell, /displayedNotificationUnread \+ \(needsSetup \? 1 : 0\)/);
  assert.match(bell, /dynamic\([\s\S]*NotificationPopover/);
  assert.match(bell, /className="relative isolate"/);
  assert.match(bell, /<\/button>[\s\S]*z-\[1200\][\s\S]*<NotificationPopover/);
  assert.match(bell, /open && <span className="notification-glass-backdrop" aria-hidden="true" \/>/);
  assert.match(bell, /data-notification-bell-root/);
  assert.match(bell, /useLayoutEffect\(\(\) => \{[\s\S]*--notification-mobile-left[\s\S]*--notification-mobile-width/);
  assert.match(bell, /window\.visualViewport\?\.addEventListener\("resize", positionPopover\)/);
  assert.match(css, /@media \(max-width: 39\.999rem\) \{[\s\S]*\[data-notification-bell-root\] > \.notification-popover \{[\s\S]*left: calc\(var\(--notification-mobile-left, 0px\) \+ max\(8px, env\(safe-area-inset-left\)\)\);[\s\S]*width: calc\([\s\S]*--notification-mobile-width[\s\S]*safe-area-inset-left[\s\S]*safe-area-inset-right/);
  assert.doesNotMatch(css, /\[data-notification-bell-root\] > \.notification-popover \{[\s\S]{0,300}position:\s*fixed/);
  assert.match(css, /\.notification-glass-backdrop \{[\s\S]*?inset: var\(--header-h, 0px\) 0 0;[\s\S]*?pointer-events: none;[\s\S]*?blur\(20px\)/);
  assert.match(inbox, /document\.hidden/);
  assert.match(inbox, /visibilitychange/);
  assert.match(inbox, /window\.setInterval\(\(\) => void load\(\), 60_000\)/);
  assert.match(inbox, /window\.addEventListener\("focus"/);
  assert.match(inbox, /markNotificationRead/);
  assert.match(inbox, /rememberPreviewNotificationRead/);
  assert.match(inbox, /withNotificationRead/);
  assert.match(inbox, /rollbackNotificationRead/);
  assert.match(inbox, /markAllNotificationsRead/);
  assert.match(inbox, /<a[\s\S]*href=\{destination\}[\s\S]*aria-label=\{`\$\{copy\.title\}\. \$\{copy\.actionLabel\}`\}/);
  assert.match(inbox, /Information only/);
  assert.match(inbox, /Mark as read/);
  assert.doesNotMatch(inbox, /router\.push/);
  assert.match(inbox, /void markNotificationRead\(item\.id\)[\s\S]*\.catch/);
  assert.match(inbox, /<ProfileReminder/);
  assert.match(inbox, /View all notifications/);
  assert.match(inbox, /Load earlier notifications/);
  assert.match(inbox, /if \(!item\.readAt\)/);
  assert.match(inbox, /feed\.unreadCount > 0 && !previewRole/);
  assert.match(page, /<NotificationInbox previewRole=\{previewRole\}/);
});

test("action navigation stays native and does not wait for read-state mutation", () => {
  const inbox = readFileSync(join(process.cwd(), "components", "account", "NotificationInbox.tsx"), "utf8");
  const rowStart = inbox.indexOf("function NotificationRow");
  const rowEnd = inbox.indexOf("function ProfileReminder");
  const row = inbox.slice(rowStart, rowEnd);

  assert.match(row, /const destination = notificationActionDestination\(item\.actionPath, previewRole\)/);
  assert.match(row, /<a[\s\S]*href=\{destination\}[\s\S]*onClick=\{\(\) => onOpen\(item, true\)\}[\s\S]*data-notification-native-navigation/);
  assert.doesNotMatch(row, /preventDefault|router\.push|await markNotificationRead/);
  assert.match(inbox, /void markNotificationRead\(item\.id\)[\s\S]*\.catch/);
  assert.match(inbox, /if \(!navigating\) \{[\s\S]*rollbackNotificationRead/);
});

test("notification page keeps one compact title and one flowing filter lens", () => {
  const page = readFileSync(join(process.cwd(), "app", "notifications", "page.tsx"), "utf8");
  const inbox = readFileSync(join(process.cwd(), "components", "account", "NotificationInbox.tsx"), "utf8");
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const filterStart = inbox.indexOf("function NotificationFilter");
  const filterEnd = inbox.indexOf("export function NotificationPopover");
  const filter = inbox.slice(filterStart, filterEnd);

  assert.match(page, /<h1[^>]*>Notifications<\/h1>/);
  assert.match(page, /px-2 py-3/);
  assert.match(inbox, /max-w-5xl p-2 sm:p-4/);
  for (const redundant of [
    "Your updates",
    "Open assigned practice, revisit teacher feedback and keep up with your organisation.",
    "Your notifications",
    "Assignments, feedback and organisation activity in one place.",
    "Assignments, teacher feedback and organisation updates will appear here.",
  ]) {
    assert.doesNotMatch(`${page}\n${inbox}`, new RegExp(redundant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal((filter.match(/notification-filter-selector/g) ?? []).length, 1);
  /* One selector knob and no displacement pane behind it. The rail used to
     carry one; refraction came out of the whole site because it fogged the
     surfaces it covered, and the knob's own lens — small, and over backdrop it
     fully covers — is the only one left anywhere. */
  assert.doesNotMatch(filter, /RefractiveGlassLayer/);
  assert.match(filter, /--notification-filter-index/);
  // Draggable, but through the shared implementation rather than its own
  // copy — see lib/segmented-drag.ts and tests/segmented-controls.test.mjs.
  assert.match(filter, /useSegmentedDrag\(\{/);
  assert.match(filter, /\{\.\.\.drag\.handlers\}/);
  /* The knob's travel is the shared one now. This rule used to carry its own
     `translate3d(calc(var(--notification-filter-index) * 100%))`, alongside
     an identical copy in each of the other option bars; the geometry lives on
     .segmented-knob and this selector just says which stop it is on and how
     many there are. See tests/segmented-controls.test.mjs for the stride
     itself. */
  assert.match(css, /\.notification-filter-selector \{[\s\S]*?--segmented-index: var\(--notification-filter-index, 0\);/);
  assert.match(css, /\.notification-filter-selector \{[\s\S]*?--segmented-count: 2;/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*\.notification-filter-option,[\s\S]*min-height: 2\.75rem/);
  /* Reduced motion is honoured through the shared knob too. This bar used to
     be the only one that stood its glide down, via its own copy of the rule
     near the top of the file — which stopped working the moment the shared
     rule declared a transition of its own, being earlier at equal
     specificity. Asserting the shared rule keeps the preference covered for
     all four bars rather than one. */
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.segmented-knob \{\n {4}transition: none;\n {4}will-change: auto;/);
});

test("dark notification actions keep explicit high-contrast text roles", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const inbox = readFileSync(
    join(process.cwd(), "components", "account", "NotificationInbox.tsx"),
    "utf8",
  );

  assert.match(inbox, /notification-row-copy/);
  assert.match(inbox, /notification-row-meta/);
  assert.match(inbox, /notification-attention rounded-full/);
  assert.match(inbox, /notification-action/);
  assert.match(css, /html\[data-theme="dark"\] \.notification-attention \{[\s\S]*?border: 1px solid #e5e7eb;[\s\S]*?background: #d1d5db;[\s\S]*?color: #111113;/);
  assert.match(css, /html\[data-theme="dark"\] \.notification-action \{[\s\S]*?color: #e0e7ff;/);
  assert.match(css, /html\[data-theme="dark"\] \.notification-row-meta \{[\s\S]*?color: #d1d5db;/);
});
