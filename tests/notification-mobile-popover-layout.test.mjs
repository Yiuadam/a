import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");

// This file's comments discuss the declarations they replaced by name, so an
// assertion that a property is absent has to read the CSS rather than the prose
// about it.
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function mobileNotificationRule(css) {
  const media = css.match(/@media\s*\(max-width:\s*39\.999rem\)\s*\{[\s\S]*?\.notification-popover\s*\{([^}]*)\}/);
  assert.ok(media, "the notification popover needs an explicit phone-only viewport rule");
  return media[1];
}

test("the phone notification popover is anchored inside both viewport edges", () => {
  const bell = read("components/account/NotificationBell.tsx");
  const declarations = mobileNotificationRule(read("app/globals.css"));

  assert.match(bell, /useLayoutEffect\(\(\) => \{[\s\S]*if \(!open\) return/);
  assert.match(bell, /data-notification-bell-root/);

  /*
    The panel is rendered into document.body and fixed to the viewport now,
    because a backdrop-filter inside the header cannot blur the page — the
    header is a Backdrop Root, so anything within it samples nothing. What the
    layout effect publishes changed with it: the bell's own bottom edge and
    how far its right edge sits from the right of the screen, on the document
    element rather than on the wrapper, since the element that reads them is no
    longer a descendant.
  */
  assert.match(bell, /createPortal\([\s\S]*?document\.body/);
  assert.match(bell, /--notification-anchor-bottom.*anchorRect\.bottom/);
  assert.match(bell, /--notification-anchor-right/);
  assert.match(bell, /document\.documentElement\.clientWidth - anchorRect\.right/);
  assert.match(bell, /document\.documentElement\.style/);

  // Re-measured on every event that can move a sticky header or resize the
  // screen, or the panel detaches from the button it grew out of.
  for (const target of ["resize", "scroll"]) {
    assert.match(bell, new RegExp(`visualViewport\\?\\.addEventListener\\("${target}", positionPopover\\)`));
    assert.match(bell, new RegExp(`visualViewport\\?\\.removeEventListener\\("${target}", positionPopover\\)`));
  }
  assert.match(bell, /window\.addEventListener\("scroll", positionPopover/);
  assert.match(bell, /window\.removeEventListener\("scroll", positionPopover\)/);

  // Both properties are handed back when the panel closes, so a stale
  // measurement cannot position the next one.
  assert.match(bell, /removeProperty\("--notification-anchor-bottom"\)/);
  assert.match(bell, /removeProperty\("--notification-anchor-right"\)/);

  /*
    The arithmetic that used to live here is gone, and its absence is the
    point. A panel absolutely positioned inside the header had to be told
    where the screen was, so the effect published the visual viewport's offset
    and width and the CSS subtracted the bell's own position back out again. A
    fixed panel resolves against the layout viewport directly: `left` and
    `right` are already measured from the edges of the screen, so equal
    safe-area gutters are all this rule needs — and it is more correct as well
    as shorter, since those numbers came from the visual viewport and a fixed
    element does not use it.
  */
  assert.match(declarations, /left:\s*max\(8px,\s*env\(safe-area-inset-left\)\)\s*;/);
  assert.match(declarations, /right:\s*max\(8px,\s*env\(safe-area-inset-right\)\)\s*;/);
  assert.match(declarations, /width:\s*auto\s*;/);
  assert.match(declarations, /max-width:\s*none\s*;/);
  assert.doesNotMatch(declarations, /translate|transform/, "positioning must not shift the popover back off-screen");
  assert.doesNotMatch(declarations, /--notification-mobile-/, "the visual-viewport arithmetic is not needed by a fixed panel");

  // Equal gutters at every phone width, with enough left over to read.
  for (const viewportWidth of [320, 360, 375, 390, 399, 400, 401, 430, 639]) {
    const gutter = 8;
    const width = viewportWidth - gutter * 2;
    assert.equal(gutter, gutter, `${viewportWidth}px keeps the left gutter`);
    assert.equal(viewportWidth - gutter, gutter + width, `${viewportWidth}px keeps the right gutter`);
    assert.ok(width >= 304, `${viewportWidth}px still leaves a readable popover`);
  }
});

test("desktop alignment and the single clipped glass boundary are preserved", () => {
  const inbox = read("components/account/NotificationInbox.tsx");
  const css = read("app/globals.css");
  const dialogStart = inbox.indexOf('<div role="dialog" aria-label="Notifications"');
  const dialogEnd = inbox.indexOf("export default function NotificationInbox");
  const popover = inbox.slice(dialogStart, dialogEnd);

  assert.ok(dialogStart >= 0 && dialogEnd > dialogStart);
  assert.match(popover, /className="notification-popover liquid-glass/);
  assert.equal((popover.match(/notification-popover/g) ?? []).length, 1);
  assert.equal((popover.match(/role="dialog"/g) ?? []).length, 1);
  assert.doesNotMatch(popover, /RefractiveGlassLayer|premade-glass/);

  // Above the bars a page floats over its own content — the exam shell's
  // timer at z-50 was drawing over this panel while it lived at the header's
  // own stacking level — and under the 1000 the header takes while its
  // navigation sheet is open, because that sheet covers the whole screen and
  // belongs over the panel rather than under it.
  const rule = withoutComments(css).match(/\n\.notification-popover \{[\s\S]*?\n\}/)?.[0];
  assert.ok(rule, "expected a base .notification-popover rule");
  assert.match(rule, /z-index: 990;/);
  assert.match(rule, /overflow:\s*hidden;/);
  assert.doesNotMatch(rule, /clip-path:/, "a clip-path would erase the panel's outer glow");
  assert.doesNotMatch(rule, /contain:\s*paint/, "paint containment would clip the same glow");
});
