"use client";

import SkillGate from "@/components/SkillGate";
import SpeakingSession from "@/components/speaking/SpeakingSession";

/*
  Speaking is model-marked too, and a visitor gets no model at all — so the
  examiner would ask its questions and then have nothing to say about the
  answers. Locked at the door instead. See lib/entitlements/sessions.ts.
*/
export default function SpeakingPage() {
  return (
    /*
      The width is named here rather than in the gate, because this page is the
      only one whose opening card is narrower than the layout container — see
      the note on SkillGate's className. Locked, the lock is this wide; open,
      the intro card centres itself the same way and the gate adds nothing.
    */
    <SkillGate module="speaking" className="mx-auto max-w-3xl">
      <SpeakingSession />
    </SkillGate>
  );
}
