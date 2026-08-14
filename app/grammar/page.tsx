"use client";

import DrillSection from "@/components/DrillSection";
import grammarData from "@/data/grammar.json";
import type { DrillData } from "@/lib/drills";

const { topics } = grammarData as DrillData;

export default function GrammarPage() {
  return (
    <div data-grammar-practice>
      <DrillSection
        compact
        compactColumns={5}
        kind="grammar"
        title="Grammar practice"
        intro="Ten topics, each on a mistake learners make often. Read the rule, then answer the questions."
        topics={topics}
      />
    </div>
  );
}
