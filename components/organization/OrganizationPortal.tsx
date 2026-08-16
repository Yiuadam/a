"use client";

import Link from "next/link";
import LoadingIndicator from "@/components/LoadingIndicator";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import {
  memberActionPayload,
  organizationActionPayload,
  organizationDeletionPayload,
  practiceBatchAssignmentPayload,
  teacherBatchAssignmentPayload,
  teacherAssignmentPayload,
} from "@/lib/organizations/action-payloads";
import { ORGANIZATION_PRACTICE_TARGETS } from "@/lib/organizations/practice-assignments";
import type {
  OrganizationAction,
  OrganizationActionResponse,
  OrganizationMembership,
  OrganizationPortal as Portal,
  OrganizationRequest,
} from "@/lib/organizations/types";
import { OrganizationCreateForm, JoinOrganizationForm } from "./OrganizationForms";
import CardIcon, { type CardIconName } from "@/components/CardIcon";
import GlassSelect, { FloatingGlassPopover } from "@/components/GlassSelect";
import RefractiveGlassLayer from "@/components/RefractiveGlassLayer";
import {
  organizationPreviewRequestHeaders,
  type OrganizationLivePreviewRole,
} from "@/lib/organizations/preview-client";
import { sittingReviewHref } from "@/lib/organizations/student-links";
import {
  EmptyState,
  GlassSection,
  Person,
  StatusPill,
  StudentLink,
  formatDate,
  titleCase,
} from "./OrganizationUI";

type Phase = "loading" | "ready" | "signed-out" | "unavailable";
type ManagerView = "overview" | "requests" | "assignments" | "assignment-directory" | "students" | "members" | "team-invite" | "team-assignment" | "team-pairings" | "settings" | "administration";

const MANAGER_VIEWS = new Set<ManagerView>(["overview", "requests", "assignments", "assignment-directory", "students", "members", "team-invite", "team-assignment", "team-pairings", "settings", "administration"]);
const TEAM_MANAGEMENT_VIEWS = new Set<ManagerView>(["members", "team-invite", "team-assignment", "team-pairings"]);
const TARGET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface NotificationFocus {
  kind: "teacher-feedback" | "request" | null;
  id: string | null;
}

function notificationFocusFromLocation(): NotificationFocus {
  if (typeof window === "undefined") return { kind: null, id: null };
  const params = new URLSearchParams(window.location.search);
  const focus = params.get("focus");
  if (focus === "teacher-feedback") {
    const attemptId = params.get("attempt");
    return { kind: focus, id: attemptId && TARGET_ID.test(attemptId) ? attemptId : null };
  }
  const requestId = focus === "request" ? params.get("request") : null;
  return {
    kind: requestId && TARGET_ID.test(requestId) ? "request" : null,
    id: requestId && TARGET_ID.test(requestId) ? requestId : null,
  };
}

function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `org-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function OrganizationPortal({
  preview = null,
  previewRole = null,
  routeOrganizationId = null,
  routeSection = null,
  routeAssignmentStudentId = null,
  routeFocusKind = null,
  routeFocusId = null,
}: {
  preview?: Portal | null;
  previewRole?: OrganizationLivePreviewRole | null;
  routeOrganizationId?: string | null;
  routeSection?: string | null;
  routeAssignmentStudentId?: string | null;
  routeFocusKind?: NotificationFocus["kind"];
  routeFocusId?: string | null;
}) {
  const [phase, setPhase] = useState<Phase>(preview ? "ready" : "loading");
  const [portal, setPortal] = useState<Portal | null>(preview);
  const portalRef = useRef<Portal | null>(preview);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [switchingOrganization, setSwitchingOrganization] = useState(false);
  const [managerView, setManagerView] = useState<ManagerView>(() => (
    routeSection && MANAGER_VIEWS.has(routeSection as ManagerView)
      ? routeSection as ManagerView
      : "overview"
  ));
  const [assignmentStudentId, setAssignmentStudentId] = useState<string | null>(() => (
    routeAssignmentStudentId && TARGET_ID.test(routeAssignmentStudentId) ? routeAssignmentStudentId : null
  ));
  const [notificationFocus, setNotificationFocus] = useState<NotificationFocus>(() => ({
    kind: routeFocusKind && routeFocusId && TARGET_ID.test(routeFocusId) ? routeFocusKind : null,
    id: routeFocusKind && routeFocusId && TARGET_ID.test(routeFocusId) ? routeFocusId : null,
  }));
  // Reuse the same key after an ambiguous network/5xx response. This lets the
  // database return its receipt rather than duplicating a committed request.
  const retryKeys = useRef(new Map<string, string>());

  const load = useCallback(async (selectedOverride?: string | null) => {
    if (preview) return;
    setError(null);
    try {
      const selectedFromLocation = typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("organization");
      // Prefer the live location: the in-page organization switcher updates it
      // without asking the App Router to remount this workspace.
      const selected = selectedOverride !== undefined
        ? selectedOverride
        : selectedFromLocation
          ?? (routeOrganizationId && TARGET_ID.test(routeOrganizationId) ? routeOrganizationId : null);
      const endpoint = selected
        ? `/api/organization?organization=${encodeURIComponent(selected)}`
        : "/api/organization";
      const response = await authedFetch(apiUrl(endpoint), {
        cache: "no-store",
        headers: organizationPreviewRequestHeaders(previewRole),
      });
      if (response.status === 401) {
        setPortal(null);
        setPhase("signed-out");
        return;
      }
      if (!response.ok) throw new Error("Organisations are unavailable right now.");
      const body = (await response.json()) as Portal;
      if (!body.actor || !Array.isArray(body.memberships)) throw new Error("Unexpected response.");
      portalRef.current = body;
      setPortal(body);
      setPhase(body.actor.signedIn ? "ready" : "signed-out");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Organisations are unavailable right now.");
      setPhase("unavailable");
    }
  }, [preview, previewRole, routeOrganizationId]);

  useEffect(() => {
    if (preview) return;
    const frame = requestAnimationFrame(() => void load());
    return () => cancelAnimationFrame(frame);
  }, [load, preview]);

  const openManagerView = useCallback((nextView: ManagerView, replace = false) => {
    setManagerView(nextView);
    if (nextView !== "assignment-directory") setAssignmentStudentId(null);
    setNotificationFocus({ kind: null, id: null });
    const url = new URL(window.location.href);
    if (nextView === "overview") url.searchParams.delete("section");
    else url.searchParams.set("section", nextView);
    if (nextView !== "assignment-directory") url.searchParams.delete("student");
    // These target one specific record in a previous view. Ordinary section
    // changes must not carry them into a different workspace panel.
    for (const parameter of ["focus", "attempt", "request", "requestKind", "invite"]) {
      url.searchParams.delete(parameter);
    }
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (replace) window.history.replaceState(window.history.state, "", nextUrl);
    else window.history.pushState({ ...window.history.state, bandupOrganizationSection: nextView }, "", nextUrl);
  }, []);

  useEffect(() => {
    if (phase !== "ready" || !portal || managerView !== "administration" || portal.actor.platformAdmin) return;
    // The administration destination is deliberately absent for ordinary
    // organisation roles. A copied URL must land on their normal overview,
    // not an empty or partially disclosed platform screen.
    const url = new URL(window.location.href);
    for (const parameter of ["section", "student", "focus", "attempt", "request", "requestKind", "invite"]) {
      url.searchParams.delete(parameter);
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    const frame = requestAnimationFrame(() => {
      setManagerView("overview");
      setAssignmentStudentId(null);
      setNotificationFocus({ kind: null, id: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [managerView, phase, portal]);

  useEffect(() => {
    if (phase !== "ready" || !portal || !TEAM_MANAGEMENT_VIEWS.has(managerView)) return;
    const membership = activeMembership(portal);
    const canManageTeam = (portal.actor.platformAdmin && Boolean(portal.activeOrganizationId)) || (
      membership?.status === "active"
      && (membership.role === "manager" || membership.role === "owner")
    );
    if (canManageTeam) return;
    // Team management has manager/owner permissions. A copied destination
    // must resolve to the ordinary dashboard for teachers and students.
    const url = new URL(window.location.href);
    for (const parameter of ["section", "student", "focus", "attempt", "request", "requestKind", "invite"]) {
      url.searchParams.delete(parameter);
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    const frame = requestAnimationFrame(() => {
      setManagerView("overview");
      setAssignmentStudentId(null);
      setNotificationFocus({ kind: null, id: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [managerView, phase, portal]);

  const openAssignmentDirectory = useCallback((studentId: string | null = null, replace = false) => {
    const selected = studentId && TARGET_ID.test(studentId) ? studentId : null;
    setManagerView("assignment-directory");
    setAssignmentStudentId(selected);
    setNotificationFocus({ kind: null, id: null });
    const url = new URL(window.location.href);
    url.searchParams.set("section", "assignment-directory");
    if (selected) url.searchParams.set("student", selected);
    else url.searchParams.delete("student");
    for (const parameter of ["focus", "attempt", "request", "requestKind", "invite"]) {
      url.searchParams.delete(parameter);
    }
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (replace) window.history.replaceState(window.history.state, "", nextUrl);
    else window.history.pushState({ ...window.history.state, bandupOrganizationSection: "assignment-directory" }, "", nextUrl);
  }, []);

  useEffect(() => {
    const syncView = () => {
      setManagerView(managerViewFromLocation());
      const studentId = new URLSearchParams(window.location.search).get("student");
      setAssignmentStudentId(studentId && TARGET_ID.test(studentId) ? studentId : null);
      setNotificationFocus(notificationFocusFromLocation());
    };
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);

  const selectOrganization = useCallback(async (organizationId: string) => {
    if (!TARGET_ID.test(organizationId) || organizationId === portalRef.current?.activeOrganizationId) return;
    if (preview) {
      /* Local fixtures deliberately carry no second roster. Keep the preview
         selector truthful by clearing organization-scoped lists on selection
         rather than displaying the first fixture's learners as another
         school's data. */
      setPortal((current) => {
        const selectedMembership = current?.memberships.find((item) => (
          item.organization.id === organizationId
          && (item.status === "active" || item.status === "leave_requested")
          && item.organization.status === "active"
        ));
        if (!current || !selectedMembership) return current;
        const selectedPortal = {
          ...current,
          activeOrganizationId: organizationId,
          members: selectedMembership.role === "manager" || selectedMembership.role === "owner" ? [] : null,
          requests: selectedMembership.role === "student" ? null : [],
          students: selectedMembership.role === "student" ? null : [],
          assignments: selectedMembership.role === "manager" || selectedMembership.role === "owner" ? [] : null,
          practiceAssignments: [],
          recentFeedback: [],
        };
        portalRef.current = selectedPortal;
        return selectedPortal;
      });
      setManagerView("overview");
      setAssignmentStudentId(null);
      setNotificationFocus({ kind: null, id: null });
      return;
    }
    setSwitchingOrganization(true);
    setManagerView("overview");
    setAssignmentStudentId(null);
    setNotificationFocus({ kind: null, id: null });
    setError(null);
    setNotice(null);
    const url = new URL(window.location.href);
    url.searchParams.set("organization", organizationId);
    // A section can expose organization-scoped records and role-specific UI.
    // Always land in the new workspace's overview and discard exact-record
    // focus parameters before asking the server to authorize that workspace.
    for (const parameter of ["section", "student", "focus", "attempt", "request", "requestKind", "invite"]) {
      url.searchParams.delete(parameter);
    }
    window.history.pushState(
      { ...window.history.state, bandupOrganizationId: organizationId },
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    try {
      await load();
    } finally {
      setSwitchingOrganization(false);
    }
  }, [load, preview]);

  const act = useCallback(
    async (action: OrganizationAction, payload: Record<string, unknown>): Promise<OrganizationActionResponse | null> => {
      if (busy) return null;
      if (preview || previewRole) {
        setNotice("Preview only — no account was changed.");
        const previewToken = payload.token;
        const previewRequest = payload.requestId;
        return {
          ok: true,
          ...(preview ? { portal: preview } : {}),
          ...(action === "invite_member"
            && typeof previewToken === "string"
            && previewToken.length >= 24
            && (previewRequest === undefined || typeof previewRequest === "string")
            ? { invitation: { requestId: "90000000-0000-4000-8000-000000000001" } }
            : {}),
        };
      }
      setBusy(action);
      setError(null);
      setNotice(null);
      try {
        const retryFingerprint = JSON.stringify([action, payload]);
        let requestKey = retryKeys.current.get(retryFingerprint);
        if (!requestKey) {
          requestKey = idempotencyKey();
          if (retryKeys.current.size >= 20) retryKeys.current.clear();
          retryKeys.current.set(retryFingerprint, requestKey);
        }
        const response = await authedFetch(apiUrl("/api/organization"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...organizationPreviewRequestHeaders(previewRole),
          },
          body: JSON.stringify({ action, payload, idempotencyKey: requestKey }),
        });
        const body = (await response.json().catch(() => null)) as
          | Partial<OrganizationActionResponse>
          | { error?: string }
          | null;
        if (!response.ok) {
          if (response.status < 500) retryKeys.current.delete(retryFingerprint);
          throw new Error(body && "error" in body && body.error ? body.error : "That change could not be saved.");
        }
        // Deleting the selected workspace makes every organization-scoped
        // query parameter stale. Remove it before re-reading so the server can
        // safely select another eligible workspace (or the no-membership
        // state) instead of asking for an organization that no longer exists.
        const deletedSelectedOrganization = (
          action === "delete_organization"
          && typeof payload.organizationId === "string"
          && payload.organizationId === portalRef.current?.activeOrganizationId
        );
        if (deletedSelectedOrganization) {
          const url = new URL(window.location.href);
          for (const parameter of ["organization", "section", "student", "focus", "attempt", "request", "requestKind", "invite"]) {
            url.searchParams.delete(parameter);
          }
          window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
          setManagerView("overview");
          setAssignmentStudentId(null);
          setNotificationFocus({ kind: null, id: null });
        }
        // Commands return a durable database result, not a client-shaped
        // snapshot. Re-read the role-filtered portal after success so every
        // panel is based on the same server-authoritative view.
        await load(deletedSelectedOrganization ? null : undefined);
        retryKeys.current.delete(retryFingerprint);
        setNotice(
          action === "delete_organization"
            ? "Organisation deleted."
            : action === "create_organization"
              ? "Your organisation is ready to use."
              : "Saved.",
        );
        return body && "ok" in body && body.ok === true
          ? body as OrganizationActionResponse
          : null;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "That change could not be saved.");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [busy, load, preview, previewRole],
  );

  if (phase === "loading") return <PortalFrame><Loading /></PortalFrame>;
  if (phase === "signed-out") return <PortalFrame><SignedOut /></PortalFrame>;
  if (phase === "unavailable" || !portal) {
    return (
      <PortalFrame>
        <GlassSection title="Organisations aren’t reachable" lead="Your practice data is safe. No changes were made.">
          <button type="button" className="btn-secondary" onClick={() => { setPhase("loading"); void load(); }}>
            Try again
          </button>
        </GlassSection>
      </PortalFrame>
    );
  }

  const adminWorkspace = portal.actor.platformAdmin && portal.activeOrganizationId
    ? portal.organizations?.find((organization) => organization.id === portal.activeOrganizationId) ?? null
    : null;
  // A platform administrator explicitly opening an organization must retain
  // platform authority even if the same account happens to hold a learner or
  // teacher membership elsewhere.
  const membership = adminWorkspace
    ? portal.memberships.find((item) => item.organization.id === adminWorkspace.id) ?? null
    : activeMembership(portal);
  const role = adminWorkspace ? "owner" : membership?.role ?? null;
  const platformAdministrationView = portal.actor.platformAdmin && managerView === "administration";
  const canManageTeam = (portal.actor.platformAdmin && Boolean(portal.activeOrganizationId)) || (
    membership?.status === "active" && (role === "manager" || role === "owner")
  );
  const visibleManagerView = (managerView === "administration" && !portal.actor.platformAdmin)
    || (TEAM_MANAGEMENT_VIEWS.has(managerView) && !canManageTeam)
      ? "overview"
      : managerView;
  const acting = busy !== null;
  const managerFocused = Boolean((role === "manager" || role === "owner") && visibleManagerView !== "overview");
  const teacherDirectoryFocused = role === "teacher" && visibleManagerView === "assignment-directory";
  // Students share the same query-backed settings destination as managers, but
  // no other manager section is meaningful to them. Treat a copied manager URL
  // as their dashboard rather than leaving the student workspace blank.
  const studentView = visibleManagerView === "settings" ? "settings" : "overview";
  const studentSettingsFocused = role === "student" && studentView === "settings";
  const focusedOrganizationView = managerFocused || teacherDirectoryFocused || studentSettingsFocused;

  return (
    <PortalFrame dashboard={Boolean(membership || adminWorkspace)} preview={Boolean(preview || previewRole)} focused={focusedOrganizationView}>
      {(error || notice) && (
        <div
          role={error ? "alert" : "status"}
          className={`rounded-xl border px-3 py-2 text-xs ${error ? "border-rose-300 bg-rose-50/75 text-rose-800" : "border-emerald-200 bg-emerald-50/70 text-emerald-800"}`}
        >
          {error ?? notice}
        </div>
      )}

      {adminWorkspace ? (
        <AdminWorkspaceSummary
          organization={adminWorkspace}
          portal={portal}
          compact={managerFocused}
          view={visibleManagerView}
          onOpenView={openManagerView}
          onSelectOrganization={selectOrganization}
          switchingOrganization={switchingOrganization}
        />
      ) : membership ? (
        <MembershipSummary
          membership={membership}
          portal={portal}
          compact={(visibleManagerView !== "overview" && (role === "manager" || role === "owner")) || teacherDirectoryFocused || studentSettingsFocused}
          onOpenSettings={() => openManagerView("settings")}
          onSelectOrganization={selectOrganization}
          switchingOrganization={switchingOrganization}
          managerView={role === "student" ? studentView : role === "manager" || role === "owner" ? visibleManagerView : null}
          onOpenManagerView={openManagerView}
        />
      ) : platformAdministrationView ? null : (
        <NoMembership portal={portal} act={act} busy={acting} previewRole={previewRole} />
      )}

      {!platformAdministrationView && role === "student" && membership?.status === "active" && (
        studentView === "settings" ? (
          <StudentOrganizationSettings
            membership={membership}
            act={act}
            busy={acting}
            onBack={() => openManagerView("overview", true)}
          />
        ) : (
          <StudentArea portal={portal} notificationFocus={notificationFocus} />
        )
      )}
      {!platformAdministrationView && role === "student" && membership?.status === "removed" && (
        <FormerStudentArea membership={membership} act={act} busy={acting} />
      )}
      {!platformAdministrationView && role === "teacher" && membership?.status === "active" && (
        <TeacherArea
          portal={portal}
          previewRole={preview || previewRole ? "teacher" : null}
          act={act}
          busy={acting}
          notificationFocus={notificationFocus}
          view={visibleManagerView}
          assignmentStudentId={assignmentStudentId}
          onOpenView={openManagerView}
          onOpenAssignmentDirectory={openAssignmentDirectory}
        />
      )}
      {!platformAdministrationView && (role === "manager" || role === "owner") && (membership?.status === "active" || Boolean(adminWorkspace)) && (
        <ManagerArea
          portal={portal}
          act={act}
          busy={acting}
          actorRole={role}
          previewRole={preview || previewRole ? "manager" : null}
          view={visibleManagerView}
          onOpenView={openManagerView}
          assignmentStudentId={assignmentStudentId}
          onOpenAssignmentDirectory={openAssignmentDirectory}
          notificationFocus={notificationFocus}
        />
      )}
      {portal.actor.platformAdmin && (
        platformAdministrationView ? (
          <PlatformAdminArea
            portal={portal}
            act={act}
            busy={acting}
            onBack={() => openManagerView("overview", true)}
          />
        ) : visibleManagerView === "overview" ? (
          <PlatformAdminCard portal={portal} onOpen={() => openManagerView("administration")} />
        ) : null
      )}
    </PortalFrame>
  );
}

function AdminWorkspaceSummary({
  organization,
  portal,
  compact,
  view,
  onOpenView,
  onSelectOrganization,
  switchingOrganization,
}: {
  organization: NonNullable<Portal["organizations"]>[number];
  portal: Portal;
  compact: boolean;
  view: ManagerView;
  onOpenView: (view: ManagerView) => void;
  onSelectOrganization: (organizationId: string) => void;
  switchingOrganization: boolean;
}) {
  const settingsSelected = view === "settings";
  const canSwitchOrganization = (portal.organizations ?? []).filter(
    (candidate) => candidate.status === "active",
  ).length > 1;
  return (
    <section
      className={`organization-membership-summary card !rounded-[var(--radius-xl)] !p-2.5 sm:!px-4 sm:!py-3 ${compact && !canSwitchOrganization ? "max-sm:hidden" : ""}`}
      data-compact={compact ? "" : undefined}
      data-organization-switcher-persistent={compact && canSwitchOrganization ? "" : undefined}
      aria-label={`${organization.name} workspace navigation`}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 lg:grid-cols-[minmax(12rem,1fr)_minmax(28rem,auto)_auto] lg:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-words text-[16px] font-semibold leading-5 tracking-tight text-slate-900 sm:text-[18px] sm:leading-6">{organization.name}</h2>
            <StatusPill tone={organization.status === "active" ? "good" : "warn"}>{titleCase(organization.status)}</StatusPill>
          </div>
          <div className="organization-membership-details" aria-hidden={compact || undefined}>
            <div>
              <p className="mt-1 text-[11px] text-slate-500">BandUp administrator workspace</p>
            </div>
          </div>
        </div>

        <div className="col-span-2 min-w-0 sm:row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1">
          <OrganizationViewTabs portal={portal} view={view} onOpen={onOpenView} />
        </div>

        <div className="organization-membership-actions col-start-2 row-start-1 flex items-center justify-end gap-2 lg:col-start-3">
          <OrganizationSettingsButton selected={settingsSelected} onClick={() => onOpenView("settings")} />
          <AdminOrganizationSwitcher
            organizations={portal.organizations ?? []}
            activeOrganizationId={portal.activeOrganizationId}
            busy={switchingOrganization}
            onSelect={onSelectOrganization}
          />
        </div>
      </div>
    </section>
  );
}

function PortalFrame({ children, dashboard = false, preview = false, focused = false }: { children: React.ReactNode; dashboard?: boolean; preview?: boolean; focused?: boolean }) {
  return (
    <div className={`organization-dashboard mx-auto w-full max-w-7xl space-y-1.5 px-2.5 py-1.5 sm:space-y-2 sm:px-5 sm:py-3 ${dashboard ? "lg:h-full lg:min-h-0 lg:overflow-hidden" : ""}`}>
      <header className={`min-h-9 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 px-0.5 sm:gap-x-5 ${focused ? "hidden" : "flex"}`}>
        <div className="flex items-center gap-2 sm:gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-xl border border-slate-200/75 bg-surface/45 text-indigo-700 shadow-sm sm:h-9 sm:w-9">
            <CardIcon name="organization" size={19} className="text-current sm:hidden" />
            <CardIcon name="organization" size={21} className="hidden text-current sm:block" />
          </span>
          <div>
            <p className="hidden text-[9px] font-semibold uppercase tracking-[0.16em] text-indigo-700 sm:block">BandUp workspace</p>
            <h1 className="text-[18px] font-semibold tracking-[-0.025em] text-slate-900 sm:text-[24px]">Organisation</h1>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {preview && <span role="status" className="rounded-full border border-indigo-200/80 bg-indigo-50/65 px-2.5 py-1 text-[10px] font-medium text-indigo-800">Preview data</span>}
          <p className="hidden max-w-xl text-[11px] leading-4 text-slate-600 sm:block sm:text-[12px]">
            Students, teachers and managers share progress in one controlled workspace.
          </p>
        </div>
      </header>
      {children}
    </div>
  );
}

function Loading() {
  return <section className="card text-sm text-slate-500"><LoadingIndicator label="Loading your organisation…" /></section>;
}

function SignedOut() {
  return (
    <GlassSection title="Sign in to continue" lead="Organisation membership and student records are attached to your BandUp account.">
      <Link href="/account" className="btn-primary">Sign in</Link>
    </GlassSection>
  );
}

function activeMembership(portal: Portal): OrganizationMembership | null {
  return portal.memberships.find((item) => item.organization.id === portal.activeOrganizationId)
    ?? portal.memberships.find((item) => item.status === "active")
    ?? portal.memberships[0]
    ?? null;
}

function OrganizationSwitcher({
  memberships,
  activeOrganizationId,
  busy,
  onSelect,
}: {
  memberships: OrganizationMembership[];
  activeOrganizationId: string | null;
  busy: boolean;
  onSelect: (organizationId: string) => void;
}) {
  const workspaces = memberships.filter((membership) =>
    (membership.status === "active" || membership.status === "leave_requested")
      && membership.organization.status === "active",
  );
  if (workspaces.length < 2) return null;
  const current = workspaces.some((membership) => membership.organization.id === activeOrganizationId)
    ? activeOrganizationId!
    : workspaces[0].organization.id;
  return (
    <div className="organization-workspace-switcher min-w-0" data-organization-switcher>
      <GlassSelect
        label="Switch organisation"
        value={current}
        options={workspaces.map((membership) => ({
          value: membership.organization.id,
          label: `${membership.organization.name} · ${titleCase(membership.role)}`,
        }))}
        onValueChange={onSelect}
        disabled={busy}
        compact
        className="w-full"
        minMenuWidth={256}
        fullPageThreshold={8}
      />
    </div>
  );
}

function AdminOrganizationSwitcher({
  organizations,
  activeOrganizationId,
  busy,
  onSelect,
}: {
  organizations: NonNullable<Portal["organizations"]>;
  activeOrganizationId: string | null;
  busy: boolean;
  onSelect: (organizationId: string) => void;
}) {
  const workspaces = organizations.filter((organization) => organization.status === "active");
  if (workspaces.length < 2) return null;
  const current = workspaces.some((organization) => organization.id === activeOrganizationId)
    ? activeOrganizationId!
    : workspaces[0].id;
  return (
    <div className="organization-workspace-switcher min-w-0" data-organization-switcher>
      <GlassSelect
        label="Switch organisation"
        value={current}
        options={workspaces.map((organization) => ({
          value: organization.id,
          label: organization.name,
        }))}
        onValueChange={onSelect}
        disabled={busy}
        compact
        className="w-full"
        minMenuWidth={256}
        fullPageThreshold={8}
      />
    </div>
  );
}

function OrganizationSettingsButton({
  selected,
  onClick,
}: {
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="organization-settings-button liquid-glass premade-glass relative grid size-11 shrink-0 place-items-center overflow-hidden rounded-full border border-slate-200/75 bg-surface/45 shadow-sm transition-colors hover:bg-surface/70"
      aria-label="Open organisation settings"
      aria-current={selected ? "page" : undefined}
      title="Organisation settings"
      onClick={onClick}
    >
      <RefractiveGlassLayer radius={22} interactive />
      <CardIcon name="gear" size={18} className="relative z-10" />
    </button>
  );
}

function OrganizationViewTabs({
  portal,
  view,
  onOpen,
}: {
  portal: Portal;
  view: ManagerView;
  onOpen: (view: ManagerView) => void;
}) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const dragging = useRef(false);
  const dragIndex = useRef<number | null>(null);
  const pending = (portal.requests ?? []).filter(
    (request) => request.status === "pending" && request.kind !== "invitation",
  ).length;
  const outstandingPractice = (portal.practiceAssignments ?? []).filter(
    (assignment) => !assignment.completedAt,
  ).length;
  const options: ReadonlyArray<readonly [Exclude<ManagerView, "settings">, string, number | null]> = [
    ["overview", "Overview", null],
    ["requests", "Requests", pending],
    ["assignments", "Assignments", outstandingPractice],
    ["students", "Students", portal.students?.length ?? 0],
    ["members", "Team", portal.members?.length ?? 0],
  ];
  const selectedView = view === "assignment-directory"
    ? "assignments"
    : view === "team-invite" || view === "team-assignment" || view === "team-pairings"
      ? "members"
      : view;
  const selectedIndex = options.findIndex(([id]) => id === selectedView);
  const visibleIndex = previewIndex ?? Math.max(0, selectedIndex);

  const indexAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - rect.left) / rect.width) * options.length);
    return Math.max(0, Math.min(options.length - 1, index));
  };

  const previewAtPointer = (event: PointerEvent<HTMLDivElement>) => {
    const index = indexAtPointer(event);
    dragIndex.current = index;
    setPreviewIndex(index);
  };

  return (
    <div
      role="tablist"
      aria-label="Organisation sections"
      data-flowing={previewIndex !== null ? "" : undefined}
      data-unselected={selectedIndex < 0 && previewIndex === null ? "" : undefined}
      className="organization-view-tabs premade-glass relative hidden min-w-0 touch-none grid-cols-5 items-center overflow-hidden rounded-[var(--radius-xl)] p-1 sm:grid"
      style={{
        "--organization-view-index": visibleIndex,
        "--organization-view-count": options.length,
      } as CSSProperties}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        previewAtPointer(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) previewAtPointer(event);
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        previewAtPointer(event);
        dragging.current = false;
        const index = dragIndex.current;
        if (index !== null) onOpen(options[index][0]);
        dragIndex.current = null;
        setPreviewIndex(null);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        dragIndex.current = null;
        setPreviewIndex(null);
      }}
      onPointerLeave={() => {
        if (!dragging.current) setPreviewIndex(null);
      }}
    >
      <RefractiveGlassLayer radius={18} interactive optics="enhanced" />
      <span className="organization-view-selector" aria-hidden="true" />
      {options.map(([id, label, count], index) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={selectedView === id}
          onPointerEnter={() => {
            dragIndex.current = index;
            setPreviewIndex(index);
          }}
          onFocus={() => setPreviewIndex(index)}
          onBlur={() => setPreviewIndex(null)}
          onClick={() => {
            onOpen(id);
            setPreviewIndex(null);
          }}
          className={`relative z-10 min-h-9 min-w-0 rounded-[calc(var(--radius-xl)-0.3rem)] px-1.5 text-[11px] font-semibold transition-colors lg:px-2 lg:text-[12px] ${visibleIndex === index ? "text-slate-900" : "text-slate-600 hover:text-slate-900"}`}
        >
          <span className="truncate">{label}</span>
          {count !== null && count > 0 && (
            <span className="ml-1 hidden text-[10px] font-medium text-slate-500 xl:inline">{count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function MembershipSummary({
  membership,
  portal,
  compact = false,
  onOpenSettings,
  onSelectOrganization,
  switchingOrganization = false,
  managerView,
  onOpenManagerView,
}: {
  membership: OrganizationMembership;
  portal: Portal;
  compact?: boolean;
  onOpenSettings?: () => void;
  onSelectOrganization?: (organizationId: string) => void;
  switchingOrganization?: boolean;
  managerView?: ManagerView | null;
  onOpenManagerView?: (view: ManagerView) => void;
}) {
  const statusTone = membership.status === "active" ? "good" : membership.status === "suspended" || membership.status === "removed" ? "bad" : "warn";
  const managerWorkspace = membership.role === "manager" || membership.role === "owner";
  const pending = (portal.requests ?? []).filter((request) => request.status === "pending" && request.kind !== "invitation").length;
  const assigned = new Set((portal.assignments ?? []).map((assignment) => assignment.studentUserId)).size;
  const canSwitchOrganization = portal.memberships.filter((item) => (
    (item.status === "active" || item.status === "leave_requested")
      && item.organization.status === "active"
  )).length > 1;
  return (
    <section
      className={`organization-membership-summary card !rounded-[var(--radius-xl)] !p-2.5 sm:!px-4 sm:!py-3 ${compact && !canSwitchOrganization ? "max-sm:hidden" : ""}`}
      data-compact={compact ? "" : undefined}
      data-organization-switcher-persistent={compact && canSwitchOrganization ? "" : undefined}
    >
      <div className={`${managerWorkspace ? "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(12rem,1fr)_minmax(28rem,auto)_auto] lg:items-center" : "flex flex-wrap items-center justify-between gap-3"}`}>
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-[16px] font-semibold leading-5 tracking-tight text-slate-900 sm:text-[18px] sm:leading-6">
            {membership.organization.name}
          </h2>
          <div className="organization-membership-details" aria-hidden={compact || undefined}>
            <div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <StatusPill tone={statusTone}>{titleCase(membership.status)}</StatusPill>
                <p className="text-[11px] text-slate-500">
                  {titleCase(membership.role)} · {membership.joinedAt ? `Joined ${formatDate(membership.joinedAt)}` : "Awaiting confirmation"}
                </p>
              </div>
            </div>
          </div>
        </div>

        {managerWorkspace && managerView && onOpenManagerView && (
          <div className="col-span-2 min-w-0 sm:row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1">
            <OrganizationViewTabs portal={portal} view={managerView} onOpen={onOpenManagerView} />
          </div>
        )}

        <div className="organization-membership-actions col-start-2 row-start-1 flex items-center justify-end gap-2 lg:col-start-3">
          {(managerWorkspace || (membership.role === "student" && membership.status === "active")) && onOpenSettings && (
            <OrganizationSettingsButton selected={managerView === "settings"} onClick={onOpenSettings} />
          )}
          {canSwitchOrganization && onSelectOrganization && (
            <OrganizationSwitcher
              memberships={portal.memberships}
              activeOrganizationId={portal.activeOrganizationId}
              busy={switchingOrganization}
              onSelect={onSelectOrganization}
            />
          )}
        </div>

        {!(managerWorkspace && managerView && onOpenManagerView) && (
        <div className={`${compact ? "hidden" : managerWorkspace ? "hidden sm:flex" : "grid"} w-full min-w-0 grid-cols-4 gap-1 sm:w-auto sm:items-center`} aria-label="Organisation summary">
          {membership.organization.studentCount !== null && (
            <span className="min-w-0 border-l border-slate-300/60 px-0.5 text-center sm:min-w-16 sm:px-2.5"><strong className="block text-sm tabular-nums text-slate-900">{membership.organization.studentCount}</strong><span className="block text-[8px] uppercase tracking-wide text-slate-500 sm:text-[9px]">Students</span></span>
          )}
          {membership.organization.memberCount !== null && (
            <span className="min-w-0 border-l border-slate-300/60 px-0.5 text-center sm:min-w-16 sm:px-2.5"><strong className="block text-sm tabular-nums text-slate-900">{membership.organization.memberCount}</strong><span className="block text-[8px] uppercase tracking-wide text-slate-500 sm:text-[9px]">Members</span></span>
          )}
          {(membership.role === "manager" || membership.role === "owner") && (
            <>
              <span className="min-w-0 border-l border-slate-300/60 px-0.5 text-center sm:min-w-16 sm:px-2.5"><strong className="block text-sm tabular-nums text-slate-900">{pending}</strong><span className="block text-[8px] uppercase tracking-wide text-slate-500 sm:text-[9px]">Pending</span></span>
              <span className="min-w-0 border-l border-slate-300/60 px-0.5 text-center sm:min-w-16 sm:px-2.5"><strong className="block text-sm tabular-nums text-slate-900">{assigned}</strong><span className="block text-[8px] uppercase tracking-wide text-slate-500 sm:text-[9px]">Assigned</span></span>
            </>
          )}
        </div>
        )}

      </div>
    </section>
  );
}

type Act = (action: OrganizationAction, payload: Record<string, unknown>) => Promise<OrganizationActionResponse | null>;

function NoMembership({ portal, act, busy, previewRole }: { portal: Portal; act: Act; busy: boolean; previewRole: OrganizationLivePreviewRole | null }) {
  return (
    // Stretch (the grid default) rather than items-start: the create card
    // holds less than the join card, and starting both at the same height
    // instead of shrink-wrapping each to its own content is what stops the
    // create card looking stunted beside its sibling.
    <div className="grid gap-4 lg:grid-cols-2">
      {portal.eligibility.canJoin ? (
        <JoinOrganizationForm act={act} busy={busy} previewRole={previewRole} />
      ) : (
        <GlassSection title="Joining isn’t available"><EmptyState>{portal.eligibility.reason ?? "Your current account is not eligible to join an organisation."}</EmptyState></GlassSection>
      )}
      <OrganizationCreateForm act={act} busy={busy} />
    </div>
  );
}

// Any signed-in user may create an organisation, at any time — creating one
// does not require leaving another. OrganizationCreateForm used to render
// only inside NoMembership, the screen for people with no organisation at
// all. That meant belonging to one organisation was the one thing that
// stopped you creating a second, and OrganizationSwitcher only appears once a
// second membership exists — so the escape from either gate was hidden
// behind the other. Settings is reachable by everyone who already has a
// workspace (managers, owners and active students), which makes it the right
// home for the same form NoMembership already uses.
function CreateAnotherOrganizationSection({ act, busy }: { act: Act; busy: boolean }) {
  return (
    <GlassSection
      title="Create another organisation"
      lead="This will not affect the organisation you are already in. Once you belong to more than one, a switcher for moving between them appears in the header."
    >
      <OrganizationCreateForm act={act} busy={busy} />
    </GlassSection>
  );
}

function StudentArea({
  portal,
  notificationFocus,
}: {
  portal: Portal;
  notificationFocus: NotificationFocus;
}) {
  const practice = portal.practiceAssignments ?? [];
  const feedback = portal.recentFeedback ?? [];
  const focusedAttemptId = notificationFocus.kind === "teacher-feedback" ? notificationFocus.id : null;
  const focusedFeedbackExists = Boolean(focusedAttemptId && feedback.some((item) => item.attemptId === focusedAttemptId));
  const focusedFeedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusedFeedbackExists) return;
    const frame = requestAnimationFrame(() => {
      focusedFeedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      focusedFeedbackRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedAttemptId, focusedFeedbackExists]);
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(16rem,.85fr)]">
      <GlassSection title="Your practice" lead="Start the work your teacher has set for you.">
        {practice.length === 0 ? (
          <EmptyState>No practice has been assigned yet. Your teacher will add it here.</EmptyState>
        ) : (
          <div className="space-y-2">
            {practice.map((assignment) => (
              <div key={assignment.id} className="text-inset-compact flex min-w-0 flex-wrap items-center justify-between gap-2.5 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-slate-900">{assignment.title}</p>
                    <StatusPill tone={assignment.completedAt ? "good" : "plain"}>{assignment.completedAt ? "Done" : "To do"}</StatusPill>
                  </div>
                  {assignment.note && <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-slate-600">{assignment.note}</p>}
                  {assignment.dueAt && <p className="mt-1 text-[11px] text-slate-500">Due {formatDate(assignment.dueAt)}</p>}
                </div>
                <Link href={assignment.href} className="btn-primary shrink-0 !rounded-[var(--radius-lg)] !px-3 !py-2 text-xs">
                  {assignment.completedAt ? "Practise again" : "Start"}
                </Link>
              </div>
            ))}
          </div>
        )}
      </GlassSection>
      <GlassSection title="Teacher notes" lead="Extra feedback from your teacher.">
        {notificationFocus.kind === "teacher-feedback" && !focusedFeedbackExists && (
          <p role="status" className="mb-2 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/35 px-3 py-2 text-xs text-slate-600">
            That teacher note is no longer available here. It may belong to cleared or unshared history.
          </p>
        )}
        {feedback.length === 0 ? <EmptyState>New teacher notes will appear here.</EmptyState> : (
          <div className="space-y-2">
            {feedback.map((item) => (
              <div
                key={item.id}
                ref={item.attemptId === focusedAttemptId ? focusedFeedbackRef : undefined}
                tabIndex={item.attemptId === focusedAttemptId ? -1 : undefined}
                data-notification-target={item.attemptId === focusedAttemptId ? "teacher-feedback" : undefined}
                className={`text-inset-compact scroll-mt-24 rounded-[var(--radius-lg)] border py-2.5 outline-none transition-colors ${item.attemptId === focusedAttemptId ? "border-indigo-300 bg-indigo-50/55 ring-2 ring-indigo-300/45" : "border-slate-200/70 bg-surface/30"}`}
              >
                {item.attemptId === focusedAttemptId && <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-indigo-800">New teacher feedback</p>}
                <p className="text-xs leading-5 text-slate-700">{item.message}</p>
                <p className="mt-1 text-[11px] text-slate-500">{item.teacherName ?? "Teacher"} · {formatDate(item.updatedAt)}</p>
              </div>
            ))}
          </div>
        )}
      </GlassSection>
    </div>
  );
}

function StudentOrganizationSettings({
  membership,
  act,
  busy,
  onBack,
}: {
  membership: OrganizationMembership;
  act: Act;
  busy: boolean;
  onBack: () => void;
}) {
  const priorPending = membership.preJoinHistoryRequestStatus === "pending";
  const futurePending = membership.futureHistoryRequestStatus === "pending";
  return (
    <>
    <GlassSection
      title="Organisation settings"
      lead={`Privacy and membership controls for ${membership.organization.name}.`}
      action={<MobileDashboardBack onBack={onBack} />}
      headerClassName="max-sm:!flex-nowrap max-sm:!justify-start"
    >
      <div className="space-y-3">
        <section aria-labelledby="student-organisation-privacy">
          <div className="flex items-center gap-2">
            <CardIcon name="gear" size={18} className="text-indigo-700" />
            <h3 id="student-organisation-privacy" className="text-sm font-semibold text-slate-900">Privacy settings</h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            These choices apply only to {membership.organization.name}. While you are a member, a manager or assigned teacher must approve changes; current access stays the same until then.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <SharingRequestRow
              label="Work after joining"
              shared={membership.shareFutureHistory}
              detail="Practice and feedback completed after you joined."
              pending={futurePending}
              disabled={busy || futurePending}
              onClick={() => void act("request_access_change", {
                organizationId: membership.organization.id,
                scope: "future",
                share: !membership.shareFutureHistory,
              })}
            />
            <SharingRequestRow
              label="Work before joining"
              shared={membership.sharePreJoinHistory}
              detail="Practice and feedback completed before you joined."
              pending={priorPending}
              disabled={busy || priorPending}
              onClick={() => void act("set_prior_history_sharing", {
                organizationId: membership.organization.id,
                share: !membership.sharePreJoinHistory,
              })}
            />
          </div>
          <Link href="/privacy" className="mt-2 inline-flex text-xs font-semibold text-indigo-700 underline decoration-indigo-300 underline-offset-4">
            Read BandUp privacy controls
          </Link>
        </section>

        <section className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/25 px-3 py-2.5" aria-labelledby="student-organisation-membership">
          <div className="min-w-0">
            <h3 id="student-organisation-membership" className="text-sm font-semibold text-slate-900">Membership</h3>
            <p className="text-xs leading-5 text-slate-500">Ask a manager to remove you from this organisation.</p>
          </div>
          <button
            type="button"
            className="btn-secondary min-h-9 !rounded-[var(--radius-lg)] !px-3 !py-2 text-xs"
            disabled={busy || membership.leaveRequestStatus === "pending"}
            onClick={() => void act("request_to_leave", { organizationId: membership.organization.id })}
          >
            {membership.leaveRequestStatus === "pending" ? "Leave request sent" : "Request to leave"}
          </button>
        </section>
      </div>
    </GlassSection>
    <CreateAnotherOrganizationSection act={act} busy={busy} />
    </>
  );
}

function SharingRequestRow({
  label,
  shared,
  detail,
  pending,
  disabled,
  onClick,
}: {
  label: string;
  shared: boolean;
  detail: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const action = pending ? "Awaiting approval" : shared ? "Request to stop" : "Request to share";
  return (
    <div className="grid min-w-0 gap-2 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[14px] font-medium text-slate-800">{label}</p>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${shared ? "bg-emerald-100/80 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
            {shared ? "Currently shared" : "Currently private"}
          </span>
          {pending && <StatusPill tone="warn">Pending</StatusPill>}
        </div>
        <p className="mt-0.5 text-[12px] leading-4 text-slate-500">{detail}</p>
        {pending && (
          <p role="status" className="mt-1 text-[11px] leading-4 text-amber-800">
            {shared ? "You asked to stop sharing." : "You asked to start sharing."} Current access stays unchanged until approval.
          </p>
        )}
      </div>
      <button
        type="button"
        className="btn-secondary w-full shrink-0 whitespace-nowrap !rounded-[var(--radius-lg)] !px-3 !py-2 text-xs sm:w-auto"
        disabled={disabled}
        onClick={onClick}
      >
        {action}
      </button>
    </div>
  );
}

function FormerStudentArea({ membership, act, busy }: { membership: OrganizationMembership; act: Act; busy: boolean }) {
  return (
    <GlassSection
      title="Former membership"
      lead="You have left this organisation. You now control whether work from before joining remains shared."
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/70 bg-surface/25 px-4 py-3">
        <span>
          <span className="block text-sm font-medium text-slate-800">History from before joining</span>
          <span className="block text-xs leading-5 text-slate-500">This change no longer needs organisation approval.</span>
        </span>
        <button
          type="button"
          className="btn-secondary !px-3 !py-2 text-xs"
          disabled={busy}
          onClick={() => void act("set_prior_history_sharing", {
            organizationId: membership.organization.id,
            share: !membership.sharePreJoinHistory,
          })}
        >
          {membership.sharePreJoinHistory ? "Stop sharing" : "Share history"}
        </button>
      </div>
    </GlassSection>
  );
}

function TeacherArea({
  portal,
  previewRole,
  act,
  busy,
  notificationFocus,
  view,
  assignmentStudentId,
  onOpenView,
  onOpenAssignmentDirectory,
}: {
  portal: Portal;
  previewRole: "teacher" | null;
  act: Act;
  busy: boolean;
  notificationFocus: NotificationFocus;
  view: ManagerView;
  assignmentStudentId: string | null;
  onOpenView: (view: ManagerView, replace?: boolean) => void;
  onOpenAssignmentDirectory: (studentId?: string | null, replace?: boolean) => void;
}) {
  const students = portal.students ?? [];
  const requests = (portal.requests ?? []).filter((request) => request.status === "pending");
  const focusedRequestId = notificationFocus.kind === "request" ? notificationFocus.id : null;
  const focusedRequestExists = Boolean(focusedRequestId && requests.some((request) => request.id === focusedRequestId));
  const focusedRequestRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusedRequestExists) return;
    const frame = requestAnimationFrame(() => {
      focusedRequestRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      focusedRequestRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedRequestExists, focusedRequestId]);
  if (view === "assignment-directory") {
    return (
      <AssignmentDirectory
        assignments={portal.practiceAssignments ?? []}
        students={students}
        organizationId={portal.activeOrganizationId}
        previewRole={previewRole}
        selectedStudentId={assignmentStudentId}
        onSelectStudent={onOpenAssignmentDirectory}
        onBack={() => onOpenView("overview", true)}
      />
    );
  }
  return (
    <div className="space-y-3">
      <GlassSection title="Assign practice" lead="Choose one practice and set it for one or more of your assigned students.">
        <PracticeAssignmentForm
          organizationId={portal.activeOrganizationId}
          students={students}
          act={act}
          busy={busy}
        />
        <AssignmentDirectoryCard
          assignments={portal.practiceAssignments ?? []}
          onOpen={() => onOpenAssignmentDirectory()}
          className="sm:hidden"
        />
        <AssignmentDesktopWorkspace
          assignments={portal.practiceAssignments ?? []}
          students={students}
          organizationId={portal.activeOrganizationId}
          previewRole={previewRole}
        />
      </GlassSection>
      {portal.activeOrganizationId && (
        <GlassSection title="Invite a student" lead="Search their exact BandUp username. Only the account holder can accept the invitation.">
          <UsernameInvitationForm
            organizationId={portal.activeOrganizationId}
            role="student"
            act={act}
            busy={busy}
            previewRole={previewRole}
          />
        </GlassSection>
      )}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <GlassSection title="Assigned students" lead="Open a student to review work and add feedback.">
        {students.length === 0 ? <EmptyState>No students have been assigned to you yet.</EmptyState> : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {students.map((student) => <StudentCard key={student.userId} student={student} previewRole={previewRole} />)}
          </div>
        )}
      </GlassSection>
      <GlassSection title="Sharing requests" lead="Only requests from students assigned to you appear.">
        {notificationFocus.kind === "request" && !focusedRequestExists && (
          <p role="status" className="mb-2 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/35 px-3 py-2 text-xs text-slate-600">
            That request is no longer pending. It may already have been decided.
          </p>
        )}
        {requests.length === 0 ? <EmptyState>No requests are waiting.</EmptyState> : (
          <div className="space-y-2">{requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              act={act}
              busy={busy}
              highlighted={request.id === focusedRequestId}
              targetRef={request.id === focusedRequestId ? focusedRequestRef : undefined}
            />
          ))}</div>
        )}
      </GlassSection>
      </div>
    </div>
  );
}

function PracticeAssignmentForm({
  organizationId,
  students,
  act,
  busy,
}: {
  organizationId: string | null;
  students: NonNullable<Portal["students"]>;
  act: Act;
  busy: boolean;
}) {
  const [studentUserIds, setStudentUserIds] = useState<string[]>([]);
  const [studentPickerOpen, setStudentPickerOpen] = useState(false);
  const [studentButton, setStudentButton] = useState<HTMLButtonElement | null>(null);
  const [targetKey, setTargetKey] = useState("");
  const [note, setNote] = useState("");
  const target = ORGANIZATION_PRACTICE_TARGETS.find((item) => `${item.skill}:${item.testId}` === targetKey) ?? null;
  const availableStudents = students.filter((student) => !student.archivedAt);
  const selectedStudents = availableStudents.filter((student) => studentUserIds.includes(student.userId));
  if (!organizationId || availableStudents.length === 0) return <EmptyState>Assign an active student before setting practice.</EmptyState>;
  return (
    <form
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 overflow-hidden sm:gap-2.5 lg:grid-cols-[minmax(12rem,.8fr)_minmax(16rem,1.2fr)_minmax(12rem,1fr)_auto] lg:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (studentUserIds.length === 0 || !target) return;
        void act("assign_practice_batch", practiceBatchAssignmentPayload(
          organizationId,
          studentUserIds,
          target.skill,
          target.testId,
          note,
        )).then((result) => {
          if (result) {
            setStudentUserIds([]);
            setStudentPickerOpen(false);
            setTargetKey("");
            setNote("");
          }
        });
      }}
    >
      <div className="relative min-w-0">
        <span className="mb-1.5 block text-xs font-semibold text-slate-600">Students</span>
        <button
          ref={setStudentButton}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={studentPickerOpen}
          aria-label={selectedStudents.length === 0 ? "Select students" : `${selectedStudents.length} students selected`}
          title={selectedStudents.length > 0 ? selectedStudents.map((student) => student.displayName ?? student.email ?? "Student").join(", ") : undefined}
          className="liquid-glass flex h-11 min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-300 bg-surface/45 px-2.5 text-left text-sm text-slate-900 sm:px-3"
          onClick={() => setStudentPickerOpen((open) => !open)}
        >
          <span className="truncate">
            {selectedStudents.length === 0
              ? "Select students"
              : `${selectedStudents.length} selected`}
          </span>
          <Chevron open={studentPickerOpen} />
        </button>
        {studentPickerOpen && (
          <FloatingGlassPopover
            anchor={studentButton}
            ariaLabel="Students receiving this practice"
            multiselectable
            onClose={() => setStudentPickerOpen(false)}
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200/70 px-2 py-1.5">
              <button type="button" className="text-[11px] font-semibold text-indigo-700" onClick={() => setStudentUserIds(availableStudents.map((student) => student.userId))}>Select all</button>
              <button type="button" className="text-[11px] font-semibold text-slate-500" onClick={() => setStudentUserIds([])}>Clear</button>
            </div>
            {availableStudents.map((student) => {
              const selected = studentUserIds.includes(student.userId);
              return (
                <button
                  key={student.userId}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`mt-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm ${selected ? "bg-indigo-100/65 text-slate-900" : "text-slate-700 hover:bg-surface/55"}`}
                  onClick={() => setStudentUserIds((current) => selected ? current.filter((id) => id !== student.userId) : [...current, student.userId])}
                >
                  <span className={`grid size-5 place-items-center rounded-md border text-[12px] ${selected ? "border-indigo-400 bg-indigo-600 text-white" : "border-slate-300"}`}>{selected ? "✓" : ""}</span>
                  <span className="truncate">{student.displayName ?? student.email ?? "Student"}</span>
                </button>
              );
            })}
          </FloatingGlassPopover>
        )}
      </div>
      <GlassSelect
        label="Practice"
        value={targetKey}
        placeholder="Select practice"
        options={ORGANIZATION_PRACTICE_TARGETS.map((item) => ({ value: `${item.skill}:${item.testId}`, label: item.title }))}
        onValueChange={setTargetKey}
        className="self-end"
      />
      <label className="min-w-0">
        <span className="mb-1.5 block text-xs font-semibold text-slate-600">Short note <span className="font-normal">(optional)</span></span>
        <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={1200} className="input h-11 min-h-11 w-full rounded-xl border border-slate-300 bg-surface/60 px-2.5 py-0 text-sm text-slate-900 sm:px-3" placeholder="What to focus on" />
      </label>
      <button type="submit" className="btn-primary mt-[1.375rem] h-11 min-h-11 w-full whitespace-nowrap !px-2.5 text-xs sm:!px-4 sm:text-sm lg:w-auto" disabled={busy || studentUserIds.length === 0 || !target}>
        <span className="sm:hidden">{studentUserIds.length > 1 ? `Assign (${studentUserIds.length})` : "Assign"}</span>
        <span className="hidden sm:inline">{studentUserIds.length > 1 ? `Assign to ${studentUserIds.length}` : "Assign practice"}</span>
      </button>
    </form>
  );
}

function PracticeAssignmentSummary({
  assignments,
  students,
  onOpenStudent,
}: {
  assignments: NonNullable<Portal["practiceAssignments"]>;
  students: NonNullable<Portal["students"]>;
  onOpenStudent: (studentId: string) => void;
}) {
  const studentById = new Map(students.map((student) => [student.userId, student]));
  const grouped = new Map<string, {
    studentId: string;
    name: string;
    done: number;
    total: number;
  }>();
  for (const assignment of assignments) {
    const existing = grouped.get(assignment.studentUserId);
    if (existing) {
      existing.total += 1;
      if (assignment.completedAt) existing.done += 1;
      continue;
    }
    const student = studentById.get(assignment.studentUserId);
    grouped.set(assignment.studentUserId, {
      studentId: assignment.studentUserId,
      name: student?.displayName ?? student?.email ?? assignment.studentName ?? "Student",
      done: assignment.completedAt ? 1 : 0,
      total: 1,
    });
  }
  const progress = [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name, "en-GB"));
  return (
    <div className="mt-2 max-h-[12.75rem] space-y-1.5 overflow-y-auto overscroll-contain pr-0.5" aria-label="Student practice progress">
      {progress.map((item) => {
        const percentage = Math.round((item.done / item.total) * 100);
        return (
          <button
            key={item.studentId}
            type="button"
            className="liquid-glass group grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/25 px-3 py-2 text-left"
            onClick={() => onOpenStudent(item.studentId)}
          >
            <span className="truncate text-xs font-semibold text-slate-900">{item.name}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-slate-500">
              <strong className="text-xs text-slate-900">{item.done}/{item.total}</strong>
              <span>done</span>
              <span aria-hidden="true" className="text-sm transition-transform group-hover:translate-x-0.5">›</span>
            </span>
            <span className="col-span-2 flex min-w-0 items-center gap-2">
              <span
                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-200/75"
                role="progressbar"
                aria-label={`${item.name} assignment completion`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percentage}
              >
                <span className="block h-full rounded-full bg-indigo-600" style={{ width: `${percentage}%` }} />
              </span>
              <span className="w-8 shrink-0 text-right text-[10px] font-semibold tabular-nums text-slate-600">{percentage}%</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AssignmentDirectoryCard({
  assignments,
  onOpen,
  className = "",
}: {
  assignments: NonNullable<Portal["practiceAssignments"]>;
  onOpen: () => void;
  className?: string;
}) {
  const done = assignments.filter((assignment) => assignment.completedAt).length;
  const todo = assignments.length - done;
  const students = new Set(assignments.map((assignment) => assignment.studentUserId)).size;
  return (
    <button
      type="button"
      className={`liquid-glass group mt-2.5 flex min-h-16 w-full min-w-0 items-center gap-3 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5 text-left sm:min-h-[4.5rem] ${className}`}
      onClick={onOpen}
    >
      <CardIcon name="plan" size={28} className="shrink-0 text-indigo-700" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-900">Student assignments</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
          {assignments.length === 0
            ? "No tasks have been set yet"
            : `${todo} to do · ${done} done · ${students} student${students === 1 ? "" : "s"}`}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <strong className="text-base tabular-nums text-slate-900">{assignments.length}</strong>
        <span aria-hidden="true" className="text-lg text-slate-400 transition-transform group-hover:translate-x-0.5">›</span>
      </span>
    </button>
  );
}

function AssignmentDesktopWorkspace({
  assignments,
  students,
  organizationId,
  previewRole,
}: {
  assignments: NonNullable<Portal["practiceAssignments"]>;
  students: NonNullable<Portal["students"]>;
  organizationId: string | null;
  previewRole: "manager" | "teacher" | null;
}) {
  const sortedStudents = [...students].sort((left, right) => {
    const leftName = left.displayName ?? left.email ?? "Student";
    const rightName = right.displayName ?? right.email ?? "Student";
    return leftName.localeCompare(rightName, "en-GB");
  });
  const assignmentsByStudent = new Map<string, NonNullable<Portal["practiceAssignments"]>>();
  for (const assignment of assignments) {
    const current = assignmentsByStudent.get(assignment.studentUserId);
    if (current) current.push(assignment);
    else assignmentsByStudent.set(assignment.studentUserId, [assignment]);
  }
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(() => sortedStudents[0]?.userId ?? null);
  const selectedStudent = sortedStudents.find((student) => student.userId === selectedStudentId)
    ?? sortedStudents[0]
    ?? null;
  const selectedAssignments = selectedStudent
    ? assignmentsByStudent.get(selectedStudent.userId) ?? []
    : [];
  const selectedTodo = selectedAssignments.filter((assignment) => !assignment.completedAt);
  const selectedDone = selectedAssignments.filter((assignment) => assignment.completedAt);

  if (sortedStudents.length === 0) return null;

  const taskCard = (assignment: NonNullable<Portal["practiceAssignments"]>[number]) => {
    const resultHref = assignment.completedAttemptId && organizationId
      ? sittingReviewHref(assignment.studentUserId, assignment.completedAttemptId, {
          organizationId,
          from: "assignment-directory",
          previewRole,
        })
      : null;
    const body = (
      <>
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-5 text-slate-900">{assignment.title}</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
              {assignment.dueAt ? `Due ${formatDate(assignment.dueAt)}` : `Set ${formatDate(assignment.assignedAt)}`}
              {assignment.assignedByName ? ` · ${assignment.assignedByName}` : ""}
            </span>
          </span>
          <StatusPill tone={assignment.completedAt ? "good" : "plain"}>{assignment.completedAt ? "Done" : "To do"}</StatusPill>
        </span>
        {assignment.note && <span className="mt-1.5 line-clamp-2 block text-[11px] leading-4 text-slate-600">{assignment.note}</span>}
        <span className="mt-2 flex items-center justify-between text-[11px] font-semibold text-indigo-700">
          <span>{resultHref ? "Review sitting" : "Waiting for completion"}</span>
          {resultHref && <span aria-hidden="true">›</span>}
        </span>
      </>
    );
    return resultHref ? (
      <Link key={assignment.id} href={resultHref} className="liquid-glass block min-w-0 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5">
        {body}
      </Link>
    ) : (
      <article key={assignment.id} className="min-w-0 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5">
        {body}
      </article>
    );
  };

  return (
    <div className="mt-3 hidden min-w-0 grid-cols-[minmax(13rem,.72fr)_minmax(0,1.55fr)] gap-2.5 sm:grid">
      <div className="min-w-0 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/20 p-2">
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          <h3 className="text-sm font-semibold text-slate-900">Students</h3>
          <span className="text-[11px] tabular-nums text-slate-500">{sortedStudents.length}</span>
        </div>
        <div role="listbox" aria-label="Student assignment records" className="max-h-[23rem] space-y-1 overflow-y-auto overscroll-contain pr-0.5">
          {sortedStudents.map((student) => {
            const studentAssignments = assignmentsByStudent.get(student.userId) ?? [];
            const todo = studentAssignments.filter((assignment) => !assignment.completedAt).length;
            const done = studentAssignments.length - todo;
            const selected = student.userId === selectedStudent?.userId;
            return (
              <button
                key={student.userId}
                type="button"
                role="option"
                aria-selected={selected}
                className={`flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-lg)] border px-2 py-2 text-left transition-colors ${selected ? "border-indigo-300/80 bg-indigo-100/55" : "border-transparent hover:border-slate-200/70 hover:bg-surface/45"}`}
                onClick={() => setSelectedStudentId(student.userId)}
              >
                <span className="min-w-0 flex-1"><Person name={student.displayName} email={student.email} avatarUrl={student.avatarUrl} /></span>
                <span className="shrink-0 text-right">
                  <strong className="block text-xs tabular-nums text-slate-900">{todo} to do</strong>
                  <span className="block text-[10px] tabular-nums text-slate-500">{done} done</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-w-0 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/20 p-3">
        {selectedStudent && (
          <>
            <div className="flex min-w-0 items-center justify-between gap-3 border-b border-slate-200/70 pb-2.5">
              <span className="min-w-0 flex-1">
                <strong className="block text-sm font-semibold text-slate-900">Assignment progress</strong>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
                  {selectedTodo.length} to do · {selectedDone.length} done
                </span>
              </span>
              <span className="shrink-0 text-right text-[11px] leading-4 text-slate-500" aria-label={`${selectedAssignments.length} assigned tasks`}>
                <strong className="block text-sm tabular-nums text-slate-900">{selectedAssignments.length}</strong>
                task{selectedAssignments.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-2.5 max-h-[20rem] space-y-3 overflow-y-auto overscroll-contain pr-0.5">
              {selectedAssignments.length === 0 && <EmptyState>No practice has been assigned to this student yet.</EmptyState>}
              {selectedTodo.length > 0 && (
                <section>
                  <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">To do · {selectedTodo.length}</h4>
                  <div className="grid gap-2 xl:grid-cols-2">{selectedTodo.map(taskCard)}</div>
                </section>
              )}
              {selectedDone.length > 0 && (
                <section>
                  <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">Done · {selectedDone.length}</h4>
                  <div className="grid gap-2 xl:grid-cols-2">{selectedDone.map(taskCard)}</div>
                </section>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AssignmentDirectory({
  assignments,
  students,
  organizationId,
  previewRole,
  selectedStudentId,
  onSelectStudent,
  onBack,
}: {
  assignments: NonNullable<Portal["practiceAssignments"]>;
  students: NonNullable<Portal["students"]>;
  organizationId: string | null;
  previewRole: "manager" | "teacher" | null;
  selectedStudentId: string | null;
  onSelectStudent: (studentId?: string | null, replace?: boolean) => void;
  onBack: () => void;
}) {
  const grouped = students
    .map((student) => ({
      student,
      assignments: assignments.filter((assignment) => assignment.studentUserId === student.userId),
    }))
    .filter((group) => group.assignments.length > 0)
    .sort((left, right) => {
      const leftName = left.student.displayName ?? left.student.email ?? "Student";
      const rightName = right.student.displayName ?? right.student.email ?? "Student";
      return leftName.localeCompare(rightName, "en-GB");
    });
  const selected = selectedStudentId
    ? grouped.find((group) => group.student.userId === selectedStudentId) ?? null
    : null;
  const title = selected
    ? selected.student.displayName ?? selected.student.email ?? "Student assignments"
    : "Student assignments";
  const goBack = selected ? () => onSelectStudent(null, true) : onBack;

  return (
    <GlassSection
      title={title}
      lead={selected ? "Tasks, status and completed sitting reviews." : "Choose a student to see every task and its status."}
      action={(
        <MobileDashboardBack
          onBack={goBack}
          desktopLabel={selected ? "Students" : "Assignments"}
          ariaLabel={selected ? "Back to assignment students" : "Back to assignments"}
        />
      )}
      headerClassName="max-sm:!flex-nowrap max-sm:!justify-start"
      className="md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto"
    >
      {selected ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {selected.assignments.map((assignment) => {
            const resultHref = assignment.completedAttemptId && organizationId
              ? sittingReviewHref(assignment.studentUserId, assignment.completedAttemptId, {
                  organizationId,
                  from: "assignment-directory",
                  previewRole,
                })
              : null;
            const body = (
              <>
                <span className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-900">{assignment.title}</span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      {assignment.dueAt ? `Due ${formatDate(assignment.dueAt)}` : `Set ${formatDate(assignment.assignedAt)}`}
                      {assignment.assignedByName ? ` · ${assignment.assignedByName}` : ""}
                    </span>
                  </span>
                  <StatusPill tone={assignment.completedAt ? "good" : "plain"}>{assignment.completedAt ? "Done" : "To do"}</StatusPill>
                </span>
                {assignment.note && <span className="mt-1.5 line-clamp-2 block text-[11px] leading-4 text-slate-600">{assignment.note}</span>}
                <span className="mt-2 flex items-center justify-between text-[11px] font-semibold text-indigo-700">
                  <span>{resultHref ? "Review sitting" : "Waiting for completion"}</span>
                  {resultHref && <span aria-hidden="true">›</span>}
                </span>
              </>
            );
            return resultHref ? (
              <Link key={assignment.id} href={resultHref} className="liquid-glass min-w-0 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5">
                {body}
              </Link>
            ) : (
              <article key={assignment.id} className="min-w-0 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5">
                {body}
              </article>
            );
          })}
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState>No practice has been assigned yet.</EmptyState>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {grouped.map(({ student, assignments: studentAssignments }) => {
            const done = studentAssignments.filter((assignment) => assignment.completedAt).length;
            const todo = studentAssignments.length - done;
            return (
              <button
                key={student.userId}
                type="button"
                className="liquid-glass group flex min-h-[4.5rem] min-w-0 items-center gap-2.5 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5 text-left"
                onClick={() => onSelectStudent(student.userId)}
              >
                <span className="min-w-0 flex-1"><Person name={student.displayName} email={student.email} avatarUrl={student.avatarUrl} /></span>
                <span className="shrink-0 text-right">
                  <strong className="block text-sm tabular-nums text-slate-900">{todo} to do</strong>
                  <span className="block text-[10px] text-slate-500">{done} done</span>
                </span>
                <span aria-hidden="true" className="text-lg text-slate-400 transition-transform group-hover:translate-x-0.5">›</span>
              </button>
            );
          })}
        </div>
      )}
    </GlassSection>
  );
}

function StudentCard({ student, previewRole = null }: { student: NonNullable<Portal["students"]>[number]; previewRole?: "manager" | "teacher" | null }) {
  const bands = Object.entries(student.latestBands);
  return (
    <StudentLink id={student.userId} previewRole={previewRole} className="group !p-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1"><Person name={student.displayName} email={student.email} avatarUrl={student.avatarUrl} /></div>
        <span className="shrink-0 text-right">
          <strong className="block text-sm tabular-nums text-slate-900">{student.completedAttempts}</strong>
          <span className="block text-[9px] uppercase tracking-wide text-slate-500">Sittings</span>
        </span>
        <span aria-hidden="true" className="text-lg text-slate-400 transition-transform group-hover:translate-x-0.5">›</span>
      </div>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2 border-t border-slate-200/60 pt-2">
        <div className="flex min-w-0 flex-wrap gap-1">
          {bands.length ? bands.map(([skill, band]) => (
            <span key={skill} className="rounded-md bg-slate-100/70 px-1.5 py-0.5 text-[10px] text-slate-600"><span className="sm:hidden">{skill.slice(0, 1).toUpperCase()}</span><span className="hidden sm:inline">{titleCase(skill)}</span> {band}</span>
          )) : <span className="text-[10px] text-slate-500">No scores yet</span>}
        </div>
        <span className="shrink-0 text-[10px] text-slate-500">{student.lastActiveAt ? formatDate(student.lastActiveAt) : "No activity"}</span>
      </div>
    </StudentLink>
  );
}

function managerViewFromLocation(): ManagerView {
  if (typeof window === "undefined") return "overview";
  const section = new URLSearchParams(window.location.search).get("section");
  return section && MANAGER_VIEWS.has(section as ManagerView) ? section as ManagerView : "overview";
}

function invitationFocusFromLocation(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  return (section === "members" || section === "team-invite") && params.get("invite") === "people";
}

function MobileManagerDashboard({
  requests,
  students,
  outstandingPractice,
  members,
  teachers,
  assignedStudents,
  onOpen,
}: {
  requests: number;
  students: NonNullable<Portal["students"]>;
  outstandingPractice: number;
  members: number;
  teachers: number;
  assignedStudents: number;
  onOpen: (view: Exclude<ManagerView, "overview">) => void;
}) {
  const totalSittings = students.reduce((total, student) => total + student.completedAttempts, 0);
  const unassigned = Math.max(0, students.length - assignedStudents);
  const cards: Array<{
    view: Exclude<ManagerView, "overview">;
    label: string;
    value: number;
    detail: string;
    icon: CardIconName;
  }> = [
    {
      view: "requests",
      label: "Requests",
      value: requests,
      detail: requests === 0 ? "Nothing needs a decision" : `${requests} waiting for a decision`,
      icon: "history",
    },
    {
      view: "students",
      label: "Students",
      value: students.length,
      detail: `${totalSittings} saved sitting${totalSittings === 1 ? "" : "s"}`,
      icon: "profile",
    },
    {
      view: "assignments",
      label: "Assignments",
      value: outstandingPractice,
      detail: outstandingPractice === 0 ? "No practice waiting" : `${outstandingPractice} practice item${outstandingPractice === 1 ? "" : "s"} to do`,
      icon: "plan",
    },
    {
      view: "members",
      label: "Team",
      value: members,
      detail: `${teachers} teacher${teachers === 1 ? "" : "s"} · ${unassigned} unassigned`,
      icon: "organization",
    },
  ];

  return (
    <nav aria-label="Organisation dashboard" className="grid gap-1.5 sm:hidden">
      {cards.map((card) => (
        <button
          key={card.view}
          type="button"
          className="card group flex min-h-[5rem] min-w-0 items-center gap-3 text-left !rounded-[var(--radius-xl)] !px-3 !py-2.5"
          onClick={() => onOpen(card.view)}
        >
          <CardIcon name={card.icon} size={34} className="text-indigo-700" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-900">{card.label}</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{card.detail}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <strong className="text-lg font-semibold tabular-nums tracking-tight text-slate-900">{card.value}</strong>
            <span aria-hidden="true" className="text-base text-slate-400 transition-transform group-hover:translate-x-0.5">›</span>
          </span>
        </button>
      ))}
    </nav>
  );
}

function MobileDashboardBack({
  onBack,
  desktopLabel = "Dashboard",
  ariaLabel = "Back to organisation dashboard",
}: {
  onBack: () => void;
  desktopLabel?: string;
  ariaLabel?: string;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        aria-label={ariaLabel}
        className="liquid-glass premade-glass order-first grid size-10 shrink-0 place-items-center overflow-hidden rounded-full border border-slate-200/75 bg-surface/55 !p-0 shadow-sm sm:hidden"
      >
        <RefractiveGlassLayer radius={999} interactive />
        <svg viewBox="0 0 24 24" aria-hidden="true" className="app-icon-color relative z-10 size-5 fill-current">
          <path d="m7.5 12 9-6.5v13Z" />
        </svg>
      </button>
      <button type="button" onClick={onBack} className="btn-secondary !hidden !min-h-9 !rounded-[var(--radius-lg)] !px-2.5 !py-1.5 text-[11px] sm:!inline-flex">
        <span aria-hidden="true">‹</span> {desktopLabel}
      </button>
    </>
  );
}

function ManagerArea({
  portal,
  act,
  busy,
  actorRole,
  previewRole,
  view,
  onOpenView,
  assignmentStudentId,
  onOpenAssignmentDirectory,
  notificationFocus,
}: {
  portal: Portal;
  act: Act;
  busy: boolean;
  actorRole: "manager" | "owner";
  previewRole: "manager" | null;
  view: ManagerView;
  onOpenView: (view: ManagerView, replace?: boolean) => void;
  assignmentStudentId: string | null;
  onOpenAssignmentDirectory: (studentId?: string | null, replace?: boolean) => void;
  notificationFocus: NotificationFocus;
}) {
  const [peopleQuery, setPeopleQuery] = useState("");
  const [invitationFocus, setInvitationFocus] = useState(invitationFocusFromLocation);
  const focusedRequestId = notificationFocus.kind === "request" ? notificationFocus.id : null;
  const focusedRequestRef = useRef<HTMLDivElement>(null);
  const invitationPanelRef = useRef<HTMLElement>(null);
  const students = portal.students ?? [];
  // Invitation acceptance belongs to the invited learner. Managers decide
  // join, leave and access requests only; sending an invitation id to the join
  // decision command would be correctly refused by the database.
  const requests = (portal.requests ?? []).filter(
    (item) => item.status === "pending" && item.kind !== "invitation",
  );
  const focusedRequestExists = Boolean(focusedRequestId && requests.some((request) => request.id === focusedRequestId));
  const invitations = (portal.requests ?? []).filter(
    (item) => item.status === "pending" && item.kind === "invitation",
  );
  const members = portal.members ?? [];
  const teachers = members.filter((member) => member.role === "teacher");
  const normalizedPeopleQuery = peopleQuery.trim().toLowerCase();
  const filteredStudents = normalizedPeopleQuery
    ? students.filter((student) => {
        if (`${student.displayName ?? ""} ${student.email ?? ""}`.toLowerCase().includes(normalizedPeopleQuery)) return true;
        const teacherIds = new Set((portal.assignments ?? [])
          .filter((assignment) => assignment.studentUserId === student.userId)
          .map((assignment) => assignment.teacherUserId));
        return members.some((member) => teacherIds.has(member.userId)
          && `${member.displayName ?? ""} ${member.email ?? ""}`.toLowerCase().includes(normalizedPeopleQuery));
      })
    : students;
  const filteredMembers = normalizedPeopleQuery
    ? members.filter((member) => {
        const selfMatches = `${member.displayName ?? ""} ${member.email ?? ""}`.toLowerCase().includes(normalizedPeopleQuery);
        if (selfMatches) return true;
        if (member.role === "teacher") {
          const assignedStudentIds = new Set((portal.assignments ?? [])
            .filter((assignment) => assignment.teacherUserId === member.userId)
            .map((assignment) => assignment.studentUserId));
          return members.some((candidate) => assignedStudentIds.has(candidate.userId)
            && `${candidate.displayName ?? ""} ${candidate.email ?? ""}`.toLowerCase().includes(normalizedPeopleQuery));
        }
        if (member.role === "student") {
          const assignedTeacherIds = new Set((portal.assignments ?? [])
            .filter((assignment) => assignment.studentUserId === member.userId)
            .map((assignment) => assignment.teacherUserId));
          return members.some((candidate) => assignedTeacherIds.has(candidate.userId)
            && `${candidate.displayName ?? ""} ${candidate.email ?? ""}`.toLowerCase().includes(normalizedPeopleQuery));
        }
        return false;
      })
    : members;
  const organizationId = portal.activeOrganizationId;
  const selectedOrganization = portal.memberships.find(
    (membership) => membership.organization.id === organizationId,
  )?.organization ?? portal.organizations?.find((organization) => organization.id === organizationId) ?? null;
  const canDeleteOrganization = portal.actor.platformAdmin || actorRole === "manager" || actorRole === "owner";
  const recentStudents = [...students]
    .sort((left, right) => Date.parse(right.lastActiveAt ?? "") - Date.parse(left.lastActiveAt ?? ""))
    .slice(0, 2);
  const assignedStudents = new Set((portal.assignments ?? []).map((assignment) => assignment.studentUserId)).size;
  const practiceAssignments = portal.practiceAssignments ?? [];
  const outstandingPractice = practiceAssignments.filter((assignment) => !assignment.completedAt).length;
  const teamAssignments = portal.assignments ?? [];
  const pairedTeacherCount = new Set(teamAssignments.map((assignment) => assignment.teacherUserId)).size;
  const pairedStudentCount = new Set(teamAssignments.map((assignment) => assignment.studentUserId)).size;

  useEffect(() => {
    if (view !== "requests" || !focusedRequestExists) return;
    const frame = requestAnimationFrame(() => {
      focusedRequestRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      focusedRequestRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedRequestExists, focusedRequestId, view]);

  useEffect(() => {
    const syncInvitationFocus = () => setInvitationFocus(invitationFocusFromLocation());
    window.addEventListener("popstate", syncInvitationFocus);
    return () => window.removeEventListener("popstate", syncInvitationFocus);
  }, []);

  useEffect(() => {
    // Keep existing invite links working while moving the form out of the
    // directory. Replacing this URL means Back never returns to an obsolete
    // embedded-panel state.
    if ((view !== "members" && view !== "team-invite") || !invitationFocus || !invitationFocusFromLocation()) return;
    onOpenView("team-invite", true);
  }, [invitationFocus, onOpenView, view]);

  useEffect(() => {
    if (view !== "team-invite" || !invitationFocus) return;
    const frame = requestAnimationFrame(() => {
      invitationPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      invitationPanelRef.current?.focus({ preventScroll: true });
      setInvitationFocus(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [invitationFocus, view]);

  const openInvitationPanel = () => {
    setInvitationFocus(true);
    onOpenView("team-invite");
  };

  return (
    <div className="space-y-2 lg:min-h-0">
      {view === "overview" && (
        <MobileManagerDashboard
          requests={requests.length}
          students={students}
          outstandingPractice={outstandingPractice}
          assignedStudents={assignedStudents}
          members={members.length}
          teachers={teachers.length}
          onOpen={onOpenView}
        />
      )}
      {view === "overview" && (
        <div className="hidden gap-2 sm:grid sm:grid-cols-2 lg:grid-cols-3">
          <GlassSection title="Pending requests" lead="Join, leave and history-access decisions." className="sm:max-h-[19rem] sm:overflow-y-auto">
            {requests.length === 0 ? <EmptyState>No requests need a decision.</EmptyState> : (
              <div className="space-y-2">{requests.map((request) => <RequestRow key={request.id} request={request} act={act} busy={busy} />)}</div>
            )}
          </GlassSection>
          <GlassSection title="Practice assignments" lead="Work set for students in this organisation." className="sm:max-h-[19rem] sm:overflow-y-auto">
            {practiceAssignments.length === 0 ? (
              <EmptyState>No practice has been assigned yet.</EmptyState>
            ) : (
              <>
                <PracticeAssignmentSummary
                  assignments={practiceAssignments}
                  students={students}
                  onOpenStudent={(studentId) => onOpenAssignmentDirectory(studentId)}
                />
                <button type="button" className="btn-secondary mt-2 w-full !min-h-9 !rounded-[var(--radius-lg)] !px-3 !py-2 text-xs" onClick={() => onOpenView("assignments")}>
                  Manage assignments
                </button>
              </>
            )}
          </GlassSection>
          <GlassSection title="Recent activity" lead="Open the latest learner records." className="sm:col-span-2 sm:max-h-[19rem] sm:overflow-y-auto lg:col-span-1">
            {recentStudents.length === 0 ? <EmptyState>No student activity yet.</EmptyState> : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {recentStudents.map((student) => (
                  <StudentLink key={student.userId} id={student.userId} previewRole={previewRole} className="!p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <Person name={student.displayName} email={student.email} avatarUrl={student.avatarUrl} />
                      <span className="shrink-0 text-right">
                        <strong className="block text-sm tabular-nums text-slate-900">{student.completedAttempts}</strong>
                        <span className="block text-[9px] uppercase tracking-wide text-slate-500">Sittings</span>
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] text-slate-500">{student.lastActiveAt ? `Active ${formatDate(student.lastActiveAt)}` : "No activity yet"}</p>
                  </StudentLink>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn-secondary mt-2 w-full !min-h-9 !rounded-[var(--radius-lg)] !px-3 !py-2 text-xs"
              onClick={openInvitationPanel}
            >
              Invite students or teachers
            </button>
          </GlassSection>
        </div>
      )}

      {view === "requests" && (
        <GlassSection title="Pending requests" lead="Join, leave and history-access decisions." action={<MobileDashboardBack onBack={() => onOpenView("overview", true)} />} className="md:max-h-[26rem] md:overflow-y-auto">
          {notificationFocus.kind === "request" && !focusedRequestExists && (
            <p role="status" className="mb-2 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/35 px-3 py-2 text-xs text-slate-600">
              That request is no longer pending. It may already have been decided.
            </p>
          )}
          {requests.length === 0 ? <EmptyState>No requests need a decision.</EmptyState> : (
            <div className="space-y-2">{requests.map((request) => (
              <RequestRow
                key={request.id}
                request={request}
                act={act}
                busy={busy}
                highlighted={request.id === focusedRequestId}
                targetRef={request.id === focusedRequestId ? focusedRequestRef : undefined}
              />
            ))}</div>
          )}
        </GlassSection>
      )}

      {view === "assignments" && (
        <GlassSection
          title="Practice assignments"
          lead="Set one practice item for one or more students."
          action={<MobileDashboardBack onBack={() => onOpenView("overview", true)} />}
          headerClassName="max-sm:!flex-nowrap max-sm:!justify-start"
          className="md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto"
        >
          {!organizationId ? (
            <EmptyState>No active organisation is selected.</EmptyState>
          ) : (
            <PracticeAssignmentForm
              organizationId={organizationId}
              students={students}
              act={act}
              busy={busy}
            />
          )}
          <AssignmentDirectoryCard assignments={practiceAssignments} onOpen={() => onOpenAssignmentDirectory()} className="sm:hidden" />
          <AssignmentDesktopWorkspace
            assignments={practiceAssignments}
            students={students}
            organizationId={organizationId}
            previewRole={previewRole}
          />
        </GlassSection>
      )}

      {view === "assignment-directory" && (
        <AssignmentDirectory
          assignments={practiceAssignments}
          students={students}
          organizationId={organizationId}
          previewRole={previewRole}
          selectedStudentId={assignmentStudentId}
          onSelectStudent={onOpenAssignmentDirectory}
          onBack={() => onOpenView("assignments", true)}
        />
      )}

      {view === "students" && (
        <GlassSection title="Students" lead="Open a learner to review scores, answers and feedback." action={<ManagerPeopleActions query={peopleQuery} onQuery={setPeopleQuery} onBack={() => onOpenView("overview", true)} />} className="md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto">
          {filteredStudents.length === 0 ? <EmptyState>{students.length ? "No students match that search." : "No active students yet."}</EmptyState> : (
            <div className="grid gap-2 sm:grid-cols-2">{filteredStudents.map((student) => <StudentCard key={student.userId} student={student} previewRole={previewRole} />)}</div>
          )}
        </GlassSection>
      )}

      {view === "members" && (
        <GlassSection
          title="Team"
          lead="Choose how to manage people and their pairings."
          action={<MobileDashboardBack onBack={() => onOpenView("overview", true)} />}
          className="md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto"
        >
          <div className="organization-team-directory-grid grid gap-2 sm:grid-cols-3" data-team-directory>
            <TeamDirectoryCard
              destination="invite"
              title="Invite people"
              detail={actorRole === "owner" || portal.actor.platformAdmin
                ? "Invite students, teachers or managers to join this organisation."
                : "Invite students or teachers to join this organisation."}
              icon="profile"
              onOpen={() => onOpenView("team-invite")}
            />
            <TeamDirectoryCard
              destination="assignment"
              title="Assign students to a teacher"
              detail="Choose one teacher and one or more students for a new pairing."
              icon="tutor"
              onOpen={() => onOpenView("team-assignment")}
            />
            <TeamDirectoryCard
              destination="pairings"
              title="Review team pairings"
              detail={teamAssignments.length
                ? `${pairedTeacherCount} teacher${pairedTeacherCount === 1 ? "" : "s"} paired with ${pairedStudentCount} student${pairedStudentCount === 1 ? "" : "s"}`
                : "See current groups and unassign students when needed."}
              icon="organization"
              onOpen={() => onOpenView("team-pairings")}
            />
          </div>
        </GlassSection>
      )}

      {view === "team-invite" && (
        <GlassSection
          title="Invite people"
          lead="Choose a role, then invite an existing BandUp account."
          action={<MobileDashboardBack onBack={() => onOpenView("members", true)} desktopLabel="Team" ariaLabel="Back to team" />}
          headerClassName="max-sm:!flex-nowrap max-sm:!justify-start"
          className="md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto"
        >
          {!organizationId ? <EmptyState>No active organisation is selected.</EmptyState> : (
            <section
              ref={invitationPanelRef}
              tabIndex={-1}
              aria-labelledby="organisation-invite-people"
              data-team-invite-page
              className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/45"
            >
              <h3 id="organisation-invite-people" className="text-sm font-semibold text-slate-900">Invite people</h3>
              <p className="mt-0.5 text-xs leading-4 text-slate-500">Choose Student or Teacher, then find their exact BandUp username. They decide whether to join.</p>
              <div className="mt-2.5">
                <InvitationForm
                  organizationId={organizationId}
                  actorRole={actorRole}
                  platformAdmin={portal.actor.platformAdmin}
                  act={act}
                  busy={busy}
                  previewRole={previewRole}
                />
              </div>
              <div className="mt-3">
                <JoinCodeCard joinCode={portal.joinCode} />
              </div>
              {invitations.length > 0 && (
                <div className="mt-3 rounded-xl border border-slate-200/70 bg-surface/20 px-3">
                  {invitations.map((invitation) => (
                    <div key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/70 py-2.5 last:border-b-0">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-900">{invitation.invitationEmail ?? "Invited account"}</span>
                        <span className="block text-xs text-slate-500">{titleCase(invitation.requestedRole ?? "student")} · Sent {formatDate(invitation.createdAt)}</span>
                      </span>
                      <StatusPill tone="warn">Awaiting acceptance</StatusPill>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </GlassSection>
      )}

      {view === "team-assignment" && (
        <GlassSection
          title="Assign students to a teacher"
          lead="Select one teacher and one or more students to create a team pairing."
          action={<MobileDashboardBack onBack={() => onOpenView("members", true)} desktopLabel="Team" ariaLabel="Back to team" />}
          headerClassName="max-sm:!flex-nowrap max-sm:!justify-start"
          className="md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto"
        >
          <div data-team-assignment-page>
            {!organizationId ? <EmptyState>No active organisation is selected.</EmptyState> : (
              <TeacherAssignments
                organizationId={organizationId}
                teachers={teachers}
                students={members.filter((member) => member.role === "student")}
                assignments={teamAssignments}
                act={act}
                busy={busy}
              />
            )}
          </div>
        </GlassSection>
      )}

      {view === "team-pairings" && (
        <GlassSection
          title="Team pairings"
          lead="Review each teacher and the students assigned to them."
          action={(
            <ManagerPeopleActions
              query={peopleQuery}
              onQuery={setPeopleQuery}
              onBack={() => onOpenView("members", true)}
              desktopBackLabel="Team"
              backAriaLabel="Back to team"
              searchPlaceholder="Search team"
            />
          )}
          headerClassName="max-sm:!flex-nowrap max-sm:!justify-start"
          className="organization-team-pairings-page md:max-h-[calc(100dvh-8rem)] md:overflow-y-auto"
        >
          {filteredMembers.length === 0 ? <EmptyState>{members.length ? "No team members match that search." : "No members are visible."}</EmptyState> : (
            <TeamGroups
              members={filteredMembers}
              assignments={teamAssignments}
              organizationId={organizationId}
              act={act}
              busy={busy}
            />
          )}
        </GlassSection>
      )}

      {view === "settings" && (
        <>
        <GlassSection
          title="Organisation settings"
          lead="Workspace access, privacy and membership controls."
          action={<MobileDashboardBack onBack={() => onOpenView("overview", true)} />}
        >
          <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/25 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl border border-slate-200/70 bg-surface/50 text-indigo-700">
                    <CardIcon name="organization" size={17} className="text-current" />
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-sm text-slate-900">Workspace</strong>
                    <span className="block truncate text-xs text-slate-500">{portal.memberships.find((item) => item.organization.id === organizationId)?.organization.name ?? "Current organisation"}</span>
                  </span>
                </div>
              </div>
              <div className="rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/25 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl border border-slate-200/70 bg-surface/50 text-indigo-700">
                    <CardIcon name="gear" size={17} className="text-current" />
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-sm text-slate-900">Privacy & data access</strong>
                    <span className="block text-xs leading-4 text-slate-500">Teachers only see assigned learners. Managers can review organisation records.</span>
                  </span>
                </div>
                <Link href="/privacy" className="mt-2 inline-flex text-xs font-semibold text-indigo-700 underline decoration-indigo-300 underline-offset-4">
                  Read BandUp privacy controls
                </Link>
              </div>
          </div>
          {organizationId && selectedOrganization && canDeleteOrganization && (
            <OrganizationDeletionControl
              organizationId={organizationId}
              organizationName={selectedOrganization.name}
              act={act}
              busy={busy}
            />
          )}
        </GlassSection>
        <CreateAnotherOrganizationSection act={act} busy={busy} />
        </>
      )}
    </div>
  );
}

function invitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function MemberRolePicker({
  member,
  organizationId,
  disabled,
  act,
}: {
  member: NonNullable<Portal["members"]>[number];
  organizationId: string | null;
  disabled: boolean;
  act: Act;
}) {
  // Both managers and owners may set any of these three roles on a non-owner
  // member — the server enforces the actual boundary (an owner is untouchable
  // here regardless, and only an owner or platformAdmin may grant "owner",
  // which is why that option never appears in this list at all).
  const options = [
    { value: "student", label: "Student" },
    { value: "teacher", label: "Teacher" },
    { value: "manager", label: "Manager" },
  ];
  return (
    <div className="min-w-0">
      <GlassSelect
        label={`Role for ${member.displayName ?? member.email ?? "member"}`}
        placeholder="Choose role"
        value={member.role}
        options={options}
        disabled={disabled}
        onValueChange={(role) => {
          if (!organizationId || role === member.role) return;
          void act("change_member_role", {
            ...memberActionPayload(organizationId, member.userId),
            role,
          });
        }}
      />
    </div>
  );
}

const memberActionClass = "btn-secondary !min-h-10 w-full !rounded-xl !px-2 !py-2 !text-sm";

function ManagerPeopleActions({
  query,
  onQuery,
  onBack,
  desktopBackLabel = "Dashboard",
  backAriaLabel = "Back to organisation dashboard",
  searchPlaceholder = "Search students or teachers",
}: {
  query: string;
  onQuery: (value: string) => void;
  onBack: () => void;
  desktopBackLabel?: string;
  backAriaLabel?: string;
  searchPlaceholder?: string;
}) {
  return (
    <div className="order-first flex w-full min-w-0 items-center gap-2 sm:order-none sm:w-auto sm:flex-wrap sm:justify-end">
      <MobileDashboardBack onBack={onBack} desktopLabel={desktopBackLabel} ariaLabel={backAriaLabel} />
      <label className="relative min-w-0 flex-1 sm:order-first sm:w-64 sm:flex-none">
        <span className="sr-only">Search students and teachers</span>
        <input value={query} onChange={(event) => onQuery(event.target.value)} className="input min-h-10 w-full rounded-[var(--radius-lg)] border border-slate-300 bg-surface/60 px-3 text-sm text-slate-900" placeholder={searchPlaceholder} />
      </label>
    </div>
  );
}

function MemberManagement({ member, organizationId, act, busy, compact = false }: {
  member: NonNullable<Portal["members"]>[number];
  organizationId: string | null;
  act: Act;
  busy: boolean;
  compact?: boolean;
}) {
  if (member.role === "owner") return null;
  return (
    <details className={`${compact ? "organization-team-pairing-manage mt-1 px-2 py-1" : "mt-2 px-2.5 py-2"} rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/20`}>
      <summary className="cursor-pointer text-xs font-semibold text-slate-600">Manage member</summary>
      <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        <MemberRolePicker member={member} organizationId={organizationId} act={act} disabled={busy} />
        <button type="button" className={memberActionClass} disabled={busy} onClick={() => {
          if (!organizationId) return;
          void act(member.status === "suspended" ? "restore_member" : "suspend_member", memberActionPayload(organizationId, member.userId));
        }}>{member.status === "suspended" ? "Restore" : "Suspend"}</button>
        <button type="button" className={`${memberActionClass} !border-rose-300 !text-rose-800`} disabled={busy} onClick={() => {
          const label = member.displayName ?? member.email ?? "this member";
          if (organizationId && window.confirm(`Remove ${label} from the organisation?`)) void act("remove_member", memberActionPayload(organizationId, member.userId));
        }}>Remove</button>
      </div>
    </details>
  );
}

function TeamDirectoryCard({
  destination,
  title,
  detail,
  icon,
  onOpen,
}: {
  destination: "invite" | "assignment" | "pairings";
  title: string;
  detail: string;
  icon: CardIconName;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-team-directory-card={destination}
      className="organization-team-directory-card liquid-glass group flex min-h-[5.25rem] w-full min-w-0 items-center gap-3 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5 text-left transition-colors hover:bg-surface/50 sm:min-h-[7.25rem] sm:items-start sm:px-3.5 sm:py-3"
      onClick={onOpen}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-slate-200/70 bg-surface/45 text-indigo-700 sm:size-10">
        <CardIcon name={icon} size={22} className="text-current" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-900">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{detail}</span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-lg text-slate-400 transition-transform group-hover:translate-x-0.5">›</span>
    </button>
  );
}

function TeamGroups({ members, assignments, organizationId, act, busy }: {
  members: NonNullable<Portal["members"]>;
  assignments: NonNullable<Portal["assignments"]>;
  organizationId: string | null;
  act: Act;
  busy: boolean;
}) {
  const [pendingUnassign, setPendingUnassign] = useState<string | null>(null);
  const teachers = members.filter((member) => member.role === "teacher");
  const students = members.filter((member) => member.role === "student");
  /*
    Managers and the owner are listed too, and this is not cosmetic.

    This grid used to render teachers and students only, which was fine while
    only an owner could appoint a manager. Now that a manager can, leaving
    them out would mean promoting somebody to manager made them *disappear*
    from the roster, with nothing anywhere able to demote them again — the
    grant would work and the removal would be unreachable, which is half a
    feature and the wrong half.

    The owner appears for a different reason: so that a manager can see who
    they are. No controls are drawn against them, because the server refuses
    every one of them anyway ("Only BandUp can manage an owner"), and a button
    that always fails is worse than no button.
  */
  const leaders = members.filter((member) => member.role === "manager" || member.role === "owner");
  const assignedIds = new Set(assignments.map((assignment) => assignment.studentUserId));
  const groups = teachers.map((teacher) => ({
    teacher,
    students: students.filter((student) => assignments.some((assignment) => assignment.teacherUserId === teacher.userId && assignment.studentUserId === student.userId)),
  }));
  const unassigned = students.filter((student) => !assignedIds.has(student.userId));
  useEffect(() => {
    if (!pendingUnassign) return;
    const timeout = window.setTimeout(() => setPendingUnassign(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [pendingUnassign]);
  if (groups.length === 0 && unassigned.length === 0 && leaders.length === 0) {
    return <EmptyState>Nobody is visible in this organisation yet.</EmptyState>;
  }
  return (
    <>
    {leaders.length > 0 && (
      <section className="card mt-1.5 min-w-0 !rounded-[var(--radius-xl)]">
        <h4 className="mb-1.5 text-xs font-semibold text-slate-600">Owners and managers</h4>
        <div className="space-y-1.5">
          {leaders.map((leader) => (
            <div key={leader.userId} className="rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/25 px-2 py-1.5">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 flex-1"><Person name={leader.displayName} email={leader.email} avatarUrl={leader.avatarUrl} /></span>
                <StatusPill>{titleCase(leader.role)}</StatusPill>
              </div>
              {leader.role === "manager" && (
                <MemberManagement member={leader} organizationId={organizationId} act={act} busy={busy} compact />
              )}
            </div>
          ))}
        </div>
      </section>
    )}
    <div className="organization-team-pairing-grid mt-1.5 grid gap-2 lg:grid-cols-2">
      {groups.map(({ teacher, students: groupStudents }) => (
        <section key={teacher.userId} className="organization-team-pairing-group card min-w-0 !rounded-[var(--radius-xl)]">
          <div className="flex items-center justify-between gap-2">
            <span className="organization-team-pairing-identity min-w-0 flex-1"><Person name={teacher.displayName} email={teacher.email} avatarUrl={teacher.avatarUrl} /></span>
            <StatusPill>Teacher</StatusPill>
          </div>
          <MemberManagement member={teacher} organizationId={organizationId} act={act} busy={busy} compact />
          <div className="organization-team-pairing-members mt-1.5 space-y-1.5 border-t border-slate-200/60 pt-1.5 sm:max-h-80 sm:overflow-y-auto sm:overscroll-contain sm:pr-0.5">
            {groupStudents.length ? groupStudents.map((student) => (
              <div key={student.userId} className="organization-team-pairing-member rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/25 px-2 py-1.5">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="organization-team-pairing-identity min-w-0 flex-1"><Person name={student.displayName} email={student.email} avatarUrl={student.avatarUrl} /></span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <StatusPill tone={student.status === "active" ? "good" : "warn"}>{titleCase(student.status)}</StatusPill>
                    {pendingUnassign === `${teacher.userId}:${student.userId}` && (
                      <>
                        <span role="status" className="text-[10px] font-semibold text-rose-700">Confirm?</span>
                        <button
                          type="button"
                          className="btn-secondary grid !size-8 !min-h-8 shrink-0 place-items-center !rounded-full !p-0 text-slate-600"
                          aria-label="Cancel unassign"
                          title="Cancel"
                          onClick={() => setPendingUnassign(null)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-none stroke-current" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 7 4 12l5 5M5 12h9a5 5 0 0 1 5 5" />
                          </svg>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={`organization-team-unassign btn-secondary grid !size-9 !min-h-9 shrink-0 place-items-center !rounded-full !p-0 text-rose-700 ${pendingUnassign === `${teacher.userId}:${student.userId}` ? "!border-rose-400 !bg-rose-50/75 ring-2 ring-rose-300/50" : ""}`}
                      disabled={busy || !organizationId}
                      aria-label={`${pendingUnassign === `${teacher.userId}:${student.userId}` ? "Confirm unassign" : "Unassign"} ${student.displayName ?? student.email ?? "student"} from ${teacher.displayName ?? teacher.email ?? "teacher"}`}
                      title={pendingUnassign === `${teacher.userId}:${student.userId}` ? "Confirm unassign" : "Unassign student"}
                      onClick={() => {
                        if (!organizationId) return;
                        const pairingKey = `${teacher.userId}:${student.userId}`;
                        if (pendingUnassign !== pairingKey) {
                          setPendingUnassign(pairingKey);
                          return;
                        }
                        setPendingUnassign(null);
                        void act("unassign_teacher", teacherAssignmentPayload(organizationId, teacher.userId, student.userId));
                      }}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4.5 fill-none stroke-current" strokeWidth="2" strokeLinecap="round">
                        <path d="m7 7 10 10M17 7 7 17" />
                      </svg>
                    </button>
                  </span>
                </div>
                <MemberManagement member={student} organizationId={organizationId} act={act} busy={busy} compact />
              </div>
            )) : <p className="text-xs text-slate-500">No students assigned.</p>}
          </div>
        </section>
      ))}
      {unassigned.length > 0 && (
        <section className="organization-team-pairing-group card min-w-0 !rounded-[var(--radius-xl)]">
          <h3 className="text-sm font-semibold text-slate-900">Unassigned students</h3>
          <div className="organization-team-pairing-members mt-1.5 space-y-1.5 sm:max-h-80 sm:overflow-y-auto sm:overscroll-contain sm:pr-0.5">{unassigned.map((student) => (
            <div key={student.userId} className="organization-team-pairing-member rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/25 px-2 py-1.5">
              <span className="organization-team-pairing-identity block min-w-0"><Person name={student.displayName} email={student.email} avatarUrl={student.avatarUrl} /></span>
              <MemberManagement member={student} organizationId={organizationId} act={act} busy={busy} compact />
            </div>
          ))}</div>
        </section>
      )}
    </div>
    </>
  );
}

function JoinCodeCard({ joinCode }: { joinCode: string | null }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const codeRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  useEffect(() => {
    if (!copyFailed) return;
    codeRef.current?.select();
  }, [copyFailed]);
  return (
    <div className="rounded-xl border border-slate-200/70 bg-surface/25 p-2.5 sm:p-3">
      <span className="mb-1 block text-xs font-semibold text-slate-600">Join code</span>
      <p className="mb-2 text-xs leading-4 text-slate-500">
        Anyone with this code can ask to join. It still comes to you as a request — sharing the code does not add them until you approve it.
      </p>
      {joinCode ? (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={codeRef} aria-label="Organisation join code" readOnly value={joinCode} className="input min-h-9 min-w-0 flex-1 rounded-lg border border-slate-300 bg-surface/60 px-2.5 font-mono text-xs text-slate-700" />
          <button
            type="button"
            className="btn-secondary min-h-9 !px-3 text-xs"
            /*
              The clipboard can refuse — an insecure context, a denied
              permission, an in-app browser without the API at all — and an
              unhandled rejection here would leave the button saying nothing
              while the manager thinks they have the code. On a refusal the
              code is selected instead, so copying by hand is one keystroke
              rather than a careful drag across a monospace string.
            */
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(joinCode);
                setCopied(true);
              } catch {
                setCopyFailed(true);
              }
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
          {copyFailed && (
            <span role="status" className="w-full text-xs leading-4 text-slate-500">
              This browser would not let BandUp copy for you. The code is selected — copy it yourself.
            </span>
          )}
        </div>
      ) : (
        <EmptyState>No join code is on record for this organisation.</EmptyState>
      )}
    </div>
  );
}

function InvitationForm({
  organizationId,
  actorRole,
  platformAdmin,
  act,
  busy,
  previewRole,
}: {
  organizationId: string;
  actorRole: "manager" | "owner";
  platformAdmin: boolean;
  act: Act;
  busy: boolean;
  previewRole: "manager" | null;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"student" | "teacher" | "manager">("student");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const roleOptions = [
    { value: "student", label: "Student" },
    { value: "teacher", label: "Teacher" },
    ...((actorRole === "owner" || platformAdmin) ? [{ value: "manager", label: "Manager" }] : []),
  ];

  return (
    <div className="rounded-xl border border-slate-200/70 bg-surface/25 p-2.5 sm:p-3">
      <div className="grid min-w-0 gap-2.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-end">
        <div className="min-w-0">
          <span className="mb-1 block text-xs font-semibold text-slate-600">Invite as</span>
          {/* The role chooser and the username field beside it are one control
              pair and must line up at the same height, so the compact variant
              is deliberately not used here. */}
          <GlassSelect
            label="Invitation role"
            value={role}
            options={roleOptions}
            className="w-full"
            onValueChange={(value) => {
              setRole(value as typeof role);
              setLink(null);
              setCopied(false);
            }}
          />
        </div>
        <UsernameInvitationForm
          key={role}
          organizationId={organizationId}
          role={role}
          act={act}
          busy={busy}
          previewRole={previewRole}
          onInvited={(invitationLink) => {
            setLink(invitationLink);
            setCopied(false);
          }}
        />
      </div>
      <details className="mt-3 border-t border-slate-200/70 pt-2">
        <summary className="cursor-pointer text-xs font-semibold text-slate-600">Invite by email instead</summary>
      <form
        className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          const token = invitationToken();
          const result = await act("invite_member", {
            organizationId,
            email: email.trim().toLowerCase(),
            role,
            token,
          });
          if (!result?.invitation) return;
          setLink(`${window.location.origin}/organization/invite?request=${encodeURIComponent(result.invitation.requestId)}#token=${encodeURIComponent(token)}`);
          setCopied(false);
        }}
      >
        <label className="min-w-0">
          <span className="mb-1 block text-xs font-semibold text-slate-600">Invite by email</span>
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="input min-h-10 w-full rounded-xl border border-slate-300 bg-surface/60 px-3 py-2 text-sm text-slate-900"
            placeholder={`${role}@example.com`}
          />
        </label>
        <button type="submit" className="btn-primary min-h-10 !px-4" disabled={busy || !email.trim()}>
          Create invite
        </button>
      </form>
      </details>
      {link && (
        <div role="status" className="mt-2 flex flex-wrap items-center gap-2">
          <input aria-label="Invitation link" readOnly value={link} className="input min-h-9 min-w-0 flex-1 rounded-lg border border-slate-300 bg-surface/60 px-2.5 text-xs text-slate-700" />
          <button
            type="button"
            className="btn-secondary min-h-9 !px-3 text-xs"
            onClick={async () => {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
    </div>
  );
}

function UsernameInvitationForm({
  organizationId,
  role,
  act,
  busy,
  previewRole,
  onInvited,
}: {
  organizationId: string;
  role: "student" | "teacher" | "manager";
  act: Act;
  busy: boolean;
  previewRole: "manager" | "teacher" | null;
  onInvited?: (link: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<{ userId: string; username: string; displayName: string | null } | null>(null);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [ownLink, setOwnLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invitationLink = ownLink;
  return (
    <div>
      <form
        className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          const clean = username.trim().replace(/^@/, "").toLowerCase();
          if (!clean) return;
          setSearching(true);
          setSearchError(null);
          try {
            const response = await authedFetch(apiUrl(`/api/organization/search?kind=user&organization=${encodeURIComponent(organizationId)}&q=${encodeURIComponent(clean)}`), {
              cache: "no-store",
              headers: organizationPreviewRequestHeaders(previewRole),
            });
            if (!response.ok) throw new Error("Username search is unavailable just now.");
            const body = await response.json() as import("@/lib/organizations/types").OrganizationDiscoveryResponse;
            setResult(body.kind === "user" ? body.results[0] ?? null : null);
            setSearched(true);
          } catch (error) {
            setResult(null);
            setSearched(false);
            setSearchError(error instanceof Error ? error.message : "Username search is unavailable just now.");
          } finally {
            setSearching(false);
          }
        }}
      >
        <label className="min-w-0">
          <span className="mb-1 block text-xs font-semibold text-slate-600">BandUp username</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="input min-h-11 w-full rounded-xl border border-slate-300 bg-surface/60 px-3 py-2 text-sm text-slate-900"
            autoComplete="off"
            placeholder="@student.username"
            maxLength={31}
          />
        </label>
        <button type="submit" className="btn-secondary min-h-11 !px-4" disabled={searching || !username.trim()}>
          {searching ? <LoadingIndicator label="Searching…" announce={false} /> : "Find account"}
        </button>
      </form>
      {searchError && <p role="alert" className="mt-2 text-xs text-rose-700">{searchError}</p>}
      {searched && !result && <p className="mt-2 text-xs text-slate-500">No available account has that exact username.</p>}
      {result && (
        <div className="mt-2 flex min-w-0 items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/30 px-3 py-2.5">
          <span className="min-w-0">
            <strong className="block truncate text-sm text-slate-900">{result.displayName ?? `@${result.username}`}</strong>
            <span className="block truncate text-xs text-slate-500">@{result.username}</span>
          </span>
          <button
            type="button"
            className="btn-primary shrink-0 !min-h-9 !rounded-[var(--radius-lg)] !px-3 text-xs"
            disabled={busy}
            onClick={async () => {
              const token = invitationToken();
              const response = await act("invite_member", { organizationId, userId: result.userId, role, token });
              if (!response?.invitation) return;
              const link = `${window.location.origin}/organization/invite?request=${encodeURIComponent(response.invitation.requestId)}#token=${encodeURIComponent(token)}`;
              if (onInvited) onInvited(link);
              else setOwnLink(link);
              setCopied(false);
            }}
          >
            Invite
          </button>
        </div>
      )}
      {invitationLink && (
        <div role="status" className="mt-2 flex flex-wrap items-center gap-2">
          <input aria-label="Invitation link" readOnly value={invitationLink} className="input min-h-9 min-w-0 flex-1 rounded-lg border border-slate-300 bg-surface/60 px-2.5 text-xs text-slate-700" />
          <button type="button" className="btn-secondary min-h-9 !px-3 text-xs" onClick={async () => { await navigator.clipboard.writeText(invitationLink); setCopied(true); }}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
    </div>
  );
}

function TeacherAssignments({
  organizationId,
  teachers,
  students,
  assignments,
  act,
  busy,
}: {
  organizationId: string;
  teachers: NonNullable<Portal["members"]>;
  students: NonNullable<Portal["members"]>;
  assignments: NonNullable<Portal["assignments"]>;
  act: Act;
  busy: boolean;
}) {
  const [teacherUserId, setTeacherUserId] = useState("");
  const [studentPickerOpen, setStudentPickerOpen] = useState(false);
  const [studentUserIds, setStudentUserIds] = useState<string[]>([]);
  const [studentButton, setStudentButton] = useState<HTMLButtonElement | null>(null);
  const activeTeachers = teachers.filter((member) => member.status === "active");
  const activeStudents = students.filter((member) => member.status === "active" || member.status === "leave_requested");
  const availableStudents = activeStudents.filter((student) => !assignments.some(
    (item) => item.teacherUserId === teacherUserId && item.studentUserId === student.userId,
  ));
  const selectedStudents = activeStudents.filter((student) => studentUserIds.includes(student.userId));

  if (activeTeachers.length === 0 || activeStudents.length === 0) {
    return (
      <EmptyState>
        {activeTeachers.length === 0
          ? "Add an active teacher before assigning students."
          : "Add an active student before making an assignment."}
      </EmptyState>
    );
  }

  return (
    <div>
      <form
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] lg:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (!teacherUserId || studentUserIds.length === 0) return;
          void act("assign_teacher_batch", teacherBatchAssignmentPayload(
            organizationId,
            teacherUserId,
            studentUserIds,
          )).then((result) => {
            if (result) {
              setStudentUserIds([]);
              setStudentPickerOpen(false);
            }
          });
        }}
      >
        <label className="min-w-0">
          <span className="mb-1.5 block text-xs font-semibold text-slate-600">Teacher</span>
          <GlassSelect
            label="Teacher"
            placeholder="Choose teacher"
            value={teacherUserId}
            options={activeTeachers.map((teacher) => ({ value: teacher.userId, label: teacher.displayName ?? teacher.email ?? "Teacher" }))}
            onValueChange={(value) => {
              setTeacherUserId(value);
              setStudentUserIds([]);
              setStudentPickerOpen(false);
            }}
          />
        </label>
        <div className="relative min-w-0">
          <span className="mb-1.5 block text-xs font-semibold text-slate-600">Students</span>
          <button
            type="button"
            ref={setStudentButton}
            aria-haspopup="listbox"
            aria-expanded={studentPickerOpen}
            aria-label={selectedStudents.length === 0 ? "Select students" : `${selectedStudents.length} students selected`}
            title={selectedStudents.length > 0 ? selectedStudents.map((student) => student.displayName ?? student.email ?? "Student").join(", ") : undefined}
            className="liquid-glass flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-slate-300 bg-surface/45 px-3 text-left text-sm text-slate-900"
            onClick={() => {
              setStudentPickerOpen((open) => !open);
            }}
          >
            <span className="truncate">{selectedStudents.length === 0 ? "Select students" : `${selectedStudents.length} selected`}</span>
            <Chevron open={studentPickerOpen} />
          </button>
          {studentPickerOpen && (
            <FloatingGlassPopover
              anchor={studentButton}
              ariaLabel="Students"
              multiselectable
              onClose={() => setStudentPickerOpen(false)}
            >
              <div className="flex items-center justify-between gap-2 border-b border-slate-200/70 px-2 py-1.5">
                <button type="button" className="text-[11px] font-semibold text-indigo-700" onClick={() => setStudentUserIds(availableStudents.map((student) => student.userId))}>Select all</button>
                <button type="button" className="text-[11px] font-semibold text-slate-500" onClick={() => setStudentUserIds([])}>Clear</button>
              </div>
              {availableStudents.length === 0 ? (
                <p className="px-2 py-3 text-xs text-slate-500">Every active student is already assigned to this teacher.</p>
              ) : availableStudents.map((student) => {
                const selected = studentUserIds.includes(student.userId);
                return (
                  <button
                    key={student.userId}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`mt-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm ${selected ? "bg-indigo-100/65 text-slate-900" : "text-slate-700 hover:bg-surface/55"}`}
                    onClick={() => setStudentUserIds((current) => selected ? current.filter((id) => id !== student.userId) : [...current, student.userId])}
                  >
                    <span className={`grid h-5 w-5 place-items-center rounded-md border text-[12px] ${selected ? "border-indigo-400 bg-indigo-600 text-white" : "border-slate-300"}`}>{selected ? "✓" : ""}</span>
                    <span className="truncate">{student.displayName ?? student.email ?? "Student"}</span>
                  </button>
                );
              })}
            </FloatingGlassPopover>
          )}
        </div>
        <button
          type="submit"
          className="btn-primary col-span-2 min-h-11 w-full !px-4 lg:col-span-1 lg:w-auto"
          disabled={busy || !teacherUserId || studentUserIds.length === 0}
        >
          {studentUserIds.length > 1 ? `Assign ${studentUserIds.length}` : "Assign"}
        </button>
      </form>

    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className={`app-icon-color size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
      <path d="m5.5 7.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RequestRow({
  request,
  act,
  busy,
  highlighted = false,
  targetRef,
}: {
  request: OrganizationRequest;
  act: Act;
  busy: boolean;
  highlighted?: boolean;
  targetRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const action = request.kind === "leave" ? "decide_leave_request" : request.kind === "history_access_change" ? "decide_access_request" : "decide_join_request";
  const futureHistory = request.kind === "history_access_change" && request.note === "scope:future";
  const requestLabel = futureHistory
    ? "Future work sharing"
    : request.kind === "history_access_change"
      ? "Earlier history sharing"
      : titleCase(request.kind);
  const visibleNote = futureHistory ? null : request.note;
  return (
    <div
      ref={targetRef}
      tabIndex={highlighted ? -1 : undefined}
      data-notification-target={highlighted ? "organization-request" : undefined}
      className={`text-inset-compact scroll-mt-24 rounded-[var(--radius-lg)] border border-slate-200/70 bg-surface/25 py-2.5 outline-none transition-colors ${highlighted ? "!border-indigo-300/75 !bg-indigo-50/55 !px-4 !py-4 ring-2 ring-inset ring-indigo-300/55 sm:!px-5" : ""}`}
    >
      {highlighted && <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-indigo-800">Needs your attention</p>}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span><span className="block text-sm font-semibold text-slate-900">{request.requesterName ?? request.requesterEmail ?? "Member"}</span><span className="block text-xs text-slate-500">{requestLabel} · {formatDate(request.createdAt)}</span></span>
        <StatusPill tone="warn">Pending</StatusPill>
      </div>
      {visibleNote && <p className="mt-1.5 line-clamp-1 text-[11px] leading-4 text-slate-600">{visibleNote}</p>}
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:flex">
        <button type="button" aria-label={`Approve ${requestLabel.toLowerCase()} request from ${request.requesterName ?? request.requesterEmail ?? "member"}`} className="btn-primary min-h-11 w-full !px-3 !py-1.5 text-xs sm:w-auto" disabled={busy} onClick={() => void act(action, { requestId: request.id, approve: true })}>Approve</button>
        <button type="button" aria-label={`Reject ${requestLabel.toLowerCase()} request from ${request.requesterName ?? request.requesterEmail ?? "member"}`} className="btn-secondary min-h-11 w-full !px-3 !py-1.5 text-xs sm:w-auto" disabled={busy} onClick={() => void act(action, { requestId: request.id, approve: false })}>Reject</button>
      </div>
    </div>
  );
}

function OrganizationDeletionControl({
  organizationId,
  organizationName,
  act,
  busy,
  compact = false,
}: {
  organizationId: string;
  organizationName: string;
  act: Act;
  busy: boolean;
  compact?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmationName, setConfirmationName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const confirmationId = `delete-organisation-${organizationId}`;
  const copyId = `${confirmationId}-consequences`;
  const nameMatches = confirmationName === organizationName;

  const cancel = () => {
    setConfirming(false);
    setConfirmationName("");
  };

  const remove = async () => {
    if (!nameMatches || busy || submitting) return;
    setSubmitting(true);
    try {
      const result = await act(
        "delete_organization",
        organizationDeletionPayload(organizationId, confirmationName),
      );
      if (result) cancel();
    } finally {
      setSubmitting(false);
    }
  };

  if (compact && !confirming) {
    return (
      <div className="mt-2 flex justify-end" data-organization-deletion-control>
        <button
          type="button"
          className="btn-secondary !min-h-8 !rounded-[var(--radius-lg)] !border-rose-200 !px-2.5 !py-1 text-[11px] font-semibold !text-rose-800"
          aria-label={`Delete ${organizationName} organisation`}
          aria-expanded="false"
          disabled={busy || submitting}
          onClick={() => setConfirming(true)}
        >
          Delete organisation
        </button>
      </div>
    );
  }

  return (
    <section
      className={`${compact ? "mt-3 px-3 py-2.5" : "mt-3 px-3.5 py-3"} rounded-[var(--radius-lg)] border border-rose-200/90 bg-rose-50/55`}
      data-organization-deletion-control
      aria-labelledby={`${confirmationId}-title`}
    >
      <div data-organization-deletion-summary>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <strong
            id={`${confirmationId}-title`}
            className="min-w-0 whitespace-nowrap text-sm font-semibold text-rose-900"
          >
            Delete organisation
          </strong>
          {!confirming && (
            <button
              type="button"
              className="grid size-11 shrink-0 place-items-center rounded-full border border-rose-300 bg-rose-50 text-[1.35rem] font-light leading-none text-rose-900 transition-colors hover:bg-rose-100 disabled:opacity-50"
              aria-label={`Delete ${organizationName} organisation`}
              aria-expanded="false"
              aria-controls={`${confirmationId}-confirmation`}
              disabled={busy || submitting}
              onClick={() => setConfirming(true)}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>
        <p id={copyId} className="mt-1.5 w-full text-[11px] leading-4 text-rose-800">
          Permanently removes this workspace, its memberships, requests, assignments and shared organisation records. Learners keep their own practice history. This cannot be undone.
        </p>
      </div>
      {confirming && (
        <div id={`${confirmationId}-confirmation`} className="mt-3 grid gap-2.5" role="group" aria-describedby={copyId}>
          <label htmlFor={confirmationId} className="text-xs font-medium leading-5 text-rose-900">
            Type <strong>{organizationName}</strong> exactly to confirm
          </label>
          <input
            id={confirmationId}
            className="input !min-h-10 !border-rose-300 bg-surface/85 text-sm"
            value={confirmationName}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy || submitting}
            aria-describedby={copyId}
            onChange={(event) => setConfirmationName(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn border border-rose-400 bg-rose-600 !min-h-9 !rounded-[var(--radius-lg)] !px-3 !py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              disabled={busy || submitting || !nameMatches}
              onClick={() => void remove()}
            >
              {submitting ? <LoadingIndicator label="Deleting…" announce={false} /> : "Delete permanently"}
            </button>
            <button
              type="button"
              className="btn-secondary !min-h-9 !rounded-[var(--radius-lg)] !px-3 !py-1.5 text-xs"
              disabled={busy || submitting}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PlatformAdminCard({
  portal,
  onOpen,
}: {
  portal: Portal;
  onOpen: () => void;
}) {
  const organizations = portal.organizations ?? [];
  return (
    <button
      type="button"
      className="card group flex min-h-[4.75rem] w-full min-w-0 items-center gap-3 text-left !rounded-[var(--radius-xl)] !px-3.5 !py-3 sm:!px-4"
      aria-label="Open BandUp administration"
      data-platform-admin-card
      onClick={onOpen}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-lg)] border border-slate-200/75 bg-surface/50 text-indigo-700 shadow-sm">
        <CardIcon name="gear" size={21} className="text-current" />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-[15px] font-semibold tracking-tight text-slate-900 sm:text-base">BandUp administration</strong>
        <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 sm:text-xs">
          Manage every organisation workspace.
        </span>
      </span>
      <span className="hidden shrink-0 text-right sm:block">
        <span className="block text-[10px] text-slate-500">
          {organizations.length} organisation{organizations.length === 1 ? "" : "s"}
        </span>
      </span>
      <span aria-hidden="true" className="shrink-0 text-xl leading-none text-slate-400 transition-transform group-hover:translate-x-0.5">›</span>
    </button>
  );
}

function PlatformAdminArea({
  portal,
  act,
  busy,
  onBack,
}: {
  portal: Portal;
  act: Act;
  busy: boolean;
  onBack: () => void;
}) {
  const organizations = portal.organizations ?? [];
  return (
    <section className="min-w-0 space-y-2" aria-labelledby="bandup-administration-title" data-platform-administration-page>
      <div className="flex min-w-0 items-start gap-2 px-0.5">
        <MobileDashboardBack onBack={onBack} ariaLabel="Back to organisation overview" />
        <div className="min-w-0">
          <h2 id="bandup-administration-title" className="text-[19px] font-semibold tracking-tight text-slate-900 sm:text-[22px]">BandUp administration</h2>
          <p className="mt-0.5 text-xs leading-4 text-slate-600 sm:text-[13px]">Platform-level workspace controls.</p>
        </div>
      </div>
      <div className="grid min-w-0 gap-2.5">
        <GlassSection title="All organisations" lead="Platform-level status controls.">
          {organizations.length === 0 ? <EmptyState>No organisations have been created.</EmptyState> : (
            <div className="space-y-2.5">{organizations.map((organization) => (
              <div key={organization.id} className="rounded-xl border border-slate-200/70 bg-surface/25 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3"><span><span className="block text-sm font-semibold text-slate-900">{organization.name}</span><span className="block text-xs text-slate-500">{organization.studentCount ?? 0} students · {organization.memberCount ?? 0} members</span></span><StatusPill tone={organization.status === "active" ? "good" : "warn"}>{titleCase(organization.status)}</StatusPill></div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    href={`/organization?organization=${encodeURIComponent(organization.id)}`}
                    className="btn-primary inline-flex !px-3 !py-2 text-xs"
                  >
                    Open workspace
                  </Link>
                  {organization.status !== "closed" && (
                    <button
                      type="button"
                      disabled={busy}
                      className="btn-secondary !px-3 !py-2 text-xs"
                      onClick={() => void act(
                        organization.status === "suspended" ? "restore_organization" : "suspend_organization",
                        organizationActionPayload(organization.id),
                      )}
                    >
                      {organization.status === "suspended" ? "Restore organisation" : "Suspend organisation"}
                    </button>
                  )}
                </div>
                <OrganizationDeletionControl
                  organizationId={organization.id}
                  organizationName={organization.name}
                  act={act}
                  busy={busy}
                  compact
                />
              </div>
            ))}</div>
          )}
        </GlassSection>
      </div>
    </section>
  );
}

