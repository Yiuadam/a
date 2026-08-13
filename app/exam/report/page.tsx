"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ProfileFields } from "@/components/account/types";
import LoadingIndicator from "@/components/LoadingIndicator";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import { bandLabel } from "@/lib/band";
import { useProfile } from "@/lib/hooks";
import type { MockExamReport } from "@/lib/types";

const EMPTY_IDENTITY: ProfileFields = {
  displayName: null,
  username: null,
  accountKind: null,
  birthDate: null,
  avatarUrl: null,
  email: null,
};

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { day: "2-digit", month: "long", year: "numeric" })
    : "Not recorded";
}

function shortReference(id: string): string {
  return `BU-${id.replace(/^mock-/, "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(-12)}`;
}

function achievement(band: number | null): string {
  if (band === null) return "Certificate of completion";
  if (band >= 8) return "Exceptional practice achievement";
  if (band >= 7) return "Strong practice achievement";
  if (band >= 6) return "Skilled practice achievement";
  if (band >= 5) return "Developing practice achievement";
  return "Determined practice achievement";
}

function bandText(value: number | null): string {
  return value === null ? "Not marked" : value.toFixed(value % 1 === 0 ? 0 : 1);
}

function CandidateDetails({
  report,
  identity,
}: {
  report: MockExamReport;
  identity: ProfileFields;
}) {
  const name = identity.displayName?.trim() || identity.email || "BandUp learner";
  return (
    <dl className="mock-report-details">
      <div>
        <dt>Candidate name</dt>
        <dd>{name}</dd>
      </div>
      <div>
        <dt>Date of birth</dt>
        <dd>{identity.birthDate ? displayDate(identity.birthDate) : "Not provided"}</dd>
      </div>
      <div>
        <dt>Test date</dt>
        <dd>{displayDate(report.completedAt)}</dd>
      </div>
      <div>
        <dt>Report reference</dt>
        <dd>{shortReference(report.id)}</dd>
      </div>
    </dl>
  );
}

function Certificate({ report, identity }: { report: MockExamReport; identity: ProfileFields }) {
  const name = identity.displayName?.trim() || identity.email || "BandUp learner";
  return (
    <article className="mock-print-page mock-certificate" aria-label="BandUp mock exam certificate">
      <div className="mock-certificate-frame">
        <div className="mock-document-brand">BandUp</div>
        <p className="mock-document-kicker">Certificate of achievement</p>
        <h1>Full mock exam</h1>
        <p className="mock-certificate-intro">This certificate is presented to</p>
        <p className="mock-certificate-name">{name}</p>
        <p className="mock-certificate-copy">
          for completing a full four-skill BandUp practice examination on {displayDate(report.completedAt)}.
        </p>
        <div className="mock-certificate-score">
          <span>{report.marks.overall === null ? "Completed" : bandText(report.marks.overall)}</span>
          <small>{achievement(report.marks.overall)}</small>
        </div>
        <div className="mock-certificate-footer">
          <span>{shortReference(report.id)}</span>
          <span>BandUp practice award</span>
        </div>
        <p className="mock-document-disclaimer">
          Practice certificate only. This is not an IELTS Test Report Form and is not issued or endorsed by IELTS,
          the British Council, IDP or Cambridge English.
        </p>
      </div>
    </article>
  );
}

function ScoreReport({ report, identity }: { report: MockExamReport; identity: ProfileFields }) {
  const rows = [
    ["Listening", report.marks.listening],
    ["Reading", report.marks.reading],
    ["Writing", report.marks.writing],
    ["Speaking", report.marks.speaking],
  ] as const;

  return (
    <article className="mock-print-page mock-score-report" aria-label="BandUp mock exam score report">
      <header className="mock-score-header">
        <div>
          <div className="mock-document-brand">BandUp</div>
          <p className="mock-document-kicker">Full mock exam</p>
          <h1>Practice score report</h1>
        </div>
        <div className="mock-score-overall">
          <span>Overall</span>
          <strong>{bandText(report.marks.overall)}</strong>
          <small>{report.marks.overall === null ? "Incomplete marking" : bandLabel(report.marks.overall)}</small>
        </div>
      </header>

      <CandidateDetails report={report} identity={identity} />

      <section className="mock-score-grid" aria-label="Module bands">
        {rows.map(([label, mark]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{bandText(mark?.band ?? null)}</strong>
            <small>
              {mark?.raw !== undefined && mark.total !== undefined
                ? `${mark.raw} of ${mark.total} correct`
                : mark
                  ? bandLabel(mark.band)
                  : "No band available"}
            </small>
          </div>
        ))}
      </section>

      <section className="mock-report-note">
        <h2>How to read this report</h2>
        <p>
          These bands are BandUp practice estimates. The overall band is shown only when all four modules were
          marked, and is the mean of the four module bands rounded to the nearest half band.
        </p>
        {report.marks.unmarked.length > 0 ? (
          <p>
            No overall band is claimed because {report.marks.unmarked.join(" and ")} could not be marked in this
            sitting.
          </p>
        ) : null}
      </section>

      <footer className="mock-score-footer">
        <span>Generated {displayDate(report.completedAt)}</span>
        <span>{shortReference(report.id)}</span>
      </footer>
      <p className="mock-document-disclaimer">
        Independent practice report only. Not an official IELTS result and not proof of an IELTS qualification.
      </p>
    </article>
  );
}

function MockExamReportContent() {
  const searchParams = useSearchParams();
  const profile = useProfile();
  const [identity, setIdentity] = useState<ProfileFields>(EMPTY_IDENTITY);
  const [identityReady, setIdentityReady] = useState(false);

  const id = searchParams.get("id");
  const report = profile.mockReports?.find((item) => item.id === id);

  useEffect(() => {
    let alive = true;
    authedFetch(apiUrl("/api/account/profile"))
      .then(async (response) => (response.ok ? ((await response.json()) as ProfileFields) : EMPTY_IDENTITY))
      .then((next) => {
        if (alive) setIdentity(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setIdentityReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!report) {
    return (
      <div className="mx-auto max-w-xl card space-y-3 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Report not found</h1>
        <p className="text-sm leading-6 text-slate-600">
          This mock report may have been cleared, or it belongs to another account.
        </p>
        <Link href="/history" className="btn-primary">
          Back to history
        </Link>
      </div>
    );
  }

  return (
    <div className="mock-report-screen space-y-4">
      <div className="mock-report-toolbar card flex flex-wrap items-center justify-between gap-3 !p-3">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Certificate and score report</h1>
          <p className="text-xs leading-5 text-slate-500">Two A4 pages, ready to print or save as PDF.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            onClick={() => window.print()}
            disabled={!identityReady}
          >
            {identityReady ? "Print or save PDF" : <LoadingIndicator label="Loading your details…" announce={false} />}
          </button>
          <Link href="/history" className="btn-secondary">
            Back to history
          </Link>
        </div>
      </div>
      <div id="mock-report-document" className="space-y-5">
        <Certificate report={report} identity={identity} />
        <ScoreReport report={report} identity={identity} />
      </div>
    </div>
  );
}

export default function MockExamReportPage() {
  return (
    <Suspense fallback={null}>
      <MockExamReportContent />
    </Suspense>
  );
}
