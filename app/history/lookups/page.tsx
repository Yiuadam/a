"use client";

import Link from "next/link";
import LookupHistoryCard from "@/components/history/LookupHistoryCard";

export default function LookupHistoryPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-[22px]">
            Lookup history
          </h1>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Saved words, their pronunciation and your pinned revision list.
          </p>
        </div>
        <Link href="/history" className="btn-secondary min-h-9 !px-3 text-sm">
          ← History
        </Link>
      </header>

      <LookupHistoryCard />
    </div>
  );
}
