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
        title="Grammar practice"
        intro="Ten topics on the mistakes learners make most. Read the rule, then drill it."
        topics={topics}
      />
    </div>
  );
}
