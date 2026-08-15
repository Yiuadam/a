import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

register("./alias-resolve.mjs", import.meta.url);

const identity = await import(pathToFileURL(join(process.cwd(), "lib", "auth", "account-identity.ts")).href);

test("required account identity needs only the display name and username", () => {
  assert.equal(identity.accountIdentityComplete({ displayName: "Maya", username: "maya", accountKind: "student" }), true);
  assert.equal(identity.accountIdentityComplete({ displayName: "", username: "maya", accountKind: "student" }), false);
  assert.equal(identity.accountIdentityComplete({ displayName: "Maya", username: null, accountKind: "student" }), false);
  assert.equal(identity.accountIdentityComplete({ displayName: "Maya", username: "maya", accountKind: null }), true);
});

test("username alone releases first-run setup while the profile reminder stays", () => {
  assert.equal(identity.accountUsernameReady({ displayName: null, username: "bright-owl-321", accountKind: null }), true);
  assert.equal(identity.accountIdentityComplete({ displayName: null, username: "bright-owl-321", accountKind: null }), false);
  assert.equal(identity.accountUsernameReady({ displayName: "Maya", username: null, accountKind: "student" }), false);
});

test("legacy account kinds remain readable without including an organization or platform privilege", () => {
  assert.deepEqual(identity.ACCOUNT_KINDS, ["individual", "student", "teacher"]);
  assert.equal(identity.readAccountKind("admin"), null);
  assert.equal(identity.readAccountKind("manager"), null);
  assert.equal(identity.readAccountKind("owner"), null);
});

test("database identity write is atomic, constrained and service-role only", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "0021_required_account_identity_and_admin_users.sql"), "utf8");
  assert.match(sql, /create or replace function public\.set_account_identity/);
  assert.match(sql, /account_kind in \('individual', 'student', 'teacher'\)/);
  assert.match(sql, /revoke all on function public\.set_account_identity[^;]+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.set_account_identity[^;]+to service_role/i);
  assert.match(sql, /Never grants organization or admin access/i);
});

test("the owner user directory is paged instead of returning an unbounded data dump", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "0021_required_account_identity_and_admin_users.sql"), "utf8");
  assert.match(sql, /limit greatest\(1, least\(coalesce\(p_limit, 50\), 100\)\)/i);
  assert.match(sql, /offset greatest\(coalesce\(p_offset, 0\), 0\)/i);
});

test("the notification and skippable setup gate share one account profile", () => {
  const layout = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
  const header = readFileSync(join(process.cwd(), "components", "SiteHeader.tsx"), "utf8");
  const gate = readFileSync(join(process.cwd(), "components", "account", "RequiredAccountGate.tsx"), "utf8");
  assert.match(layout, /<AccountProfileProvider>/);
  assert.match(layout, /<RequiredAccountGate>/);
  assert.match(header, /<HeaderNotificationBell/);
  assert.match(gate, /accountUsernameReady\(profile\)/);
  /*
    The gate deliberately no longer waits on the organisation-search replica.
    A learner whose profile saved was being held on the setup screen because a
    copy into D1 had not landed, with "Do this later" running through the same
    failing path — an account nobody could finish creating. The username itself
    is still required.
  */
  assert.doesNotMatch(gate, /organizationUsernameReady/);
  assert.match(gate, /accountUsernameReady\(profile\)/);
  assert.match(gate, /phase === "loading"/);
  assert.match(gate, /\/account\/onboarding\?returnTo=/);
  const form = readFileSync(join(process.cwd(), "components", "account", "AccountIdentityForm.tsx"), "utf8");
  // The Generate button belongs to the display name now, not the username —
  // the username arrives prefilled from the learner's email address, so there
  // is nothing left for it to suggest. See tests/username-from-email.test.mjs.
  assert.match(form, /Generate another display name|Generate a display name/);
  assert.doesNotMatch(form, /Generate a username|Generate another username/);
  assert.match(form, /Do this later/);
  assert.match(form, /deferSetup: true/);
  assert.match(form, /generateUsername: true/);
  assert.match(form, /If it is empty or unavailable, BandUp safely generates one for you/);
  assert.doesNotMatch(form, /ACCOUNT_KINDS|account-kind|How will you use BandUp\?|Individual learner|Learning with a school or teacher|Teaching learners/);
  assert.match(form, /JSON\.stringify\(\{ displayName, username, birthDate \}\)/);
  assert.doesNotMatch(form, /JSON\.stringify\(\{ displayName, username, accountKind/);
  const onboarding = readFileSync(join(process.cwd(), "app", "account", "onboarding", "page.tsx"), "utf8");
  assert.match(onboarding, /will safely generate one if you skip without choosing one/);
  assert.doesNotMatch(onboarding, /account type|individual learner|student,? or teacher/i);
  const bell = readFileSync(join(process.cwd(), "components", "account", "NotificationBell.tsx"), "utf8");
  assert.match(bell, /accountIdentityComplete\(profile\)/);
});

test("skipping claims a username server-side and mirrors it for organization search", () => {
  const route = readFileSync(join(process.cwd(), "app", "api", "account", "profile", "route.ts"), "utf8");
  const router = readFileSync(join(process.cwd(), "lib", "cloudflare", "data-router.ts"), "utf8");
  const d1 = readFileSync(join(process.cwd(), "lib", "cloudflare", "learner-data.ts"), "utf8");
  assert.match(route, /input\.deferSetup === true/);
  assert.match(route, /attempt < \(generated \? 10 : 1\)/);
  assert.match(route, /claimLearnerUsername/);
  /*
    The write no longer refuses over a failed replica; the read repairs it.
    Both halves are asserted, because either alone would leave a learner
    either blocked or permanently unfindable in organisation search.
  */
  assert.doesNotMatch(route, /organisation search is still syncing/);
  assert.match(route, /repairLearnerUsernameReplica\(auth\.user, body\.username\)/);
  assert.match(router, /export async function repairLearnerUsernameReplica/);
  assert.match(router, /claimSupabaseUsername/);
  assert.match(router, /replicateUsernameDurably/);
  assert.match(router, /replicateAccountIdentityDurably/);
  assert.match(router, /stored\?\.updatedAt/);
  assert.match(router, /emailForLearnerUsername/);
  assert.match(router, /durable[\s\S]*source clock/);
  assert.match(d1, /UPDATE usernames SET username = \?, source_updated_at = \?/);
  assert.match(d1, /INSERT INTO usernames \(username, user_id, created_at, source_updated_at\)/);
  assert.match(d1, /generic profile or[\s\S]*must never be allowed to roll the D1 alias back/);
  assert.match(d1, /emailForCloudflareUsername/);
  assert.match(d1, /cloudflareUsernameMatches/);
  assert.match(router, /learnerUsernameReplicaReady/);
  const password = readFileSync(join(process.cwd(), "app", "api", "auth", "password", "route.ts"), "utf8");
  assert.match(password, /emailForLearnerUsername\(identifier\)/);
  const provider = readFileSync(join(process.cwd(), "components", "account", "AccountProfileProvider.tsx"), "utf8");
  assert.match(provider, /state\.sessionToken === session\.accessToken/);
  assert.doesNotMatch(provider, /if \(!session\) \{\s*setState/);
});

test("profile saves preserve legacy account-kind data without accepting a new choice", () => {
  const route = readFileSync(join(process.cwd(), "app", "api", "account", "profile", "route.ts"), "utf8");
  const router = readFileSync(join(process.cwd(), "lib", "cloudflare", "data-router.ts"), "utf8");
  const supabase = readFileSync(join(process.cwd(), "lib", "auth", "supabase.ts"), "utf8");
  assert.match(route, /const hasIdentity = "displayName" in input \|\| "username" in input/);
  assert.match(route, /await getLearnerAccountKind\(auth\.user\) \?\? "individual"/);
  assert.match(route, /account\/profile legacy identity read/);
  assert.doesNotMatch(route, /readAccountKind\(input\.accountKind\)/);
  assert.doesNotMatch(route, /Choose individual, student or teacher/);
  assert.match(router, /getLearnerAccountKind/);
  assert.match(router, /getSupabaseLearnerAccountKind/);
  assert.match(router, /getCloudflareLearnerAccountKind/);
  assert.match(supabase, /profile account kind read failed/);
  for (const adminPage of [
    join(process.cwd(), "app", "admin", "users", "page.tsx"),
    join(process.cwd(), "app", "admin", "users", "[id]", "page.tsx"),
  ]) {
    assert.doesNotMatch(readFileSync(adminPage, "utf8"), /Account type|account_kind|accountKind/);
  }
});

test("Cloudflare enforces username integrity at its database boundary", () => {
  const sql = readFileSync(join(process.cwd(), "cloudflare", "migrations", "0010_username_integrity.sql"), "utf8");
  assert.match(sql, /CREATE TRIGGER IF NOT EXISTS usernames_validate_insert/);
  assert.match(sql, /CREATE TRIGGER IF NOT EXISTS usernames_validate_update/);
  assert.match(sql, /reserved_usernames/);
  assert.match(sql, /NEW\.username GLOB '\*\[\^a-z0-9\._-\]\*'/);
});

test("the user directory endpoints stay hidden behind the platform owner check", () => {
  for (const route of [
    join(process.cwd(), "app", "api", "admin", "users", "route.ts"),
    join(process.cwd(), "app", "api", "admin", "users", "[id]", "route.ts"),
  ]) {
    const source = readFileSync(route, "utf8");
    assert.match(source, /isAdminEmail\(actor\.email\)/);
    assert.match(source, /safeJsonError\("Not found\.", 404\)/);
  }
});

test("Google's owned surface is clipped to the same capsule as BandUp glass", () => {
  const component = readFileSync(join(process.cwd(), "components", "account", "GoogleSignIn.tsx"), "utf8");
  const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  assert.match(component, /shape: "pill"/);
  assert.match(component, /google-signin-glass[^\n]+rounded-full/);
  assert.match(component, /RefractiveGlassLayer radius=\{999\}/);
  assert.match(css, /\.google-signin-host iframe[^}]+border-radius: 999px !important/s);
  assert.match(css, /clip-path: inset\(0 round 999px\)/);
});

test("legacy account kinds no longer decide the homepage or appear in setup", () => {
  const homepage = readFileSync(join(process.cwd(), "app", "page.tsx"), "utf8");
  const form = readFileSync(join(process.cwd(), "components", "account", "AccountIdentityForm.tsx"), "utf8");
  assert.doesNotMatch(homepage, /accountKind|Opening your dashboard|router\.replace\("\/organization"\)/);
  assert.doesNotMatch(form, /accountKind/);
});

test("ordinary sign-in returns through the role-aware homepage", () => {
  for (const sourcePath of [
    join(process.cwd(), "components", "AccountCallback.tsx"),
    join(process.cwd(), "components", "account", "GoogleSignIn.tsx"),
    join(process.cwd(), "components", "account", "SignedOut.tsx"),
  ]) {
    assert.match(readFileSync(sourcePath, "utf8"), /consumeAuthReturnPath\("\/"\)/);
  }
});
