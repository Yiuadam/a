import { claimable } from "./usernames";

const ADJECTIVES = [
  "bright", "calm", "clever", "curious", "eager", "gentle", "happy", "kind",
  "lively", "lucky", "merry", "nimble", "proud", "quick", "sunny", "wise",
] as const;

const NOUNS = [
  "badger", "dolphin", "falcon", "fox", "koala", "lark", "otter", "owl",
  "panda", "penguin", "robin", "seal", "sparrow", "tiger", "turtle", "whale",
] as const;

type RandomUint32 = () => number;

function secureRandomUint32(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] ?? 0;
}

function pick<T>(values: readonly T[], random: RandomUint32): T {
  return values[random() % values.length] as T;
}

function candidate(random: RandomUint32): string {
  const suffix = 100 + (random() % 900);
  return `${pick(ADJECTIVES, random)}-${pick(NOUNS, random)}-${suffix}`;
}

/**
 * A friendly display-name suggestion, for the Generate button on the display
 * name field (components/account/AccountIdentityForm.tsx).
 *
 * The same two word lists as the username suggestion below, read as a name
 * rather than as a handle: capitalised, spaced, and with no numeric suffix.
 * The suffix exists purely to help a username dodge a collision, and a display
 * name has no uniqueness to satisfy — two learners called "Clever Otter" are
 * two learners called "Clever Otter", exactly as two people called Adam are.
 *
 * `previous` is honoured for the same reason it is below: pressing Generate a
 * second time and getting the same answer reads as a broken button.
 */
export function generateDisplayName(
  previous: string | null = null,
  random: RandomUint32 = secureRandomUint32,
): string {
  const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = `${capitalise(pick(ADJECTIVES, random))} ${capitalise(pick(NOUNS, random))}`;
    if (value !== previous) return value;
  }
  // Every pair collided with `previous`, which a stubbed or repeating random
  // source can do. Walk the adjective list instead so the button still moves.
  const index = ADJECTIVES.findIndex((word) => previous?.toLowerCase().startsWith(word));
  const next = ADJECTIVES[(index + 1) % ADJECTIVES.length] as string;
  return `${capitalise(next)} ${capitalise(pick(NOUNS, random))}`;
}

/**
 * A username built from the local part of an email address — everything
 * before the @ — or null when nothing valid can be made of it.
 *
 * This is a deliberate reversal, and worth stating plainly rather than
 * leaving for someone to discover. generateUsername below exists precisely so
 * that a handle is not identifying, and its own comment used to promise it
 * never touches an email. Usernames are public: they appear in the
 * organisation team directory and they work as sign-in aliases. Defaulting to
 * the local part therefore publishes part of every learner's address and makes
 * accounts easier to enumerate. The owner asked for it knowing that; it is
 * only a default, and the field stays editable, so a learner who does not want
 * their address as their handle can type something else before saving.
 *
 * What this must still guarantee is shape, because the local part of an
 * address and a username are not the same language. `Adam.Yiu+ielts@…` is a
 * perfectly ordinary address and `Adam.Yiu+ielts` is not a username at all.
 * So:
 *
 *   the +tag goes, being routing rather than identity;
 *   it is lower-cased, since usernames have one canonical case;
 *   anything outside [a-z0-9._-] becomes a dot, rather than being dropped, so
 *     two different addresses cannot silently collapse into one handle;
 *   runs of dots collapse and the edges are trimmed, because ".." reads as a
 *     typo and a leading dot is forbidden by the shape rule anyway;
 *   a name under three characters is padded, and one over thirty is cut.
 *
 * Uniqueness is not attempted here and cannot be — see the note on rule 3 in
 * ./usernames.ts. This returns a candidate; the caller claims it and handles
 * the collision, which is the only place a collision can honestly be settled.
 */
export function usernameFromEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const at = email.indexOf("@");
  if (at < 1) return null;
  const local = email.slice(0, at).split("+")[0] ?? "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");
  if (cleaned.length === 0) return null;
  // Padded rather than rejected: "al@…" is a real address, and "al" fails the
  // three-character rule for a reason that has nothing to do with its owner.
  const sized = (cleaned.length < 3 ? `${cleaned}000`.slice(0, 3) : cleaned).slice(0, 30);
  const checked = claimable(sized, null);
  return checked.ok ? checked.username : null;
}

/**
 * The nth candidate for one email address: the local part itself, then the
 * same with a short numeric suffix.
 *
 * The suffix is what makes two people who share a local part across different
 * providers — adam@gmail and adam@outlook — both able to sign up. It is
 * appended rather than replacing anything, and the base is trimmed first so
 * the result cannot exceed thirty characters.
 *
 * Returns null once the caller should stop and fall back to the
 * non-identifying generator below, which is also what happens when the
 * address yields nothing usable at all.
 */
export function usernameFromEmailAttempt(
  email: string | null | undefined,
  attempt: number,
): string | null {
  const base = usernameFromEmail(email);
  if (base === null) return null;
  if (attempt === 0) return base;
  if (attempt > 3) return null;
  const suffix = String(attempt + 1);
  const candidateName = `${base.slice(0, 30 - suffix.length)}${suffix}`;
  const checked = claimable(candidateName, null);
  return checked.ok ? checked.username : null;
}

/**
 * A friendly, non-identifying username suggestion. It never uses somebody's
 * email, OAuth name, birthday or account id.
 *
 * Still the fallback rather than the default: usernameFromEmail above is tried
 * first now, and this catches every case that cannot produce — an address
 * whose local part is reserved or unusable, and a handle already taken after
 * the suffixed attempts. The database remains the final authority on
 * uniqueness when the suggestion is saved.
 */
export function generateUsername(
  previous: string | null = null,
  random: RandomUint32 = secureRandomUint32,
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = candidate(random);
    if (value !== previous && claimable(value, null).ok) return value;
  }

  // A deterministic last step makes the Generate button change even if a
  // browser's random source is stubbed or repeats during testing.
  const match = previous?.match(/^([a-z]+-[a-z]+-)(\d{3})$/);
  if (match) {
    const next = 100 + ((Number(match[2]) - 99) % 900);
    const value = `${match[1]}${next}`;
    if (claimable(value, null).ok) return value;
  }
  return candidate(random);
}
