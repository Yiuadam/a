"use client";

import DrillSection from "@/components/DrillSection";
import grammarData from "@/data/grammar.json";
import type { DrillData } from "@/lib/drills";

const { topics } = grammarData as DrillData;

export default function GrammarPage() {
  return (
    /* See `.drill-dense` in globals.css — five topics across, not two. */
    <div className="drill-dense drill-dense-5">
      <DrillSection
        kind="grammar"
        title="Grammar practice"
        intro="Ten topics, each on a mistake learners make often. Read the rule, then answer the questions."
        topics={topics}
      />
    </div>
  );
}
