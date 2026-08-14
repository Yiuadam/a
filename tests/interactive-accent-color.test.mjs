import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function source(...parts) {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

test("account identity actions use the shared indigo accent, not warning amber", () => {
  const form = source("components", "account", "AccountIdentityForm.tsx");

  assert.match(form, /border-indigo-300\/70 bg-indigo-50\/75[^\n]+text-indigo-700/);
  assert.doesNotMatch(form, /amber/);
});

test("shared and administrative selection controls use one indigo accent", () => {
  const select = source("components", "GlassSelect.tsx");
  const overview = source("components", "admin", "AdminOverviewCharts.tsx");
  const finance = source("app", "admin", "finance", "page.tsx");
  const invitation = source("components", "organization", "InvitationAcceptance.tsx");

  assert.match(select, /border-indigo-500\/45 bg-indigo-100\/55/);
  assert.match(select, /font-semibold text-indigo-700">Selected/);
  assert.doesNotMatch(select, /option\.value === value \? "[^"]*amber/);

  assert.match(overview, /border-indigo-400 bg-indigo-50\/70/);
  assert.match(overview, /accent-indigo-600/);
  assert.doesNotMatch(overview, /focus-visible:outline-amber/);
  assert.doesNotMatch(finance, /focus-visible:outline-amber/);
  assert.match(invitation, /accent-indigo-600/);
  assert.doesNotMatch(invitation, /accent-\[#af6337\]/);
});

test("decorative heading highlights stay inside the accent ramp", () => {
  const css = source("app", "globals.css");
  const headingRule = css.match(/\.heading-rule::after \{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.match(headingRule, /var\(--color-indigo-400\)/);
  assert.match(headingRule, /var\(--color-indigo-600\)/);
  assert.doesNotMatch(headingRule, /amber/);
});

test("checkout follows indigo glass in Light and Dark while Warm keeps its own accent", () => {
  const css = source("app", "globals.css");
  const checkout = css.slice(css.indexOf("/* Warm keeps its softer checkout accent"), css.indexOf(".btn-secondary"));
  const themedCheckout = checkout.slice(checkout.indexOf('html[data-theme="light"]'));

  assert.match(checkout, /\.btn-primary\.pricing-subscribe-button \{[\s\S]*background: #c28f52/);
  assert.match(themedCheckout, /html\[data-theme="light"\] \.btn-primary\.pricing-subscribe-button/);
  assert.match(themedCheckout, /html\[data-theme="dark"\] \.btn-primary\.pricing-subscribe-button/);
  assert.match(themedCheckout, /var\(--color-indigo-100\)/);
  assert.match(themedCheckout, /var\(--glass-fill-strong\)/);
  assert.doesNotMatch(themedCheckout, /#c28f52|#ca995d/);
});

test("unread and notification-arrival highlights use the same indigo accent", () => {
  const bell = source("components", "account", "NotificationBell.tsx");
  const inbox = source("components", "account", "NotificationInbox.tsx");
  const assigned = source("components", "organization", "AssignedPracticeNotice.tsx");
  const sitting = source("components", "organization", "OrganizationSittingReview.tsx");

  assert.match(bell, /bg-indigo-500/);
  assert.doesNotMatch(bell, /bg-amber-500/);
  assert.match(inbox, /border-indigo-200\/70 bg-indigo-50\/35/);
  assert.match(inbox, /bg-indigo-600/);
  assert.doesNotMatch(inbox, /amber-/);
  assert.match(assigned, /border-indigo-300\/80 bg-indigo-50\/60/);
  assert.doesNotMatch(assigned, /amber-/);
  assert.match(sitting, /border-indigo-300\/80 bg-indigo-50\/55/);
  assert.doesNotMatch(sitting, /amber-/);
});

test("active informational states are indigo while true caution remains amber", () => {
  const placement = source("app", "placement", "page.tsx");
  const listening = source("app", "practice", "listening", "page.tsx");
  const reading = source("app", "practice", "reading", "page.tsx");

  assert.match(placement, /i < filled \? "bg-indigo-400"/);
  assert.match(placement, /Accuracy mode/);
  assert.match(placement, /No reliable score yet/);
  assert.match(placement, /text-amber-700/);
  assert.match(listening, /bg-indigo-50[^"]*text-indigo-800[\s\S]*Like the real exam:/);
  assert.match(listening, /browser does not support speech synthesis/);
  assert.match(listening, /bg-amber-50[^"]*text-amber-800/);
  assert.match(reading, /bg-indigo-50[^"]*text-indigo-800[\s\S]*Like the real exam:/);
});
