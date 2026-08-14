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
 * A friendly, non-identifying username suggestion. It never uses somebody's
 * email, OAuth name, birthday or account id. The database remains the final
 * authority on uniqueness when the suggestion is saved.
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
