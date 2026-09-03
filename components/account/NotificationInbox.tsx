"use client";

import Link from "next/link";
import SignInLink from "@/components/account/SignInLink";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { accountIdentityComplete, accountUsernameReady } from "@/lib/auth/account-identity";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationActionDestination,
  notificationCopy,
  previewNotificationReadStorageKey,
  rememberPreviewNotificationRead,
} from "@/lib/notifications/client";
import { NOTIFICATIONS_CHANGED_EVENT, type AccountNotification } from "@/lib/notifications/types";
import type { OrganizationLivePreviewRole } from "@/lib/organizations/preview-client";
import LoadingIndicator from "@/components/LoadingIndicator";
import { useSegmentedDrag } from "@/lib/segmented-drag";
import { useAccountProfile } from "./AccountProfileProvider";

interface FeedState {
  notifications: AccountNotification[];
  unreadCount: number;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

const EMPTY_FEED: FeedState = {
  notifications: [],
  unreadCount: 0,
  nextCursor: null,
  loading: true,
  loadingMore: false,
  error: null,
};

function withNotificationRead(
  current: FeedState,
  notificationId: string,
  readAt: string,
  unreadCount = Math.max(0, current.unreadCount - 1),
): FeedState {
  return {
    ...current,
    unreadCount,
    notifications: current.notifications.map((entry) => entry.id === notificationId
      ? { ...entry, readAt }
      : entry),
  };
}

function rollbackNotificationRead(
  current: FeedState,
  item: AccountNotification,
  optimisticReadAt: string,
): FeedState {
  const shouldRollback = current.notifications.some((entry) => (
    entry.id === item.id && entry.readAt === optimisticReadAt
  ));
  if (!shouldRollback) return current;
  return {
    ...current,
    unreadCount: current.unreadCount + 1,
    notifications: current.notifications.map((entry) => entry.id === item.id
      ? { ...entry, readAt: item.readAt }
      : entry),
  };
}

function useNotificationFeed({
  enabled,
  limit,
  previewRole,
}: {
  enabled: boolean;
  limit: number;
  previewRole?: OrganizationLivePreviewRole | null;
}) {
  const [feed, setFeed] = useState<FeedState>(EMPTY_FEED);
  const abort = useRef<AbortController | null>(null);
  const cursor = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) {
      setFeed({ ...EMPTY_FEED, loading: false });
      return;
    }
    abort.current?.abort();
    const request = new AbortController();
    abort.current = request;
    try {
      const result = await fetchNotifications(limit, { previewRole, signal: request.signal });
      if (!request.signal.aborted) {
        cursor.current = result.nextCursor;
        setFeed({ ...result, loading: false, loadingMore: false, error: null });
      }
    } catch (error) {
      if (request.signal.aborted) return;
      setFeed((current) => ({
        ...current,
        loading: false,
        loadingMore: false,
        error: error instanceof Error ? error.message : "Notifications are unavailable right now.",
      }));
    }
  }, [enabled, limit, previewRole]);

  useEffect(() => {
    void load();
    if (!enabled) return;
    let timer: number | null = null;
    const clearTimer = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const schedule = () => {
      clearTimer();
      if (!document.hidden) timer = window.setInterval(() => void load(), 60_000);
    };
    const refresh = () => {
      if (!document.hidden) void load();
    };
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.hidden) clearTimer();
      else {
        refresh();
        schedule();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    const onStorage = (event: StorageEvent) => {
      if (previewRole && event.key === previewNotificationReadStorageKey(previewRole)) refresh();
    };
    window.addEventListener("storage", onStorage);
    schedule();
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
      clearTimer();
      abort.current?.abort();
    };
  }, [enabled, load, previewRole]);

  const loadMore = useCallback(async () => {
    const nextCursor = cursor.current;
    if (!enabled || !nextCursor) return;
    setFeed((current) => ({ ...current, loadingMore: true, error: null }));
    try {
      const result = await fetchNotifications(limit, { previewRole, cursor: nextCursor });
      cursor.current = result.nextCursor;
      setFeed((current) => {
        const known = new Set(current.notifications.map((item) => item.id));
        return {
          ...current,
          notifications: [...current.notifications, ...result.notifications.filter((item) => !known.has(item.id))],
          unreadCount: result.unreadCount,
          nextCursor: result.nextCursor,
          loadingMore: false,
          error: null,
        };
      });
    } catch (error) {
      setFeed((current) => ({
        ...current,
        loadingMore: false,
        error: error instanceof Error ? error.message : "More notifications could not be loaded.",
      }));
    }
  }, [enabled, limit, previewRole]);

  return { feed, setFeed, reload: load, loadMore };
}

function friendlyDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Recently";
  const elapsed = Date.now() - date.getTime();
  if (elapsed >= 0 && elapsed < 60_000) return "Just now";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))}m ago`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function NotificationIcon({ item }: { item: AccountNotification }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 24,
    height: 24,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "app-icon-color",
    "aria-hidden": true,
  };
  if (item.type === "teacher_feedback") {
    return <svg {...common}><path d="M5 5.5h14v10H9l-4 3v-13Z" /><path d="m9 10 1.7 1.7L15 7.8" /></svg>;
  }
  if (item.type === "assignment_completed") {
    return <svg {...common}><path d="M7 4h10v16H7z" /><path d="m9.5 12 1.7 1.7 3.8-4" /></svg>;
  }
  if (item.type === "organization_invitation") {
    return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M17 8v6m-3-3h6" /></svg>;
  }
  if (item.type === "organization_request") {
    return <svg {...common}><path d="M12 3a9 9 0 1 0 8.2 5.3" /><path d="M17 3h4v4M21 3l-5 5" /><path d="M12 7v5l3 2" /></svg>;
  }
  return <svg {...common}><path d="M7 4h10v16H7z" /><path d="M9.5 8h5M9.5 12h5M9.5 16H13" /></svg>;
}

function NotificationRow({
  item,
  compact = false,
  busy,
  onOpen,
  previewRole,
}: {
  item: AccountNotification;
  compact?: boolean;
  busy: boolean;
  onOpen: (item: AccountNotification, navigating: boolean) => void;
  previewRole?: OrganizationLivePreviewRole | null;
}) {
  const copy = notificationCopy(item);
  const destination = notificationActionDestination(item.actionPath, previewRole);
  const className = `group relative flex w-full items-start gap-2.5 rounded-[var(--radius-lg)] border text-left transition-colors sm:gap-3 ${destination ? "cursor-pointer hover:bg-surface/75" : item.readAt ? "cursor-default" : "hover:bg-surface/75 disabled:cursor-wait"} ${compact ? "p-2.5" : "p-3 sm:p-3.5"} ${item.readAt ? "border-slate-200/55 bg-surface/25" : "border-indigo-200/70 bg-indigo-50/35"}`;
  const content = <>
      <span className={`flex shrink-0 items-center justify-center rounded-full text-indigo-700 ${compact ? "h-9 w-9" : "h-10 w-10 sm:h-11 sm:w-11"}`}>
        <NotificationIcon item={item} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold leading-5 text-slate-900">{copy.title}</span>
          {!item.readAt && <span className="notification-unread-dot mt-1.5 h-2 w-2 shrink-0 rounded-full" aria-label="Unread" />}
        </span>
        <span className={`notification-row-copy mt-0.5 block text-slate-600 ${compact ? "line-clamp-2 text-xs leading-4" : "text-sm leading-5"}`}>{copy.body}</span>
        <span className="notification-row-meta mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-slate-500">
          <time dateTime={item.createdAt}>{friendlyDate(item.createdAt)}</time>
          {item.assignment?.dueAt && item.type === "practice_assigned" && (
            <><span aria-hidden="true">·</span><span>Due {friendlyDate(item.assignment.dueAt)}</span></>
          )}
          <span aria-hidden="true">·</span>
          {destination ? (
            <>
              <span className="notification-attention rounded-full bg-indigo-100/75 px-1.5 py-0.5 font-semibold text-indigo-800">{copy.attentionLabel}</span>
              <span className="notification-action ml-auto inline-flex items-center gap-0.5 font-semibold text-indigo-800">
                {copy.actionLabel}
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" /></svg>
              </span>
            </>
          ) : (
            <>
              <span className="font-medium text-slate-500">Information only</span>
              {!item.readAt && <span className="ml-auto font-semibold text-slate-600">Mark as read</span>}
            </>
          )}
        </span>
      </span>
    </>;

  if (destination) return (
    <a
      href={destination}
      onClick={() => onOpen(item, true)}
      aria-label={`${copy.title}. ${copy.actionLabel}`}
      data-notification-native-navigation
      className={className}
    >
      {content}
    </a>
  );
  if (item.readAt) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onOpen(item, false)}
      aria-label={`Mark ${copy.title} as read`}
      className={className}
    >
      {content}
      {busy && <LoadingIndicator label="Marking as read…" className="absolute bottom-3 right-3 text-xs text-indigo-700" textClassName="sr-only" />}
    </button>
  );
}

function ProfileReminder({ compact = false, onOpen }: { compact?: boolean; onOpen?: () => void }) {
  const { profile } = useAccountProfile();
  const hasUsername = accountUsernameReady(profile);
  return (
    <Link
      href="/account/onboarding"
      onClick={onOpen}
      className={`block rounded-[var(--radius-lg)] border border-indigo-200/70 bg-indigo-50/35 transition-colors hover:bg-indigo-50/60 ${compact ? "p-2.5" : "p-4"}`}
    >
      <span className="flex items-start justify-between gap-3">
        <span>
          <span className="block text-sm font-semibold text-slate-900">Finish setting up your account</span>
          <span className={`mt-1 block text-slate-600 ${compact ? "text-xs leading-4" : "text-sm leading-5"}`}>
            {hasUsername
              ? "Add your display name. Your username is already safe."
              : "Choose a username, or let BandUp generate one for you."}
          </span>
        </span>
        <span className="notification-unread-dot mt-1 h-2 w-2 shrink-0 rounded-full" aria-label="Unread" />
      </span>
    </Link>
  );
}

type NotificationView = "all" | "unread";

function NotificationFilter({
  value,
  unreadCount,
  onChange,
}: {
  value: NotificationView;
  unreadCount: number;
  onChange: (value: NotificationView) => void;
}) {
  const options: Array<{ id: NotificationView; label: string }> = [
    { id: "all", label: "All" },
    { id: "unread", label: unreadCount > 0 ? `Unread (${unreadCount})` : "Unread" },
  ];
  const selectedIndex = value === "unread" ? 1 : 0;
  /* Shared with the theme control and the organisation sections — see
     lib/segmented-drag.ts. A tap commits in the option's own click just
     below; a drag ends over an option that never sees a click, so it commits
     through onCommit instead. Exactly one of the two fires per gesture. */
  const drag = useSegmentedDrag({
    count: options.length,
    selectedIndex,
    onCommit: (index) => onChange(options[index].id),
  });
  const { previewIndex } = drag;
  const visibleIndex = previewIndex ?? selectedIndex;

  return (
    /* touch-none is what the drag costs: a finger sliding across this bar
       carries the knob rather than scrolling the popover behind it. The bar
       is two stops wide and sits at the top of a scrolling list, so this is
       the one of the three where the trade is felt — a thumb that starts on
       the filter cannot flick the notifications underneath. */
    <div
      role="tablist"
      aria-label="Notification filter"
      data-flowing={previewIndex !== null ? "" : undefined}
      data-pressed={drag.pressed ? "" : undefined}
      data-settling={drag.settling ? "" : undefined}
      className="notification-filter-base premade-glass relative grid min-w-0 touch-none grid-cols-2 items-center overflow-hidden rounded-full p-1"
      style={
        {
          "--notification-filter-index": drag.position,
          "--segmented-squash": drag.squash,
        } as CSSProperties
      }
      {...drag.handlers}
    >
      <span className="notification-filter-selector segmented-knob" aria-hidden="true" />
      {options.map((option, index) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onPointerEnter={() => drag.preview(index)}
          onFocus={() => drag.preview(index)}
          onBlur={() => drag.preview(null)}
          onClick={() => {
            onChange(option.id);
            drag.preview(null);
          }}
          className={`notification-filter-option segmented-option relative z-10 min-w-0 rounded-full px-3 text-xs font-semibold transition-colors ${visibleIndex === index ? "text-slate-900" : "text-slate-600 hover:text-slate-900"}`}
        >
          <span className="truncate">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function NotificationPopover({
  previewRole = null,
  needsSetup,
  onClose,
  onUnreadCount,
}: {
  previewRole?: OrganizationLivePreviewRole | null;
  needsSetup: boolean;
  onClose: () => void;
  onUnreadCount?: (count: number) => void;
}) {
  const { feed, setFeed, reload } = useNotificationFeed({ enabled: true, limit: 5, previewRole });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => onUnreadCount?.(feed.unreadCount), [feed.unreadCount, onUnreadCount]);

  function openItem(item: AccountNotification, navigating: boolean) {
    setActionError(null);
    if (navigating) onClose();
    else setBusy(item.id);
    if (!item.readAt) {
      const readAt = new Date().toISOString();
      setFeed((current) => withNotificationRead(current, item.id, readAt));
      if (previewRole) {
        rememberPreviewNotificationRead(item, previewRole, readAt);
      } else {
        void markNotificationRead(item.id)
          .then((result) => setFeed((current) => ({ ...current, unreadCount: result.unreadCount })))
          .catch((error: unknown) => {
            // Reading state is best-effort and must never hold up an action
            // link. A native anchor is already leaving this view, so there is
            // no useful UI to roll back or error banner to show here.
            if (!navigating) {
              setFeed((current) => rollbackNotificationRead(current, item, readAt));
              setActionError(error instanceof Error ? error.message : "The notification could not be updated.");
            }
          })
          .finally(() => setBusy((current) => current === item.id ? null : current));
      }
    }
    if (item.readAt || previewRole) setBusy(null);
  }

  async function markAll() {
    setBusy("all");
    setActionError(null);
    try {
      const result = await markAllNotificationsRead(previewRole);
      const readAt = new Date().toISOString();
      setFeed((current) => ({ ...current, unreadCount: result.unreadCount, notifications: current.notifications.map((item) => ({ ...item, readAt: item.readAt ?? readAt })) }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Notifications could not be updated.");
    } finally {
      setBusy(null);
    }
  }

  const hasItems = needsSetup || feed.notifications.length > 0;
  return (
    <div role="dialog" aria-label="Notifications" className="notification-popover liquid-glass absolute right-0 top-12 z-[1100] w-[min(24rem,calc(100vw-1rem))] rounded-[var(--radius-xl)] border p-3">
      <div className="flex items-center justify-between gap-3 px-1 pb-2">
        <h2 className="text-sm font-semibold text-slate-900">Notifications</h2>
        <div className="flex items-center gap-2">
          {feed.unreadCount > 0 && !previewRole && (
            <button type="button" disabled={busy !== null} onClick={() => void markAll()} className="text-[0.6875rem] font-medium text-indigo-800 hover:underline disabled:opacity-50">{busy === "all" ? <LoadingIndicator label="Marking all read…" announce={false} /> : "Mark all read"}</button>
          )}
          {(feed.unreadCount + (needsSetup ? 1 : 0)) > 0 && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[0.625rem] font-semibold text-indigo-800">{feed.unreadCount + (needsSetup ? 1 : 0)} new</span>}
        </div>
      </div>
      <div className="max-h-[min(28rem,calc(100dvh-8rem))] space-y-2 overflow-y-auto overscroll-contain pr-0.5">
        {needsSetup && <ProfileReminder compact onOpen={onClose} />}
        {feed.notifications.map((item) => <NotificationRow key={item.id} item={item} compact busy={busy === item.id} previewRole={previewRole} onOpen={openItem} />)}
        {feed.loading && feed.notifications.length === 0 && <p className="rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/30 p-3 text-sm text-slate-500"><LoadingIndicator label="Checking for notifications…" /></p>}
        {!feed.loading && !hasItems && !feed.error && <p className="rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/30 p-3 text-sm text-slate-600">You&rsquo;re all caught up.</p>}
      </div>
      {(actionError || feed.error) && (
        <div role="alert" className="mt-2 flex items-start justify-between gap-2 rounded-[var(--radius-lg)] bg-rose-50/70 px-3 py-2 text-xs text-rose-800">
          <span>{actionError || feed.error}</span>
          {feed.error && <button type="button" onClick={() => void reload()} className="shrink-0 font-semibold underline">Retry</button>}
        </div>
      )}
      <Link href={previewRole ? `/notifications?preview=${previewRole}` : "/notifications"} onClick={onClose} className="notification-compact-action mt-2 flex items-center justify-center rounded-full border border-slate-200/70 bg-surface/45 px-4 text-center text-xs font-semibold text-slate-800 transition-colors hover:bg-surface/80">View all notifications</Link>
    </div>
  );
}

export default function NotificationInbox({ previewRole = null }: { previewRole?: OrganizationLivePreviewRole | null }) {
  const { phase, profile } = useAccountProfile();
  const enabled = phase !== "signed-out" || previewRole !== null;
  const needsSetup = phase === "ready" && !accountIdentityComplete(profile);
  const { feed, setFeed, reload, loadMore } = useNotificationFeed({ enabled, limit: 50, previewRole });
  const [view, setView] = useState<NotificationView>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function openItem(item: AccountNotification, navigating: boolean) {
    setActionError(null);
    if (!navigating) setBusy(item.id);
    if (!item.readAt) {
      const readAt = new Date().toISOString();
      setFeed((current) => withNotificationRead(current, item.id, readAt));
      if (previewRole) {
        rememberPreviewNotificationRead(item, previewRole, readAt);
      } else {
        void markNotificationRead(item.id)
          .then((result) => setFeed((current) => ({ ...current, unreadCount: result.unreadCount })))
          .catch((error: unknown) => {
            if (!navigating) {
              setFeed((current) => rollbackNotificationRead(current, item, readAt));
              setActionError(error instanceof Error ? error.message : "The notification could not be updated.");
            }
          })
          .finally(() => setBusy((current) => current === item.id ? null : current));
      }
    }
    if (item.readAt || previewRole) setBusy(null);
  }

  async function markAll() {
    setBusy("all");
    setActionError(null);
    try {
      const result = await markAllNotificationsRead(previewRole);
      const readAt = new Date().toISOString();
      setFeed((current) => ({ ...current, unreadCount: result.unreadCount, notifications: current.notifications.map((item) => ({ ...item, readAt: item.readAt ?? readAt })) }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Notifications could not be updated.");
    } finally {
      setBusy(null);
    }
  }

  if (!enabled) {
    return (
      <section className="card mx-auto max-w-2xl text-center">
        <h2 className="text-lg font-semibold text-slate-900">Sign in to see notifications</h2>
        <SignInLink className="mt-5 inline-flex rounded-full border bg-surface/60 px-5 py-2.5 text-sm font-semibold text-slate-900">Open your account</SignInLink>
      </section>
    );
  }

  const shown = view === "unread" ? feed.notifications.filter((item) => !item.readAt) : feed.notifications;
  const totalUnread = feed.unreadCount + (needsSetup ? 1 : 0);
  return (
    <section className="card mx-auto max-w-5xl p-2 sm:p-4">
      <div className="mb-2.5 flex items-center justify-between gap-2 sm:mb-3">
        <NotificationFilter value={view} unreadCount={totalUnread} onChange={setView} />
        {feed.unreadCount > 0 && !previewRole && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void markAll()}
            className="notification-compact-action shrink-0 rounded-full border bg-surface/55 px-3 text-[0.6875rem] font-semibold text-slate-800 transition-colors hover:bg-surface/85 disabled:opacity-50 sm:px-3.5"
          >
            {busy === "all" ? <LoadingIndicator label="Marking all read…" announce={false} textClassName="sr-only" /> : "Mark all read"}
          </button>
        )}
      </div>

      <div className="space-y-2.5">
        {needsSetup && <ProfileReminder />}
        {shown.map((item) => <NotificationRow key={item.id} item={item} busy={busy === item.id} previewRole={previewRole} onOpen={openItem} />)}
        {feed.loading && feed.notifications.length === 0 && <p className="rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/30 p-5 text-center text-sm text-slate-500"><LoadingIndicator label="Checking for notifications…" /></p>}
        {!feed.loading && shown.length === 0 && !needsSetup && !feed.error && (
          <div className="rounded-[var(--radius-lg)] border border-slate-200/60 bg-surface/30 p-5 text-center">
            <p className="font-semibold text-slate-900">{view === "unread" ? "Nothing unread" : "You’re all caught up"}</p>
          </div>
        )}
        {view === "all" && feed.nextCursor && (
          <button type="button" disabled={feed.loadingMore} onClick={() => void loadMore()} className="notification-compact-action w-full rounded-full border bg-surface/45 px-4 text-sm font-semibold text-slate-800 transition-colors hover:bg-surface/75 disabled:cursor-wait disabled:opacity-60">
            {feed.loadingMore ? <LoadingIndicator label="Loading more…" announce={false} /> : "Load earlier notifications"}
          </button>
        )}
      </div>

      {(actionError || feed.error) && (
        <div role="alert" className="mt-3 flex items-start justify-between gap-3 rounded-[var(--radius-lg)] bg-rose-50/70 px-4 py-3 text-sm text-rose-800">
          <span>{actionError || feed.error}</span>
          {feed.error && <button type="button" onClick={() => void reload()} className="shrink-0 font-semibold underline">Retry</button>}
        </div>
      )}
    </section>
  );
}
