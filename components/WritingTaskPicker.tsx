"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { WritingTask } from "@/lib/types";

export default function WritingTaskPicker({
  tasks,
  value,
  onChange,
}: {
  tasks: WritingTask[];
  value: string;
  onChange: (taskId: string) => void;
}) {
  const selectedIndex = Math.max(
    0,
    tasks.findIndex((task) => task.id === value),
  );
  const selected = tasks[selectedIndex];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const typeaheadRef = useRef({ query: "", at: 0 });
  const id = useId();
  const labelId = `${id}-label`;
  const listId = `${id}-listbox`;

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!selected) return null;

  const openList = () => {
    setActiveIndex(selectedIndex);
    setOpen(true);
    requestAnimationFrame(() => listRef.current?.focus());
  };

  const closeList = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (index: number) => {
    const next = tasks[index];
    if (!next) return;
    if (next.id !== value) onChange(next.id);
    closeList(true);
  };

  const moveActive = (index: number) => {
    const count = tasks.length;
    if (count === 0) return;
    setActiveIndex((index + count) % count);
  };

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(activeIndex + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveActive(activeIndex - 1);
        return;
      case "Home":
        event.preventDefault();
        moveActive(0);
        return;
      case "End":
        event.preventDefault();
        moveActive(tasks.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(activeIndex);
        return;
      case "Escape":
        event.preventDefault();
        closeList(true);
        return;
      case "Tab":
        setOpen(false);
        return;
    }

    if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;

    const now = event.timeStamp;
    const previous = typeaheadRef.current;
    const query = `${now - previous.at > 700 ? "" : previous.query}${event.key.toLowerCase()}`;
    typeaheadRef.current = { query, at: now };
    const match = tasks.findIndex((task) => task.title.toLowerCase().startsWith(query));
    if (match >= 0) {
      event.preventDefault();
      moveActive(match);
    }
  };

  return (
    <div ref={rootRef} className="min-w-0">
      <span
        id={labelId}
        className="mb-1 block text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500"
      >
        Choose a task
      </span>

      <button
        ref={triggerRef}
        type="button"
        aria-labelledby={`${labelId} ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) closeList();
            else openList();
          }
        }}
        className="exam-glass group relative flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl border px-3.5 py-2 text-left text-[color:var(--exam-fg)] transition-[border-color,background-color,box-shadow] hover:bg-[color:var(--exam-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--exam-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--exam-bg)]"
      >
        <span id={`${id}-value`} className="min-w-0 flex-1">
          <span className="block truncate text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--exam-muted)]">
            Task {selected.task} · {selected.variant}
          </span>
          <span className="block truncate text-sm font-medium">{selected.title}</span>
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          className={`size-4 shrink-0 text-[color:var(--exam-muted)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="m5.5 7.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelId}
          aria-activedescendant={`${id}-option-${activeIndex}`}
          onKeyDown={handleListKeyDown}
          className="exam-glass relative z-20 mt-1.5 max-h-[min(18rem,42dvh)] w-full min-w-0 overflow-y-auto overscroll-contain rounded-xl border p-1 shadow-[0_16px_34px_-22px_rgba(0,0,0,0.48)] focus:outline-none"
        >
          {tasks.map((option, index) => {
            const isSelected = option.id === value;
            const isActive = index === activeIndex;

            return (
              <div
                key={option.id}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                onPointerMove={() => setActiveIndex(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
                className={`flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                  isActive ? "bg-[color:var(--exam-hover)] text-[color:var(--exam-fg)]" : "text-[color:var(--exam-muted)]"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.625rem] font-semibold uppercase tracking-[0.08em]">
                    Task {option.task} · {option.variant}
                  </span>
                  <span className="block break-words text-sm font-medium leading-5 text-[color:var(--exam-fg)]">
                    {option.title}
                  </span>
                </span>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  className={`size-4 shrink-0 text-[color:var(--exam-accent)] ${isSelected ? "opacity-100" : "opacity-0"}`}
                >
                  <path d="m4.5 10.25 3.25 3.25 7.75-7.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
