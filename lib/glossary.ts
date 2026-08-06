import glossaryData from "@/data/glossary.json";

export interface GlossaryEntry {
  term: string;
  aliases?: string[];
  short: string;
  example?: string;
}

const entries = (glossaryData as { terms: GlossaryEntry[] }).terms;

/*
  Every spelling that should resolve to an entry, keyed lowercase. Built once at
  module load: the explanations render this on every result screen, so the cost
  of rebuilding it per render would be real.
*/
const byKey = new Map<string, GlossaryEntry>();
for (const entry of entries) {
  byKey.set(entry.term.toLowerCase(), entry);
  for (const alias of entry.aliases ?? []) byKey.set(alias.toLowerCase(), entry);
}

/** Longest keys first, so "present perfect" wins over "present". */
const keysByLength = [...byKey.keys()].sort((a, b) => b.length - a.length);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SOURCE = `(?<=^|[\\s(“"'])(${keysByLength.map(escapeRegex).join("|")})(?=$|[\\s.,;:!?)”"'])`;

/**
 * A fresh regex matching any glossary term, on its own each call.
 *
 * Global regexes carry `lastIndex` between uses, so a shared instance would
 * make the second caller start mid-string. Building one per call costs
 * nothing next to the render it feeds.
 *
 * `-ing form` starts with a hyphen, which `\b` will not match against a
 * preceding space, so the leading boundary is a lookbehind for start-or-space
 * instead.
 */
export function termPattern(): RegExp {
  return new RegExp(SOURCE, "gi");
}

export function findTerm(text: string): GlossaryEntry | undefined {
  return byKey.get(text.trim().toLowerCase().replace(/\s+/g, " "));
}

export const GLOSSARY_SIZE = entries.length;
