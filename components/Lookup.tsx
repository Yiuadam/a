"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import LoadingIndicator from "@/components/LoadingIndicator";
import { postJSON } from "@/lib/api";
import { findTerm } from "@/lib/glossary";
import { type Definition, cachedLookup, saveLookup } from "@/lib/lookups";

type PanelState =
  | { status: "closed" }
  | { status: "loading"; term: string }
  | { status: "ready"; definition: Definition }
  | { status: "error"; term: string; message: string };

interface LookupApi {
  /** Open the panel for a word or phrase. `context` is the sentence it came from. */
  look: (term: string, context?: string) => void;
}

const LookupContext = createContext<LookupApi | null>(null);

export function useLookup(): LookupApi {
  const api = useContext(LookupContext);
  // Rendering outside the provider should degrade to nothing, not crash.
  return api ?? { look: () => {} };
}

/** Reject selections that are clearly not a word or phrase to look up. */
function usableSelection(text: string): boolean {
  const clean = text.trim();
  if (clean.length < 2 || clean.length > 120) return false;
  if (clean.split(/\s+/).length > 8) return false;
  return /[a-zA-Z]/.test(clean);
}

/** The sentence a selection sits in, so the AI can explain it in context. */
function sentenceAround(selection: Selection, term: string): string {
  const block = selection.anchorNode?.parentElement?.closest("p, li, span, div");
  const text = block?.textContent ?? "";
  if (!text) return "";
  const at = text.indexOf(term);
  if (at < 0) return text.slice(0, 400);
  const start = Math.max(0, text.lastIndexOf(".", at) + 1);
  const stop = text.indexOf(".", at + term.length);
  return text.slice(start, stop < 0 ? text.length : stop + 1).trim().slice(0, 400);
}

export default function LookupProvider({ children }: { children: React.ReactNode }) {
  const [panel, setPanel] = useState<PanelState>({ status: "closed" });
  const [pill, setPill] = useState<{ x: number; y: number; text: string; context: string } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  // Only the newest request may write to the panel; an earlier slow lookup
  // must not overwrite the answer the user is currently reading.
  const requestId = useRef(0);
  const pillRef = useRef<HTMLButtonElement | null>(null);

  const look = useCallback((term: string, context?: string) => {
    const clean = term.trim().replace(/\s+/g, " ");
    if (!clean) return;
    setPill(null);

    const id = ++requestId.current;

    const local = findTerm(clean);
    if (local) {
      setPanel({
        status: "ready",
        definition: {
          term: local.term,
          short: local.short,
          example: local.example,
          source: "glossary",
        },
      });
      return;
    }

    const cached = cachedLookup(clean);
    if (cached) {
      setPanel({ status: "ready", definition: { ...cached, source: "cache" } });
      return;
    }

    setPanel({ status: "loading", term: clean });
    postJSON<{ definition: Omit<Definition, "source"> }>("/api/define", {
      term: clean,
      context: context?.slice(0, 400),
    })
      .then((data) => {
        if (requestId.current !== id) return;
        const definition: Definition = {
          ...data.definition,
          term: clean,
          source: "ai",
          at: new Date().toISOString(),
        };
        saveLookup(definition);
        setPanel({ status: "ready", definition });
      })
      .catch((err: unknown) => {
        if (requestId.current !== id) return;
        setPanel({
          status: "error",
          term: clean,
          message: err instanceof Error ? err.message : "Lookup failed.",
        });
      });
  }, []);

  const close = useCallback(() => {
    requestId.current += 1;
    setQuery("");
    setPanel({ status: "closed" });
  }, []);

  /*
    Watch for a text selection inside a lookup-able region and offer a pill.
    This is an event listener rather than a render-time computation because the
    selection lives in the DOM, not in React state.
  */
  useEffect(() => {
    const onSelect = (event: Event) => {
      // Pressing the pill itself must not be treated as "the selection
      // changed" — that would hide the pill before its own handler ran.
      if (pillRef.current?.contains(event.target as Node)) return;

      const selection = window.getSelection();
      const text = selection?.toString() ?? "";
      if (!selection || selection.isCollapsed || !usableSelection(text)) {
        setPill(null);
        return;
      }
      const node = selection.anchorNode;
      const element =
        node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
      if (!element?.closest("[data-lookupable]")) {
        setPill(null);
        return;
      }
      // Selecting inside a field means the user is editing, not reading.
      if (element.closest("input, textarea, [contenteditable='true']")) {
        setPill(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setPill(null);
        return;
      }
      const clean = text.trim();
      setPill({
        // Keep the pill on screen when the selection sits near an edge.
        x: Math.min(window.innerWidth - 110, Math.max(110, rect.left + rect.width / 2)),
        y: rect.top,
        text: clean,
        context: sentenceAround(selection, clean),
      });
    };

    const clear = () => setPill(null);
    document.addEventListener("mouseup", onSelect);
    document.addEventListener("touchend", onSelect);
    document.addEventListener("scroll", clear, true);
    return () => {
      document.removeEventListener("mouseup", onSelect);
      document.removeEventListener("touchend", onSelect);
      document.removeEventListener("scroll", clear, true);
    };
  }, []);

  const api = useMemo<LookupApi>(() => ({ look }), [look]);

  const submitQuery = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) look(query);
  };

  return (
    <LookupContext.Provider value={api}>
      {children}

      {pill && (
        <button
          ref={pillRef}
          type="button"
          /*
            pointerdown, not click.

            Pressing the pill collapses the text selection, which fires the
            document's mouseup handler, which hides the pill — so React
            unmounts the button before its click event is ever delivered, and
            nothing happens. Acting on pointerdown runs before any of that, and
            preventDefault stops the browser clearing the selection at all.
          */
          onPointerDown={(e) => {
            e.preventDefault();
            look(pill.text, pill.context);
          }}
          style={{ left: pill.x, top: Math.max(8, pill.y - 46) }}
          className="fixed z-40 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2.5 text-xs font-medium text-slate-50 shadow-lg"
        >
          🔍 Look up “{pill.text.length > 22 ? `${pill.text.slice(0, 22)}…` : pill.text}”
        </button>
      )}

      {panel.status !== "closed" && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
          />
          <div className="card relative m-0 w-full max-w-lg rounded-b-none sm:m-4 sm:rounded-2xl">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                {panel.status === "ready" ? panel.definition.term : panel.term}
              </h2>
              <button
                type="button"
                onClick={close}
                className="-mr-2 -mt-1 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {panel.status === "loading" && (
              <p className="mt-4 text-sm text-slate-500"><LoadingIndicator label="Looking it up…" /></p>
            )}

            {panel.status === "error" && (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-slate-600">{panel.message}</p>
                <p className="text-xs text-slate-400">
                  Grammar and exam terms still work without a connection — they are the ones
                  underlined in the explanations.
                </p>
              </div>
            )}

            {panel.status === "ready" && (
              <div className="mt-3 space-y-3">
                {panel.definition.partOfSpeech && (
                  <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs italic text-slate-500">
                    {panel.definition.partOfSpeech}
                  </span>
                )}
                <p className="text-[15px] leading-7 text-slate-800">{panel.definition.short}</p>
                {panel.definition.example && (
                  <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm italic leading-6 text-indigo-800">
                    {panel.definition.example}
                  </p>
                )}
                {panel.definition.inContext && (
                  <p className="text-sm leading-6 text-slate-600">
                    <span className="font-medium text-slate-700">Here: </span>
                    {panel.definition.inContext}
                  </p>
                )}
                <p className="text-xs text-slate-400">
                  {panel.definition.source === "glossary"
                    ? "From the built-in grammar glossary."
                    : "Explained by the AI tutor and saved to your word list."}
                </p>
              </div>
            )}

            {/* Looking a word up usually raises another one, so the panel
                takes a typed word too rather than making you go and find it. */}
            <form onSubmit={submitQuery} className="mt-5 flex gap-2 border-t border-slate-200 pt-4">
              <input
                className="input flex-1"
                placeholder="Look up another word…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Look up another word"
              />
              <button type="submit" className="btn-primary" disabled={!query.trim()}>
                Look up
              </button>
            </form>
          </div>
        </div>
      )}
    </LookupContext.Provider>
  );
}
