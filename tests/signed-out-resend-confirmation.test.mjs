/*
  The confirm screen PasswordForm shows after a signup POST used to end with
  "If that address already had an account, use your existing password
  instead." — advice that is wrong for the common case landing on that
  screen, a brand new pending registration, because
  lib/auth/native-password.ts's signInWithImportedNativePassword only accepts
  a credential whose status is "active", and a fresh registration's is
  "pending" until the emailed link is used (see
  lib/auth/native-email.ts's startNativePasswordRegistration, which inserts
  new credentials with status 'pending'). Signing in with the very password
  just chosen would be refused, not merely unnecessary.

  There was also no way to ask for the email again if it was slow, filtered,
  or never arrived, despite re-posting the same identifier and password with
  mode "signup" already being safe to repeat: resendPendingRegistration in
  lib/auth/native-email.ts resends to a still-pending address instead of
  erroring, and the route answers the same `{ confirm: true }` either way.

  This is a "use client" component, so — as with AccountCallback.tsx — it is
  read as text rather than imported and rendered.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const signedOutSource = readFileSync(join(root, "components", "account", "SignedOut.tsx"), "utf8");
const nativeEmailSource = readFileSync(join(root, "lib", "auth", "native-email.ts"), "utf8");

/** Comments stripped, so a comment describing the old copy cannot satisfy a match meant for the code. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const source = code(signedOutSource);

// Isolate PasswordForm's body so an assertion cannot accidentally match
// something in RecoveryForm, which has its own, differently-shaped confirm
// screen right below it in the same file.
const passwordFormStart = source.indexOf("function PasswordForm()");
const recoveryFormStart = source.indexOf("function RecoveryForm(");
assert.ok(passwordFormStart !== -1 && recoveryFormStart !== -1, "could not locate PasswordForm/RecoveryForm");
const passwordForm = source.slice(passwordFormStart, recoveryFormStart);

test("the confirm screen no longer tells a pending account to sign in with its password", () => {
  assert.doesNotMatch(
    passwordForm,
    /use your existing password instead/,
    "a pending credential's status is not 'active', so the server refuses exactly this advice",
  );
});

test("the submit logic is a callable, reusable function rather than only a form's onSubmit", () => {
  // isResend distinguishes a first attempt from a resend only for the
  // confirm-screen feedback (`resent`) — reusing the one POST is the point.
  assert.match(passwordForm, /async function submitCredentials\(isResend: boolean\)/);
  assert.match(passwordForm, /async function submit\(e: React\.FormEvent\) \{\s*e\.preventDefault\(\);\s*void submitCredentials\(false\);/);
  // The request itself is unchanged by the resend/first-attempt distinction:
  // same identifier, same password, same "signup" mode either way.
  assert.match(passwordForm, /mode: creating \? "signup" : "signin",/);
});

test("the confirm screen offers to send the link again, wired to the shared submit path", () => {
  const confirmBranch = passwordForm.slice(passwordForm.indexOf("if (confirm) {"));
  assert.match(confirmBranch, /Send the link again/);
  assert.match(confirmBranch, /onClick=\{\(\) => void submitCredentials\(true\)\}/);
  assert.match(confirmBranch, /disabled=\{busy\}/);
});

test("a successful resend says so, and a first confirm screen does not claim to be one", () => {
  assert.match(passwordForm, /setResent\(isResend\)/);
  assert.match(passwordForm, /"Sent — check your inbox again\."/);
  // The un-resent copy names the one hour the link is valid for — reason
  // enough to want the resend button — without promising a password will work.
  assert.match(
    passwordForm,
    /Check your inbox — there is a link there that finishes setting up your account\. It works once and expires after an hour\./,
  );
});

test("the confirm screen keeps the same error handling a first attempt uses", () => {
  const confirmBranch = passwordForm.slice(
    passwordForm.indexOf("if (confirm) {"),
    passwordForm.indexOf("Send the link again"),
  );
  assert.match(confirmBranch, /\{error && \(/);
  assert.match(confirmBranch, /role="alert"/);
});

test("identifier and password survive into the confirm screen for the resend to reuse", () => {
  // Nothing clears the fields a resend depends on once the first attempt
  // succeeds — no input for them is rendered again until sign-up/sign-in
  // toggles, and the confirm screen has no inputs of its own.
  assert.doesNotMatch(passwordForm, /setIdentifier\(""\)/);
  assert.doesNotMatch(passwordForm, /setPassword\(""\)/);
});

test("what the resend button relies on actually resends a still-pending registration", () => {
  const native = code(nativeEmailSource);
  assert.match(native, /async function resendPendingRegistration/);
  assert.match(native, /row\.status !== "pending"/);
  assert.match(native, /await issueAction\(row\.id, "confirm_registration", bindings, now\)/);
  assert.match(native, /await sendActionEmail\(row\.email, "confirm_registration", token, bindings\)/);
});
