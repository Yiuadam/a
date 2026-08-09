/*
  What a username may be, and which ones nobody may have.

  ---------------------------------------------------------------------------
  Why this exists before there are any usernames to speak of

  Today exactly one username exists: the owner's, set in ADMIN_USERNAME, and a
  learner has no way to choose one. So there is nothing to collide with, and it
  would be easy to conclude there is nothing to do.

  That is the wrong moment to conclude it. The instant usernames are handed out
  the sign-in form has to answer a question it cannot answer twice — "whose
  account is this name?" — and every safeguard for that has to be in place
  before the first name is issued, not after. Two names already given out
  cannot be made unique afterwards without taking one off somebody.

  ---------------------------------------------------------------------------
  Three rules, and where each is enforced

  1. Shape. A username is lower case, three to thirty characters, starts with a
     letter or digit, and contains only letters, digits, dot, dash and
     underscore. Enforced here and repeated as a CHECK constraint in
     supabase/migrations/0011_usernames.sql, because a rule that lives only in
     application code is a rule until somebody writes a row another way.

  2. No @. This is the load-bearing one. The sign-in form has a single field
     and decides by looking for an @: with one it is an email address, without
     one it is a username. Allow an @ in a username and the two namespaces
     overlap, and a name could shadow somebody's address. The check below and
     the CHECK constraint both forbid it — the character class simply does not
     include it — and there is a test that asserts no address can ever resolve
     as a username.

  3. Uniqueness, which application code cannot promise. Two sign-ups a
     millisecond apart both check "is this name taken?", both see no, both
     insert. The only place that race can be settled is a unique index, so
     `usernames.username` is the primary key of its table and the claim goes
     through an insert that either succeeds or violates it. Nothing here
     checks availability, deliberately: a function that answered would be
     believed, and its answer would be stale before it was read.

  ---------------------------------------------------------------------------
  Reserved names

  Separate from uniqueness and needed for a different reason. "admin",
  "support" and "billing" are not collisions, they are impersonation: a learner
  who receives a message from "support" has no way to tell that it is another
  learner. The owner's own username is reserved by the same mechanism, so a
  learner cannot take a name the owner is already signing in with.
*/

/** Lower case, 3–30, starts alphanumeric, then letters, digits, . - _ */
const SHAPE = /^[a-z0-9][a-z0-9._-]{2,29}$/;

/*
  Names nobody may claim. Two kinds, kept in one list because the rule is the
  same: roles a learner could be mistaken for, and words this app routes on.
  Lower case only — every comparison goes through `normaliseUsername` first.
*/
export const RESERVED_USERNAMES: readonly string[] = [
  "account", "accounts", "admin", "administrator", "api", "auth", "bandup",
  "billing", "contact", "help", "info", "mod", "moderator", "official",
  "owner", "practice", "privacy", "root", "security", "settings", "staff",
  "support", "system", "team", "terms", "test", "webmaster", "www",
];

const RESERVED = new Set(RESERVED_USERNAMES);

/**
 * The canonical form of whatever somebody typed, or null if it is not a
 * username at all.
 *
 * Trimming and lower-casing happen here and nowhere else, so a name typed into
 * a sign-in form, a name typed into a Cloudflare secret and a name stored in
 * the database all reduce to the same string. An address, anything with
 * whitespace inside it, and anything of the wrong shape return null rather
 * than a best guess — a resolver that guesses is a resolver that can send
 * somebody to the wrong account.
 */
export function normaliseUsername(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return null;
  /* Stated separately from the shape test so the reason survives a refactor:
     an @ makes it an email address, and the two namespaces must not meet. */
  if (value.includes("@")) return null;
  return SHAPE.test(value) ? value : null;
}

/** Whether a name is one nobody may claim. Expects a normalised name. */
export function isReservedUsername(username: string): boolean {
  return RESERVED.has(username);
}

/**
 * Whether this name may be claimed by an ordinary learner.
 *
 * `takenByOwner` is the owner's username from ADMIN_USERNAME, passed in rather
 * than read here so this module stays free of environment access and can be
 * tested without one.
 */
export function claimable(
  raw: string,
  takenByOwner: string | null,
): { ok: true; username: string } | { ok: false; reason: "shape" | "reserved" } {
  const username = normaliseUsername(raw);
  if (username === null) return { ok: false, reason: "shape" };
  if (isReservedUsername(username)) return { ok: false, reason: "reserved" };
  if (takenByOwner !== null && username === normaliseUsername(takenByOwner)) {
    /* Reported as reserved rather than as taken. "That name belongs to the
       owner" is a fact about this deployment that a stranger need not learn. */
    return { ok: false, reason: "reserved" };
  }
  return { ok: true, username };
}
