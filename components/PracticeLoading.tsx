export default function PracticeLoading({ kind }: { kind: "Reading" | "Listening" }) {
  return (
    <div
      role="status"
      className="mx-auto flex h-[calc(100dvh-3.75rem)] w-full max-w-7xl items-start px-4 py-5 sm:px-6"
    >
      <div className="card w-full !p-4">
        <h1 className="text-xl font-semibold text-slate-900">{kind} practice</h1>
        <p className="mt-1 text-sm text-slate-600">Opening your practice papers…</p>
      </div>
    </div>
  );
}
