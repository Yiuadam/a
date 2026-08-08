import type { Metadata } from "next";
import TutorChat from "@/components/TutorChat";

/*
  A server component wrapping a client one, for the same reason app/account and
  app/privacy are: `export const metadata` is only legal here, and this is a
  destination in the header nav, so it needs a title and a description of its
  own rather than inheriting the app's. All the behaviour lives in
  components/TutorChat.tsx.

  The description is careful about what it promises. "Study assistant" and not
  "examiner", because the App Store listing, the page copy and the system
  prompt all have to say the same thing — the moment one of them claims a
  credential the app does not have, the honest ones stop counting.
*/

export const metadata: Metadata = {
  title: "Ask a tutor — BandUp",
  description:
    "Ask a study assistant anything about preparing for IELTS — task requirements, grammar, vocabulary and study strategy. Answers written for a learner, not a textbook.",
};

export default function ChatPage() {
  return <TutorChat />;
}
