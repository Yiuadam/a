/*
  Practising one part of speaking on its own, rather than the whole interview.

  "Users should be able to choose specifically which part of the speaking
  they want to practice on" — asked while the AI examiner was being built,
  and folded into the same pass because both touch buildInterview and the
  introduction screen. This pins: the full interview is unchanged when
  nothing is chosen, a focused session uses more of its own bank rather than
  less (nothing is trimming it against two parts that are not being asked),
  a mock exam sitting never offers the choice at all, and the two entry
  points — the introduction screen's own control, and the question library's
  per-card and per-topic links — agree on the same query string.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const session = read("components", "speaking", "SpeakingSession.tsx");
const library = read("app", "speaking", "questions", "page.tsx");
const gradeRoute = read("app", "api", "grade", "speaking", "route.ts");
const speakingTopics = JSON.parse(read("data", "speaking-topics.json"));

test("focusPart null is exactly the interview this always built", () => {
  const fn = session.slice(
    session.indexOf("function buildInterview"),
    session.indexOf("if (focusPart === 1)"),
  );
  // The early-return branches for 1/2/3 sit before the unconditional tail
  // below, which is untouched — same two topics sliced to three questions,
  // same card-or-random, same rounding-off question, same 4 Part 3 questions.
  assert.match(fn, /focusPart: SpeakingFocusPart = null/);

  const tail = session.slice(
    session.indexOf("if (focusPart === 3) {"),
    session.indexOf("export default function SpeakingSession"),
  );
  const unconditional = tail.slice(tail.indexOf("}\n\n  const steps: Step[] = [];"));
  assert.match(unconditional, /\.slice\(0, 2\)/);
  assert.match(unconditional, /t\.questions\.slice\(0, 3\)/);
  assert.match(unconditional, /part3\.questions\.slice\(0, 4\)/);
});

test("a focused session uses more of its own bank, not less", () => {
  const part1Branch = session.slice(
    session.indexOf("if (focusPart === 1) {"),
    session.indexOf("if (focusPart === 2) {"),
  );
  // No .slice on the questions — every question under the two chosen topics.
  assert.doesNotMatch(part1Branch, /questions\.slice/);
  assert.match(part1Branch, /t\.questions\.map/);

  const part3Branch = session.slice(
    session.indexOf("if (focusPart === 3) {"),
    session.indexOf("const steps: Step[] = [];"),
  );
  assert.doesNotMatch(part3Branch, /questions\.slice/);
  assert.match(part3Branch, /part3\.questions\.map/);
});

test("a focused Part 2 session is the card and its rounding-off question, same as inside a full interview", () => {
  const part2Branch = session.slice(
    session.indexOf("if (focusPart === 2) {"),
    session.indexOf("if (focusPart === 3) {"),
  );
  assert.match(part2Branch, /card\.followUp\?\.\[0\]/);
  assert.match(part2Branch, /steps\.push\(\{ part: 2, question: roundingOff \}\)/);
});

test("a focused Part 3 session still follows a chosen card's topic, without speaking the card", () => {
  const part3Branch = session.slice(
    session.indexOf("if (focusPart === 3) {"),
    session.indexOf("const steps: Step[] = [];"),
  );
  assert.match(part3Branch, /data\.part3\.find\(\(p\) => p\.topic === card\.topic\)/);
  // The card itself never becomes a Step — only { part: 3, question } ones.
  assert.doesNotMatch(part3Branch, /part: 2/);
});

test("turn timing needs no change for any of this — it was never asked to", () => {
  // decideTurnEnd and decideNudge key on step.part alone; nothing about
  // buildInterview's new branches touches lib/speaking/turn-control.ts.
  const turnControl = read("lib", "speaking", "turn-control.ts");
  assert.doesNotMatch(turnControl, /SpeakingFocusPart|focusPart/);
});

test("the introduction screen offers the choice, and a mock exam sitting never does", () => {
  const intro = session.slice(session.indexOf('if (stage === "intro")'));
  assert.match(intro, /\{!exam && \(/);
  assert.match(intro, /role="tablist"/);
  assert.match(intro, /aria-label="Which part to practise"/);
  assert.match(intro, /FOCUS_PART_OPTIONS\.map/);

  // The state itself is forced null whenever `exam` is present, not merely
  // hidden from view — a hidden control that still changes what gets asked
  // would be the more dangerous bug of the two.
  const state = session.slice(
    session.indexOf("const [focusPart, setFocusPart]"),
    session.indexOf("const micSupported"),
  );
  assert.match(state, /exam\s*\n\s*\? null/);
});

test("the introduction screen and the question library agree on the same query string", () => {
  assert.match(session, /const requestedPart = useSearchParams\(\)\.get\("part"\);/);
  assert.match(session, /buildInterview\(chosenCardId, focusPart\)/);
  assert.match(library, /href="\/speaking\?part=1"/);
  assert.match(library, /href=\{`\/speaking\?part=3&card=\$\{encodeURIComponent\(cardId\)\}`\}/);
});

test("every Part 3 topic in the shipped bank has a Part 2 card to link it from", () => {
  /*
    The question library's Part 3 links depend on this: PART2_CARD_ID_BY_TOPIC
    is built from data.part2 and looked up by data.part3's own topic name. If
    the two ever drift apart, a Part 3 topic silently loses its "Practise this
    discussion" link rather than failing loudly — worth catching here, against
    the real shipped data, rather than only against today's fixtures.
  */
  const cardTopics = new Set(speakingTopics.part2.map((c) => c.topic));
  const missing = speakingTopics.part3.filter((t) => !cardTopics.has(t.topic)).map((t) => t.topic);
  assert.deepEqual(missing, []);
});

test("the marking prompt is honest about a partial sample rather than calling it a full test", () => {
  assert.match(gradeRoute, /partsPresent\.length === 3/);
  assert.match(gradeRoute, /not a full three-part test/);
  assert.doesNotMatch(
    gradeRoute,
    /user: `Full mock speaking test transcript \(Part 1 = interview/,
  );
});
