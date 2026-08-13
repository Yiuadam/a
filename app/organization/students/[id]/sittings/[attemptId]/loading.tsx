import LoadingIndicator from "@/components/LoadingIndicator";

export default function OrganizationSittingLoading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-3 py-4 sm:px-6 sm:py-8">
      <div className="card flex min-h-40 items-center justify-center rounded-[var(--radius-xl)] p-6">
        <LoadingIndicator label="Loading sitting…" />
      </div>
    </main>
  );
}
