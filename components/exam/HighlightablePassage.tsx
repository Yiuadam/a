"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
  The passage, with the highlighter the computer-delivered exam gives you.

  This is not decoration. In a real reading paper a candidate marks the places
  they have already checked against a question, so that on the second pass —
  and there is always a second pass, with sixty minutes and forty questions —
  they are not rereading paragraphs they have already ruled out. Without it the
  paper is harder here than it is on the day, which is the wrong direction for
  a practice tool to be wrong in.

  ---------------------------------------------------------------------------
  What a highlight is, and why it is stored per paragraph

  A range of characters inside one paragraph. A selection dragged across a
  paragraph break becomes two ranges rather than one, which costs nothing and
  avoids the whole class of bugs where an offset is measured against a string
  that includes markup, or against a paragraph that has since been re-split.
  The paragraph index and the offsets within it survive any amount of
  re-rendering, because they describe the text rather than the DOM.

  ---------------------------------------------------------------------------
  Why sessionStorage and not the session object

  A highlight belongs to the sitting, and the sitting already lives in
  sessionStorage — so a reload during an exam keeps the marks, and closing the
  tab loses them along with everything else, which is what walking out of an
  exam does. Keeping them beside the session rather than inside it means
  MockSession's stored shape is untouched, and a version this build does not
  recognise cannot be created by somebody dragging a cursor.
*/

interface Range {
  /** Which paragraph, by index in the split passage. */
  p: number;
  start: number;
  end: number;
}

function keyFor(testId: string): string {
  return `bandup.exam.highlights.${testId}`;
}

function load(testId: string): Range[] {
  try {
    const raw = window.sessionStorage.getItem(keyFor(testId));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (r): r is Range =>
        typeof r === "object" && r !== null &&
        typeof (r as Range).p === "number" &&
        typeof (r as Range).start === "number" &&
        typeof (r as Range).end === "number" &&
        (r as Range).end > (r as Range).start,
    );
  } catch {
    return [];
  }
}

/* Overlapping marks are merged, so dragging over the same words twice does not
   build a stack of ranges that each have to be clicked away separately. */
function merge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].sort((a, b) => a.p - b.p || a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && last.p === r.p && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

export default function HighlightablePassage({
  testId,
  paragraphs,
  heading,
}: {
  testId: string;
  paragraphs: string[];
  heading?: React.ReactNode;
}) {
  const [ranges, setRanges] = useState<Range[]>([]);
  const root = useRef<HTMLDivElement>(null);

  /* Read after mount: sessionStorage does not exist on the server, and the
     first paint has to match what was rendered there. */
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRanges(load(testId)));
    return () => cancelAnimationFrame(frame);
  }, [testId]);

  const save = useCallback(
    (next: Range[]) => {
      const merged = merge(next);
      setRanges(merged);
      try {
        window.sessionStorage.setItem(keyFor(testId), JSON.stringify(merged));
      } catch {
        /* A private window, or storage the browser has refused. The marks still
           work for as long as this page is open; they simply stop surviving a
           reload, which is a smaller loss than refusing to highlight at all. */
      }
    },
    [testId],
  );

  /*
    Read the selection as paragraph-relative offsets.

    `data-paragraph` on each <p> is what makes this possible without walking the
    DOM: the browser hands back a node and an offset inside it, and because a
    paragraph's children are either plain text or a highlight span, the offset
    within the paragraph is the sum of the text before the node plus the offset
    into it.
  */
  const markSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !root.current) return;

    const found: Range[] = [];
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      for (const node of root.current.querySelectorAll<HTMLElement>("[data-paragraph]")) {
        if (!range.intersectsNode(node)) continue;
        const index = Number(node.dataset.paragraph);
        const text = node.textContent ?? "";
        const clipped = range.cloneRange();
        /* Clip the selection to this paragraph, so a drag across three of them
           yields one range in each rather than one impossible range. */
        const whole = document.createRange();
        whole.selectNodeContents(node);
        if (clipped.compareBoundaryPoints(window.Range.START_TO_START, whole) < 0) {
          clipped.setStart(whole.startContainer, whole.startOffset);
        }
        if (clipped.compareBoundaryPoints(window.Range.END_TO_END, whole) > 0) {
          clipped.setEnd(whole.endContainer, whole.endOffset);
        }
        const before = document.createRange();
        before.setStart(whole.startContainer, whole.startOffset);
        before.setEnd(clipped.startContainer, clipped.startOffset);
        const start = before.toString().length;
        const end = start + clipped.toString().length;
        if (end > start && end <= text.length) found.push({ p: index, start, end });
      }
    }
    if (found.length) {
      save([...ranges, ...found]);
      selection.removeAllRanges();
    }
  }, [ranges, save]);

  const clearAt = useCallback(
    (p: number, at: number) => save(ranges.filter((r) => !(r.p === p && at >= r.start && at < r.end))),
    [ranges, save],
  );

  return (
    <div ref={root} className="min-w-0">
      {heading}
      {/*
        `onMouseUp` and `onTouchEnd` rather than a toolbar button: the exam's own
        highlighter marks what is selected the moment the selection is made, and
        a floating button that has to be aimed at is one more thing to do with a
        paper open and a clock running.
      */}
      <div onMouseUp={markSelection} onTouchEnd={markSelection}>
        {paragraphs.map((text, index) => {
          const mine = ranges.filter((r) => r.p === index).sort((a, b) => a.start - b.start);
          if (mine.length === 0) {
            return (
              <p key={index} data-paragraph={index}>
                {text}
              </p>
            );
          }
          const parts: React.ReactNode[] = [];
          let at = 0;
          mine.forEach((r, i) => {
            if (r.start > at) parts.push(text.slice(at, r.start));
            parts.push(
              <mark
                key={`h${i}`}
                className="exam-highlight"
                /* A click removes the mark it is on, which is how the real tool
                   works and what a candidate tries first. */
                onClick={() => clearAt(index, r.start)}
                title="Remove highlight"
              >
                {text.slice(r.start, r.end)}
              </mark>,
            );
            at = r.end;
          });
          if (at < text.length) parts.push(text.slice(at));
          return (
            <p key={index} data-paragraph={index}>
              {parts}
            </p>
          );
        })}
      </div>
    </div>
  );
}
