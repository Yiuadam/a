import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();

const excluded = new Set([
  "app/api/account/progress/route.ts",
  "components/AutoSync.tsx",
  "lib/cloudflare/data-router.ts",
]);

const contentLibraries = [
  "lib/advice.ts",
  "lib/auth/errors.ts",
  "lib/band.ts",
  "lib/billing/gate.ts",
  "lib/billing/messages.ts",
  "lib/billing/tiers.ts",
  "lib/completion-badges.ts",
  "lib/descriptors.ts",
  "lib/drills.ts",
  "lib/exam/breakdown.ts",
  "lib/exam/display.ts",
  "lib/exam/mock.ts",
  "lib/glossary.ts",
  "lib/lookups.ts",
  "lib/nav.ts",
  "lib/notifications/client.ts",
  "lib/organizations/practice-assignments.ts",
  "lib/placement.ts",
  "lib/plan.ts",
  "lib/questions.ts",
  "lib/review.ts",
  "lib/tests.ts",
  "lib/transcribe.ts",
];

function walk(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const pageSources = walk("app").filter((path) => /\/(?:page|layout)\.tsx$/.test(path));
const componentSources = walk("components").filter((path) => path.endsWith(".tsx"));
const apiSources = walk("app/api").filter((path) => path.endsWith("/route.ts"));
const sourcePaths = [...new Set([
  ...pageSources,
  ...componentSources,
  ...contentLibraries.filter((path) => existsSync(join(root, path))),
  ...apiSources,
  "lib/cloudflare/organization-commands.ts",
  "lib/cloudflare/organizations.ts",
])].filter((path) => !excluded.has(path) && !path.startsWith("lib/progress/"));

const visibleAttributes = new Set(["alt", "aria-description", "aria-label", "placeholder", "title"]);
const messageCalls = new Set(["conflict", "fail", "forbidden", "notFound", "safeJsonError"]);
const visibleProperties = new Set([
  "actionLabel",
  "attentionLabel",
  "blurb",
  "body",
  "cta",
  "description",
  "label",
  "lead",
  "reason",
  "subtitle",
  "title",
  "what",
  "why",
]);

function propertyName(node, sourceFile) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return node.getText(sourceFile);
}

function callName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function looksTechnical(text) {
  const value = text.trim();
  if (!value) return true;
  if (/^(?:\/|https?:\/\/|@\/|\.?\.\/)/.test(value)) return true;
  if (/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|JOIN|WHERE)\b/i.test(value)) return true;
  if (/^\.[\w-]+(?:\s*,\s*\.[\w-]+)+$/.test(value)) return true;
  if (/^\.[\w-]+(?::not\(\.[\w-]+\))*(?:\s*,\s*\.[\w-]+(?::not\(\.[\w-]+\))*)*$/.test(value)) return true;
  if (/var\(--|--[a-z][\w-]*|\b(?:app|bg|border|duration|fill|font|gap|grid|h|hover|items|justify|max|min|opacity|overflow|p|px|py|rounded|shadow|shrink|sm|stroke|text|transition|w)-[^\s]+/.test(value)) return true;
  // Lowercase tokens such as action names, statuses, icon names and query keys
  // are code vocabulary, not prose. A visible one-word heading starts with a
  // capital and is therefore still checked.
  if (/^[a-z][a-z0-9_.:/?#&=%-]*$/.test(value)) return true;
  return false;
}

function collectCopy(path) {
  const source = readFileSync(join(root, path), "utf8");
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = [];
  const add = (node, text) => {
    if (looksTechnical(text)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    found.push({ path, line: line + 1, text: text.trim() });
  };

  function visit(node) {
    if (ts.isJsxText(node)) add(node, node.text);

    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      if (ts.isJsxAttribute(parent)) {
        const name = parent.name.getText(sourceFile);
        if (visibleAttributes.has(name)) add(node, node.text);
      } else if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
        if (visibleProperties.has(propertyName(parent.name, sourceFile))) add(node, node.text);
      } else if (ts.isCallExpression(parent)) {
        const argumentIndex = parent.arguments.indexOf(node);
        const name = callName(parent.expression);
        if ((messageCalls.has(name) && argumentIndex === 0)
          || ((name === "id" || name === "text") && argumentIndex === 1)) {
          add(node, node.text);
        }
      } else if (path.endsWith(".tsx")) {
        add(node, node.text);
      }
    }

    if (
      path.endsWith(".tsx")
      && (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
    ) {
      add(node, node.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

const copy = sourcePaths.flatMap(collectCopy);

const americanSpellings = [
  /\borganizations?\b/i,
  /\borganizational\b/i,
  /\b(?:organize[ds]?|organizing)\b/i,
  /\b(?:personalize[ds]?|personalizing)\b/i,
  /\b(?:customize[ds]?|customizing|customization)\b/i,
  /\b(?:recognize[ds]?|recognizing)\b/i,
  /\b(?:colors?|colored|coloring)\b/i,
  /\b(?:centers?|centered|centering)\b/i,
  /\b(?:behaviors?|behavioral)\b/i,
  /\b(?:canceled|canceling)\b/i,
  /\b(?:analyze[ds]?|analyzing)\b/i,
  /\b(?:authorize[ds]?|authorizing|authorization)\b/i,
  /\b(?:favorites?|honors?|labor|neighbors?|catalogs?|grays?)\b/i,
  /\b(?:traveling|traveled|travelers?)\b/i,
  /\b(?:fulfill(?:s|ed|ing|ment)?|enroll(?:s|ed|ing|ment)?)\b/i,
  /\b(?:modeling|modeled|labeling|labeled|signaling|signaled)\b/i,
  /\bartifacts?\b/i,
  /\b(?:practiced|practicing)\b/i,
];

const practiceUsedAsVerb = [
  /\b(?:to|can|could|should|will|would|must|you|we|they) practice\b/i,
  /\bpractice (?:again|daily|here|now|one|slowly|these|this)\b/i,
];

test("learner-facing copy uses British English without rewriting code vocabulary", () => {
  const failures = copy.flatMap((item) => [
    ...americanSpellings.filter((pattern) => pattern.test(item.text)),
    ...practiceUsedAsVerb.filter((pattern) => pattern.test(item.text)),
  ].map(() => `${item.path}:${item.line}: ${JSON.stringify(item.text)}`));

  assert.deepEqual(failures, []);
});
