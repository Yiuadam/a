export default function NewBadge({ show = true }: { show?: boolean }) {
  if (!show) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500"
      aria-label="New — not completed yet"
    >
      New
    </span>
  );
}
