/*
  AccountCallback.tsx is a "use client" component, so it cannot be imported
  and rendered here the way lib/account.ts can be — Node has no JSX transform
  and no DOM, and useSyncExternalStore/useRouter need a real React tree. Two
  things are still worth pinning without either:

  1. The shape of the fix for the hydration race: useSyncExternalStore reports
     the server snapshot ("") for the render that matches hydration, and the
     two effects that act on the fragment used to run on exactly that render.
     An error fragment, a saved session, or an email link all looked like
     "nothing here" for one render, and `fragment === ""` sent the browser on
     to a plain /account/ before the corrected render ever arrived — losing a
     provider's error message, and for an email link, racing a real fetch that
     had already started against a navigation fired from stale data. The fix
     is a `hydrated` flag that gates both effects until a render has actually
     used the client snapshot, checked here at the source level because that
     is the only level available.
  2. emailActionFromFragment, which *is* a plain function of a string in and
     an object out. It is parsed straight out of the current source with the
     TypeScript compiler already sitting in this repo's own node_modules,
     stripped of its types the same way `tsc` would, and then actually called
     — not a regex guess at what it probably does.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const root = process.cwd();
const callbackPath = join(root, "components", "AccountCallback.tsx");
const source = readFileSync(callbackPath, "utf8");

/** Comments stripped, so a comment describing the old behaviour cannot satisfy a match meant for the code. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const stripped = code(source);

test("a hydrated flag exists and only flips after mount, without setState in an effect", () => {
  // Built the same way `fragment` is — a useSyncExternalStore whose server
  // snapshot and client snapshot deliberately differ — rather than a useState
  // flipped from inside a useEffect, which react-hooks/set-state-in-effect
  // (part of this repo's eslint-config-next core-web-vitals ruleset) rejects.
  assert.match(stripped, /function notYetHydrated\(\): boolean \{\s*return false;\s*\}/);
  assert.match(stripped, /function hydratedOnClient\(\): boolean \{\s*return true;\s*\}/);
  assert.match(
    stripped,
    /const hydrated = useSyncExternalStore\(subscribeOnce, hydratedOnClient, notYetHydrated\);/,
  );
  assert.doesNotMatch(
    stripped,
    /use(State|Effect)\(\(\) => set\w+\(true\), \[\]\)/,
    "a bare setState(true) in a mount effect is exactly what the lint rule this file's ESLint pass depends on forbids",
  );
});

test("the email-consume effect will not start a fetch before hydration", () => {
  const effectStart = stripped.indexOf("void fetch(apiUrl(\"/api/auth/email/consume\")");
  assert.ok(effectStart !== -1, "email/consume fetch not found");
  const guardStart = stripped.lastIndexOf("useEffect(", effectStart);
  const guardSlice = stripped.slice(guardStart, effectStart);
  assert.match(
    guardSlice,
    /if \(!hydrated \|\| !emailToken \|\| !emailActionName\) return;/,
    "the effect must bail out before hydration, not just before it has a token",
  );

  const depsMatch = stripped.slice(effectStart).match(/\}, \[([^\]]*)\]\);/);
  assert.ok(depsMatch, "dependency array for the consume effect not found");
  const deps = depsMatch[1].split(",").map((d) => d.trim());
  assert.ok(deps.includes("hydrated"), "hydrated must be a dependency, or the effect never re-runs once it flips");
});

test("the redirect effect will not act on the fragment before hydration", () => {
  const redirectLine = stripped.indexOf('router.replace("/account/")');
  assert.ok(redirectLine !== -1, "the bare-arrival redirect is missing");
  const guardStart = stripped.lastIndexOf("useEffect(", redirectLine);
  const guardSlice = stripped.slice(guardStart, guardStart + 200);
  assert.match(
    guardSlice,
    /useEffect\(\(\) => \{\s*if \(!hydrated\) return;/,
    "the redirect effect must bail out before hydration",
  );

  const depsMatch = stripped.slice(redirectLine).match(/\}, \[([^\]]*)\]\);/);
  assert.ok(depsMatch, "dependency array for the redirect effect not found");
  const deps = depsMatch[1].split(",").map((d) => d.trim());
  assert.deepEqual(
    deps,
    ["hydrated", "failure", "emailFailure", "session", "fragment", "router"],
    "hydrated must gate the same effect that decides from fragment, failure, session and emailFailure",
  );
});

test("a consumed token always saves a session, even if the effect is cancelled before the navigation", () => {
  const consumeStart = stripped.indexOf("void fetch(apiUrl(\"/api/auth/email/consume\")");
  const catchStart = stripped.indexOf(").catch((error", consumeStart);
  assert.ok(consumeStart !== -1 && catchStart !== -1, "could not find the consume effect's .then()/.catch() pair");
  const thenBlock = stripped.slice(consumeStart, catchStart);

  const saveIndex = thenBlock.indexOf("saveSession({");
  const cancelledIndex = thenBlock.indexOf("if (cancelled) return;");
  assert.ok(saveIndex !== -1, "saveSession call not found in the success branch");
  assert.ok(cancelledIndex !== -1, "cancelled check not found in the success branch");
  assert.ok(
    saveIndex < cancelledIndex,
    "saveSession must run before the cancelled check: the token is already spent server-side by the time the response arrives, cancelled or not",
  );
});

test("the provider-error message still renders off failure/fragment, not off hydrated", () => {
  // These derivations run on every render, including the hydration one — only
  // the effects that act on them (history, navigation) wait for `hydrated`.
  assert.match(stripped, /const failure = errorFromFragment\(fragment\);/);
  assert.match(stripped, /const shownFailure = failure \?\? emailFailure;/);
  assert.match(stripped, /shownFailure \? "That didn.t work"/);
  assert.match(stripped, /\{shownFailure && \(/);
  // And the render itself is never gated on `hydrated` — a provider error
  // must be visible from the first paint that has it, not the second.
  assert.doesNotMatch(stripped, /hydrated \? shownFailure/);
  assert.doesNotMatch(stripped, /if \(!hydrated\) return null;/);
});

/*
  emailActionFromFragment, executed for real.

  The rest of this file cannot be imported — "use client" plus JSX means
  Node's own type-stripping refuses the file outright — but this one function
  has neither. Parsing it out with the TypeScript compiler that already lives
  in node_modules and handing the result to `new Function` calls the actual
  current implementation, not a paraphrase of it.
*/
function extractFunction(name) {
  const sourceFile = ts.createSourceFile(
    "AccountCallback.tsx",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`function ${name} not found in ${callbackPath}`);

  const raw = found.getText(sourceFile).replace(/^export\s+/, "");
  const { outputText } = ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  return new Function(`"use strict";\n${outputText}\nreturn ${name};`)();
}

const emailActionFromFragment = extractFunction("emailActionFromFragment");

test("emailActionFromFragment reads a confirm or recover action alongside its token", () => {
  assert.deepEqual(
    emailActionFromFragment("#email_action=confirm&email_token=abc123"),
    { token: "abc123", action: "confirm" },
  );
  assert.deepEqual(
    emailActionFromFragment("#email_action=recover&email_token=xyz-789"),
    { token: "xyz-789", action: "recover" },
  );
  // The leading "#" is optional — callers already strip it in some paths.
  assert.deepEqual(
    emailActionFromFragment("email_action=recover&email_token=zzz"),
    { token: "zzz", action: "recover" },
  );
});

test("emailActionFromFragment refuses anything that is not exactly confirm or recover", () => {
  assert.equal(emailActionFromFragment(""), null);
  assert.equal(emailActionFromFragment("#email_action=confirm"), null, "no token");
  assert.equal(emailActionFromFragment("#email_token=abc123"), null, "no action");
  assert.equal(emailActionFromFragment("#email_action=reset&email_token=abc123"), null, "unknown action");
  assert.equal(emailActionFromFragment("#email_action=CONFIRM&email_token=abc123"), null, "case-sensitive");
  // A session or provider-error fragment must not be misread as an email link.
  assert.equal(emailActionFromFragment("#access_token=abc&refresh_token=r&expires_in=3600"), null);
  assert.equal(emailActionFromFragment("#error=access_denied&error_description=cancelled"), null);
});
