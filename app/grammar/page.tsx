"use client";

import DrillSection from "@/components/DrillSection";
import grammarData from "@/data/grammar.json";
import type { DrillData } from "@/lib/drills";

const { topics } = grammarData as DrillData;

export default function GrammarPage() {
  return (
    <DrillSection
      title="Grammar practice"
      intro="Ten topics that account for most of the grammar errors English learners actually make. Each one starts with the rule in a few lines, then drills it — you answer, find out straight away whether you were right, and read why. This is not exam practice: it is the underlying grammar, useful whether or not you ever sit IELTS."
      topics={topics}
    />
  );
}
