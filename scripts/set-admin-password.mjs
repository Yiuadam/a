#!/usr/bin/env node
/*
  Give the owner's account a password.

  Supabase keeps passwords; this repository does not, and must not. So this is
  a one-off command you run against your own project with your own service-role
  key, not a value checked in anywhere:

      SUPABASE_URL=https://xxxx.supabase.co \
      SUPABASE_SERVICE_ROLE_KEY=eyJ... \
      node scripts/set-admin-password.mjs --email you@example.com --password '…'

  The password may also come from ADMIN_PASSWORD, and the address from
  ADMIN_EMAILS (the first entry), so a shell that already has the deployment's
  variables loaded needs no arguments at all.

  If the address has no account yet, one is created and marked confirmed —
  which is the case on a fresh project, where the owner has never signed in
  with Google either.

  It prints nothing that could be pasted into a chat log by accident: not the
  password, not the key, not the user id.
*/

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

const url = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const email = (flag("email") ?? (process.env.ADMIN_EMAILS ?? "").split(",")[0] ?? "").trim();
const password = flag("password") ?? process.env.ADMIN_PASSWORD ?? "";

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (!url || !key) die("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
if (!email || !email.includes("@")) die("pass --email, or set ADMIN_EMAILS");
if (!password) die("pass --password, or set ADMIN_PASSWORD");

/*
  Said once, and not enforced. Whose account it is and how much they care is
  their call; being told the size of the risk is not.
*/
if (password.length < 12 || /^\d+$/.test(password)) {
  console.warn(
    "warning: this password is short or all digits. The owner's account can change\n" +
      "         prices and read every learner's usage, so a long passphrase is worth\n" +
      "         the extra typing. Setting it anyway.",
  );
}

async function api(path, init = {}) {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/*
  Paged rather than filtered. GoTrue's admin list has grown and lost query
  parameters across versions, and paging is the one shape that has worked in
  all of them.
*/
async function findUser(target) {
  const wanted = target.toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const { ok, body } = await api(`/auth/v1/admin/users?page=${page}&per_page=200`);
    if (!ok) die("could not list users — check the service-role key");
    const users = Array.isArray(body?.users) ? body.users : [];
    if (users.length === 0) return null;
    const hit = users.find((u) => String(u.email ?? "").toLowerCase() === wanted);
    if (hit) return hit;
  }
  return null;
}

const existing = await findUser(email);

if (existing) {
  const { ok, status } = await api(`/auth/v1/admin/users/${existing.id}`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
  if (!ok) die(`could not set the password (status ${status})`);
  console.log(`Password set for ${email}.`);
} else {
  const { ok, status } = await api("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!ok) die(`could not create the account (status ${status})`);
  console.log(`Account created for ${email}, with the password you gave.`);
}

console.log(
  "\nTo sign in: open /account, then use that address (or your ADMIN_USERNAME)\n" +
    "and this password. Add the address to ADMIN_EMAILS if it is not there\n" +
    "already, or the account will sign in as an ordinary free one.",
);
