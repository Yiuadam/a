"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ADMIN_OVERVIEW_CHART_IDS,
  defaultAdminOverviewPreference,
  parseAdminOverviewPreference,
  readAdminOverviewSnapshot,
  resetAdminOverviewPreference,
  subscribeToAdminOverview,
  writeAdminOverviewPreference,
  type AdminOverviewChartId,
  type AdminOverviewPreference,
  type AdminOverviewSlot,
} from "@/lib/admin/overview";

export interface AdminOverviewChartOption {
  id: AdminOverviewChartId;
  label: string;
  description: string;
  /** Omit the content when this data source could not be read. */
  content: ReactNode;
}

const serverSnapshot = () => null;

/*
  Two deliberately small slots, rather than a draggable dashboard builder.
  The owner can replace either chart or hide it, while the overview remains a
  glanceable page and every choice remains usable from a keyboard or phone.

  The registry is a prop because finance data is loaded elsewhere. It supports
  all four stable chart ids now, without this component ever inventing a
  revenue or cost figure just to fill a choice in the menu.
*/
export default function AdminOverviewCharts({
  options,
}: {
  options: readonly AdminOverviewChartOption[];
}) {
  const registry = useMemo(() => {
    const known = new Set<string>(ADMIN_OVERVIEW_CHART_IDS);
    const unique = new Map<AdminOverviewChartId, AdminOverviewChartOption>();
    for (const option of options) {
      if (known.has(option.id) && !unique.has(option.id)) unique.set(option.id, option);
    }
    return [...unique.values()];
  }, [options]);
  const available = useMemo(() => registry.map((option) => option.id), [registry]);
  const stored = useSyncExternalStore(
    subscribeToAdminOverview,
    readAdminOverviewSnapshot,
    serverSnapshot,
  );
  const preference = parseAdminOverviewPreference(stored, available);
  const defaults = defaultAdminOverviewPreference(available);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AdminOverviewPreference>(defaults);
  const [storageProblem, setStorageProblem] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const shown = preference.slots.flatMap((slot) => {
    if (slot === "none") return [];
    const option = registry.find((candidate) => candidate.id === slot);
    return option ? [option] : [];
  });

  useEffect(() => {
    if (!open) return;
    const returnFocusTo = document.activeElement as HTMLElement | null;
    const focusFrame = window.requestAnimationFrame(() => panelRef.current?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      );
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      returnFocusTo?.focus?.();
    };
  }, [open]);

  function openChooser() {
    setDraft(preference);
    setStorageProblem(null);
    setOpen(true);
  }

  function choose(slotIndex: 0 | 1, value: AdminOverviewSlot) {
    setDraft((current) => {
      const otherIndex = slotIndex === 0 ? 1 : 0;
      if (value !== "none" && current.slots[otherIndex] === value) return current;
      const slots: [AdminOverviewSlot, AdminOverviewSlot] = [...current.slots];
      slots[slotIndex] = value;
      return { version: 1, slots };
    });
  }

  function save() {
    if (!writeAdminOverviewPreference(draft)) {
      setStorageProblem("This browser blocked the setting, so it was not saved.");
      return;
    }
    setOpen(false);
  }

  function reset() {
    const next = defaultAdminOverviewPreference(available);
    if (!resetAdminOverviewPreference()) {
      setStorageProblem("This browser blocked the setting, so it was not reset.");
      return;
    }
    setDraft(next);
    setStorageProblem(null);
  }

  return (
    <section aria-labelledby="admin-overview-charts-heading">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="admin-overview-charts-heading" className="text-[11px] font-medium text-slate-500">
          Overview charts
        </h2>
        <button
          type="button"
          onClick={openChooser}
          aria-haspopup="dialog"
          className="liquid-glass rounded-full border border-slate-200 bg-surface px-3 py-1.5 text-[11px] font-medium text-indigo-700 hover:text-indigo-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
        >
          Customise
        </button>
      </div>

      {shown.length > 0 ? (
        <div className={`grid gap-3 ${shown.length > 1 ? "lg:grid-cols-2" : ""}`}>
          {shown.map((option) => (
            <div key={option.id} className="min-w-0">
              {option.content ?? <UnavailableChart label={option.label} />}
            </div>
          ))}
        </div>
      ) : (
        <div className="card rounded-2xl border border-dashed border-slate-300 bg-surface/70 px-4 py-5 text-center">
          <p className="text-sm font-medium text-slate-700">No overview charts selected</p>
          <p className="mt-1 text-xs text-slate-500">Use Customise to add one or two.</p>
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-chart-chooser-title"
            aria-describedby="admin-chart-chooser-description"
            tabIndex={-1}
            className="liquid-glass max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-[var(--radius-2xl)] border border-slate-200 bg-surface p-4 shadow-xl focus:outline-none sm:p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="admin-chart-chooser-title" className="text-base font-semibold text-slate-900">
                  Customise overview
                </h2>
                <p
                  id="admin-chart-chooser-description"
                  className="mt-1 text-[13px] leading-5 text-slate-600"
                >
                  Pick up to two different charts. This layout is saved only in this browser.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close chart chooser"
                className="liquid-glass flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 text-xl leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
              >
                ×
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ChartSlot
                index={0}
                title="First chart"
                selected={draft.slots[0]}
                taken={draft.slots[1]}
                options={registry}
                onChoose={(value) => choose(0, value)}
              />
              <ChartSlot
                index={1}
                title="Second chart"
                selected={draft.slots[1]}
                taken={draft.slots[0]}
                options={registry}
                onChoose={(value) => choose(1, value)}
              />
            </div>

            {storageProblem && (
              <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-[13px] text-rose-800">
                {storageProblem}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
              <button type="button" onClick={reset} className="btn-secondary">
                Reset
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
                  Cancel
                </button>
                <button type="button" onClick={save} className="btn-primary">
                  Save layout
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ChartSlot({
  index,
  title,
  selected,
  taken,
  options,
  onChoose,
}: {
  index: 0 | 1;
  title: string;
  selected: AdminOverviewSlot;
  taken: AdminOverviewSlot;
  options: readonly AdminOverviewChartOption[];
  onChoose: (value: AdminOverviewSlot) => void;
}) {
  const choices: Array<{
    id: AdminOverviewSlot;
    label: string;
    description: string;
  }> = [
    ...options,
    { id: "none", label: "None", description: "Hide this chart slot." },
  ];

  return (
    <fieldset className="card rounded-2xl border border-slate-200 p-3">
      <legend className="px-1 text-xs font-semibold text-slate-700">{title}</legend>
      <div className="space-y-1.5">
        {choices.map((choice) => {
          const disabled = choice.id !== "none" && choice.id === taken;
          const checked = selected === choice.id;
          return (
            <label
              key={choice.id}
              className={`flex cursor-pointer gap-2.5 rounded-xl border px-3 py-2 transition-colors ${
                checked
                  ? "border-indigo-400 bg-indigo-50/70"
                  : "border-transparent hover:border-slate-200 hover:bg-slate-50"
              } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
            >
              <input
                type="radio"
                name={`admin-overview-slot-${index}`}
                value={choice.id}
                checked={checked}
                disabled={disabled}
                onChange={() => onChoose(choice.id)}
                className="mt-0.5 accent-indigo-600"
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-slate-800">{choice.label}</span>
                <span className="block text-[11px] leading-4 text-slate-500">
                  {disabled ? "Already used in the other slot." : choice.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function UnavailableChart({ label }: { label: string }) {
  return (
    <section className="card rounded-2xl border border-slate-200 bg-surface px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{label}</p>
      <p className="mt-1 text-xs leading-5 text-slate-400">This figure could not be read just now.</p>
    </section>
  );
}
