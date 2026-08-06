"use client";

import { useMemo } from "react";
import { useLookup } from "@/components/Lookup";
import { findTerm, termPattern } from "@/lib/glossary";

/**
 * Render text with every glossary term turned into a tappable definition.
 *
 * The explanations have to use words like "past participle" and "collocation"
 * to be precise, and those are exactly the words a learner at this level does
 * not know. Underlining them in place means the answer is one tap away instead
 * of a trip to a search engine — and any other word can still be selected and
 * looked up.
 */
export default function ExplainText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { look } = useLookup();

  const parts = useMemo(() => {
    const out: Array<{ text: string; term: boolean }> = [];
    let last = 0;
    for (const match of text.matchAll(termPattern())) {
      const start = match.index ?? 0;
      if (start > last) out.push({ text: text.slice(last, start), term: false });
      out.push({ text: match[0], term: true });
      last = start + match[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), term: false });
    return out;
  }, [text]);

  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.term ? (
          <button
            key={i}
            type="button"
            onClick={() => look(part.text, text)}
            title={findTerm(part.text)?.short}
            className="cursor-help rounded underline decoration-indigo-400 decoration-dotted decoration-2 underline-offset-4 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
          >
            {part.text}
          </button>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}
