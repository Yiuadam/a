"use client";

import DrillSection from "@/components/DrillSection";
import grammarData from "@/data/grammar.json";
import type { DrillData } from "@/lib/drills";

const { topics } = grammarData as DrillData;

export default function GrammarPage() {
  return (
    <DrillSection
      title="Grammar practice"
      intro="Ten topics covering the grammar mistakes learners make most. Read the rule, then drill it — with the reason after every answer."
      topics={topics}
    />
  );
}
