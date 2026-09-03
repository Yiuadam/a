"use client";

import { useState } from "react";
import { removeGeneratedTest } from "@/lib/store";

/*
  Throwing away a test you generated.

  ---------------------------------------------------------------------------
  Why it is this quiet

  These cards sit in a grid with the hand-written papers and are read the same
  way — a title, a topic, a question count. A delete control has to be reachable
  without becoming part of that reading. So it is a small cross in the corner,
  drawn at low contrast, and it comes up to full strength on hover and on focus.
  On touch, where there is no hover, it stays at the lower strength rather than
  disappearing: a control you cannot discover is not a control.

  ---------------------------------------------------------------------------
  A sibling of the card, never a child

  The card is a link. A button inside a link is invalid HTML and behaves
  differently in every browser — some fire both, some fire neither. So this is
  positioned over the card as a sibling, and the card's own padding is what
  keeps the title from running underneath it.

  ---------------------------------------------------------------------------
  Two taps, not a dialog

  The second tap is the confirmation, and the cross becomes the word "Delete?"
  while it waits. A window.confirm cannot be styled, cannot say which card it
  means, and on iOS arrives detached from the thing it is about. Nothing here
  is recoverable — a generated test exists only in this browser — so it is
  worth the second tap and not worth a modal.
*/

export default function DeleteGenerated({ id, title }: { id: string; title: string }) {
  const [armed, setArmed] = useState(false);

  if (armed) {
    return (
      <span className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1">
        <button
          type="button"
          onClick={() => removeGeneratedTest(id)}
          className="rounded-full bg-rose-600 px-2 py-0.5 text-[0.6875rem] font-semibold text-white shadow-sm hover:bg-rose-700"
        >
          Delete?
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          aria-label="Keep it"
          className="rounded-full bg-surface px-1.5 py-0.5 text-[0.6875rem] font-medium text-slate-600 shadow-sm ring-1 ring-slate-200 hover:text-slate-900"
        >
          No
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      /* Named, because a bare cross in a grid of cards says nothing about
         which card it belongs to when it is the only thing announced. */
      aria-label={`Delete ${title}, a test you generated`}
      className="absolute right-1 top-1 z-10 rounded-full p-1 text-slate-300 opacity-70 transition hover:bg-slate-100 hover:text-slate-600 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-600"
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}
