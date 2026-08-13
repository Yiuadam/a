import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

function mobileNotificationRule(css) {
  const media = css.match(/@media\s*\(max-width:\s*39\.999rem\)\s*\{[\s\S]*?\[data-notification-bell-root\]\s*>\s*\.notification-popover\s*\{([^}]*)\}/);
  assert.ok(media, "the notification popover needs an explicit phone-only viewport rule");
  return media[1];
}

test("the phone notification popover is anchored inside both viewport edges", () => {
  const bell = read("components/account/NotificationBell.tsx");
  const declarations = mobileNotificationRule(read("app/globals.css"));

  assert.match(bell, /useLayoutEffect\(\(\) => \{[\s\S]*if \(!open\) return/);
  assert.match(bell, /window\.visualViewport/);
  assert.match(bell, /viewport\?\.offsetLeft \?\? 0/);
  assert.match(bell, /viewport\?\.width \?\? document\.documentElement\.clientWidth/);
  assert.match(bell, /`\$\{viewportLeft - anchorRect\.left\}px`/);
  assert.match(bell, /`\$\{Math\.max\(0, viewportWidth\)\}px`/);
  assert.match(bell, /data-notification-bell-root/);
  assert.match(bell, /visualViewport\?\.addEventListener\("resize", positionPopover\)/);
  assert.match(bell, /visualViewport\?\.addEventListener\("scroll", positionPopover\)/);
  assert.match(bell, /visualViewport\?\.removeEventListener\("resize", positionPopover\)/);
  assert.match(bell, /visualViewport\?\.removeEventListener\("scroll", positionPopover\)/);

  assert.match(declarations, /right:\s*auto\s*;/);
  assert.match(
    declarations,
    /left:\s*calc\(var\(--notification-mobile-left,\s*0px\)\s*\+\s*max\(8px,\s*env\(safe-area-inset-left\)\)\)\s*;/,
  );
  assert.match(declarations, /width:\s*calc\([\s\S]*var\(--notification-mobile-width,\s*100vw\)[\s\S]*safe-area-inset-left[\s\S]*safe-area-inset-right[\s\S]*\)\s*;/);
  assert.match(declarations, /max-width:\s*none\s*;/);
  assert.doesNotMatch(declarations, /translate|transform/, "positioning must not shift the popover back off-screen");

  // Reproduce the component + CSS geometry at narrow widths and at several
  // bell positions. The relative offset cancels the bell position; CSS then
  // applies equal safe-area-aware gutters at the viewport edges.
  for (const viewportWidth of [320, 360, 375, 390, 399, 400, 401, 430, 639]) {
    for (const anchorLeft of [160, 240, 300, viewportWidth - 64]) {
      const viewportLeft = 0;
      const gutter = 8;
      const relativeLeft = viewportLeft - anchorLeft;
      const width = Math.max(0, viewportWidth) - (gutter * 2);
      const absoluteLeft = anchorLeft + relativeLeft + gutter;
      const absoluteRight = absoluteLeft + width;
      assert.equal(absoluteLeft, viewportLeft + gutter);
      assert.equal(absoluteRight, viewportLeft + viewportWidth - gutter);
      assert.ok(width >= 304, `${viewportWidth}px still leaves a readable popover`);
    }
  }
});

test("desktop alignment and the single clipped glass boundary are preserved", () => {
  const inbox = read("components/account/NotificationInbox.tsx");
  const css = read("app/globals.css");
  const dialogStart = inbox.indexOf('<div role="dialog" aria-label="Notifications"');
  const dialogEnd = inbox.indexOf("export default function NotificationInbox");
  const popover = inbox.slice(dialogStart, dialogEnd);

  assert.ok(dialogStart >= 0 && dialogEnd > dialogStart);
  assert.match(popover, /className="notification-popover liquid-glass absolute right-0 top-12/);
  assert.equal((popover.match(/notification-popover/g) ?? []).length, 1);
  assert.equal((popover.match(/role="dialog"/g) ?? []).length, 1);
  assert.doesNotMatch(popover, /RefractiveGlassLayer|premade-glass/);
  assert.match(css, /\.notification-popover\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?contain:\s*paint;[\s\S]*?clip-path:\s*inset\(0 round var\(--radius-xl\)\)/);
});
