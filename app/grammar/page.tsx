"use client";

import DrillIndex, { type IndexTopic } from "@/app/_drills/DrillIndex";
import grammarData from "@/data/grammar.json";

const { topics } = grammarData as { topics: IndexTopic[] };

export default function GrammarPage() {
  return (
    <DrillIndex
      title="Grammar practice"
      intro="Ten grammar points learners get wrong most often."
      topics={topics}
    />
  );
}
