import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

register("../scripts/ts-resolve.mjs", import.meta.url);

const { boundedTouchCardTransform } = await import(
  pathToFileURL(join(process.cwd(), "lib", "pointer-attraction.ts")).href
);

function transformedAxis(size, drift, scale, originPercent) {
  const origin = size * originPercent / 100;
  const start = drift + origin * (1 - scale);
  return { start, end: start + size * scale };
}

function rule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  const end = css.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${selector} rule`);
  return css.slice(start, end + 2);
}

function ruleContaining(css, selector, declaration) {
  let start = css.indexOf(selector);
  while (start !== -1) {
    const end = css.indexOf("\n}", start);
    if (end !== -1) {
      const candidate = css.slice(start, end + 2);
      if (candidate.includes(declaration)) return candidate;
    }
    start = css.indexOf(selector, start + selector.length);
  }
  return null;
}

test("touch attraction never paints outside the card layout box", () => {
  for (const x of [-1, -0.75, -0.25, 0, 0.25, 0.75, 1]) {
    for (const y of [-1, -0.75, -0.25, 0, 0.25, 0.75, 1]) {
      const response = boundedTouchCardTransform(x, y, 320, 84);
      const horizontal = transformedAxis(320, response.driftX, response.scaleX, response.originX);
      const vertical = transformedAxis(84, response.driftY, response.scaleY, response.originY);
      assert.ok(horizontal.start >= -1e-9);
      assert.ok(horizontal.end <= 320 + 1e-9);
      assert.ok(vertical.start >= -1e-9);
      assert.ok(vertical.end <= 84 + 1e-9);
    }
  }
});

test("touch attraction clamps fingers dragged beyond the card", () => {
  assert.deepEqual(
    boundedTouchCardTransform(4, -3, 320, 84),
    boundedTouchCardTransform(1, -1, 320, 84),
  );
});

test("only bounded interactive controls keep pointer attraction", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "PointerAttraction.tsx"),
    "utf8",
  );
  assert.match(source, /MAX_CARD_WIDTH = 560/);
  assert.match(source, /MAX_CARD_HEIGHT = 190/);
  assert.match(source, /\[data-pointer-attract\], button, a\[href\], summary/);
  assert.doesNotMatch(source, /const TARGET = .*\.card/);
  assert.match(source, /it is an actual control/);
});

test("pointer attraction never drives the glass refraction itself", () => {
  const source = readFileSync(
    join(process.cwd(), "components", "PointerAttraction.tsx"),
    "utf8",
  );
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");

  assert.doesNotMatch(source, /data-glass-reflecting|--glass-reflection-|GLASS_SURFACE|REFLECTION_FRAME_MS/);
  assert.equal((source.match(/document\.addEventListener\("pointermove"/g) ?? []).length, 1);
  assert.match(source, /target === current/);
  assert.doesNotMatch(css, /data-glass-reflecting|--glass-reflection-/);
  assert.match(css, /html\[data-live-glass-refraction\] \.liquid-glass:not\(\.nav-menu-group\),/);
});

test("pointer attraction is dormant: it still moves nothing a control's label sits on", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const engine = readFileSync(join(process.cwd(), "components", "PointerAttraction.tsx"), "utf8");
  const target = rule(css, "[data-pointer-attract-ready]");

  // The target is the semantic button/link. It may publish values, but must
  // never translate or stretch its children (including visible words/icons).
  // This is the half of the contract that has never depended on what consumes
  // the values, and it still holds.
  assert.match(target, /--pointer-drift-x: 0px/);
  assert.match(target, /--pointer-stretch-x: 1/);
  assert.doesNotMatch(target, /\n\s*(?:translate|scale|transform(?:-origin)?|will-change)\s*:/);

  /*
    The other half is currently unfulfilled, deliberately. Every drift and
    stretch this engine published was applied to one thing: the decorative
    refraction layer inside the control. That layer is deleted — refraction
    came out of the whole site because the owner judged it to fog the glass
    rather than clarify it — so nothing consumes these properties, and the
    engine's own gate (a `:scope > .refractive-glass-layer` lookup) now matches
    nothing, which means it never marks a control ready in the first place.

    The engine is left installed rather than deleted because whether the
    magnetism returns on some other decorative layer is a design decision, not
    a consequence of dropping refraction. What this test pins is that it stays
    harmless while that decision is open: no rule may reintroduce the movement
    by pointing it at a control itself or at anything carrying its label.
  */
  assert.doesNotMatch(css, /\[data-pointer-attract-ready\][^{]*>[^{]*\{[^}]*translate:/);
  assert.doesNotMatch(css, /refractive-glass-layer/);

  // Segmented controls use a dedicated selector layer. Do not also apply the
  // generic attraction marker to their individual text buttons.
  for (const control of [
    ".theme-toggle-base",
    ".interval-toggle-base",
    ".panel-toggle-base",
    ".speaking-engine-picker",
    ".organization-view-tabs",
  ]) {
    assert.match(engine, new RegExp(control.replace(/\./g, "\\.")));
  }
  assert.equal((engine.match(/target\.closest\(FLOWING_CONTROL\)/g) ?? []).length, 2);
});

test("a stretched lens suppresses the static control rim without removing focus", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const active = rule(css, "[data-pointer-attract-ready][data-pointer-attracting]");
  const activeGlass = rule(css, ".pointer-attract-glass[data-pointer-attracting]");

  assert.match(active, /border-color: transparent/);
  assert.match(activeGlass, /border-color: transparent/);
  assert.match(activeGlass, /box-shadow: none/);
  assert.doesNotMatch(active, /outline\s*:\s*(?:none|0)/);
});

test("each flowing tab or filter puts its glass selector behind static labels", () => {
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const contracts = [
    ["components/ThemeToggle.tsx", "theme-toggle-selector"],
    ["components/account/NotificationInbox.tsx", "notification-filter-selector"],
    ["app/pricing/PricingPlans.tsx", "interval-toggle-selector"],
    ["components/exam/SwipePanels.tsx", "panel-toggle-selector"],
    ["components/speaking/SpeakingSession.tsx", "speaking-engine-selector"],
    ["components/organization/OrganizationPortal.tsx", "organization-view-selector"],
    ["components/SiteHeader.tsx", "nav-primary-selector"],
    ["components/SiteHeader.tsx", "nav-menu-selector"],
  ];

  for (const [file, selector] of contracts) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const selectorIndex = source.indexOf(selector);
    assert.notEqual(selectorIndex, -1, `${selector} must be rendered`);
    const surrounding = source.slice(Math.max(0, selectorIndex - 1_000), selectorIndex + 4_000);

    assert.match(surrounding, new RegExp(`<span[^>]*${selector}[^>]*aria-hidden=\"true\"`));
    // Speaking shares its visible option component below the picker, while
    // the other controls render their labels inline. In both cases content is
    // raised above the selector in the same component module.
    assert.match(source, /className=(?:\{`[^`]*|")[^\n]*\brelative z-10\b/);

    const paintedRule = ruleContaining(css, `.${selector}`, "pointer-events: none");
    assert.ok(paintedRule, `${selector} must be a non-interactive painted layer`);
  }
});
