"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { accountIdentityComplete } from "@/lib/auth/account-identity";
import { fetchNotifications, previewNotificationReadStorageKey } from "@/lib/notifications/client";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/lib/notifications/types";
import type { OrganizationLivePreviewRole } from "@/lib/organizations/preview-client";
import RefractiveGlassLayer from "@/components/RefractiveGlassLayer";
import { useAccountProfile } from "./AccountProfileProvider";

const NotificationPopover = dynamic(
  () => import("./NotificationInbox").then((module) => module.NotificationPopover),
  { ssr: false },
);

export default function NotificationBell({ previewRole = null }: { previewRole?: OrganizationLivePreviewRole | null }) {
  const { phase, profile } = useAccountProfile();
  const [open, setOpen] = useState(false);
  const [notificationUnread, setNotificationUnread] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const signedIn = previewRole !== null || phase === "loading" || phase === "ready" || phase === "unavailable";
  const needsSetup = phase === "ready" && !accountIdentityComplete(profile);
  const accountKey = previewRole ?? profile?.email ?? phase;
  const displayedNotificationUnread = phase === "loading" && previewRole === null ? 0 : notificationUnread;
  const unread = displayedNotificationUnread + (needsSetup ? 1 : 0);

  useEffect(() => {
    if (!signedIn) return;
    let request: AbortController | null = null;
    let timer: number | null = null;
    const clearTimer = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const refresh = () => {
      if (document.hidden) return;
      request?.abort();
      request = new AbortController();
      // The real account needs only the count. The small read-only preview feed
      // is fetched in full so browser-local read markers can be reconciled
      // exactly after a reload instead of mutating shared synthetic data.
      fetchNotifications(previewRole ? 50 : 1, { previewRole, signal: request.signal })
        .then((result) => setNotificationUnread(result.unreadCount))
        .catch(() => undefined);
    };
    const schedule = () => {
      clearTimer();
      if (!document.hidden) timer = window.setInterval(refresh, 60_000);
    };
    const onVisibility = () => {
      if (document.hidden) clearTimer();
      else {
        refresh();
        schedule();
      }
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    const onStorage = (event: StorageEvent) => {
      if (previewRole && event.key === previewNotificationReadStorageKey(previewRole)) refresh();
    };
    window.addEventListener("storage", onStorage);
    schedule();
    return () => {
      request?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
      clearTimer();
    };
  }, [accountKey, previewRole, signedIn]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = root.current;
    if (!anchor) return;

    /*
      The bell is followed by the account and theme controls, so right-aligning
      a phone-width popover to the bell can push most of it past the left edge
      of a narrow screen. Publish viewport-relative geometry on the existing
      anchor instead: the popover stays in this DOM subtree (so outside-click
      and focus behaviour are unchanged), while the mobile CSS can give it
      equal gutters on both sides of the visible viewport.
    */
    const positionPopover = () => {
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportWidth = viewport?.width ?? document.documentElement.clientWidth;
      const anchorRect = anchor.getBoundingClientRect();

      anchor.style.setProperty(
        "--notification-mobile-left",
        `${viewportLeft - anchorRect.left}px`,
      );
      anchor.style.setProperty(
        "--notification-mobile-width",
        `${Math.max(0, viewportWidth)}px`,
      );
    };

    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.visualViewport?.addEventListener("resize", positionPopover);
    window.visualViewport?.addEventListener("scroll", positionPopover);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.visualViewport?.removeEventListener("resize", positionPopover);
      window.visualViewport?.removeEventListener("scroll", positionPopover);
      anchor.style.removeProperty("--notification-mobile-left");
      anchor.style.removeProperty("--notification-mobile-width");
    };
  }, [open]);

  if (!signedIn) return null;
  return (
    <div ref={root} data-notification-bell-root className="relative isolate">
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        data-pointer-attract
        data-pointer-attract-strength="icon"
        className="pointer-attract-glass premade-glass app-icon-control relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border transition-colors"
      >
        <RefractiveGlassLayer radius={999} interactive />
        <svg className="app-icon-color relative z-10" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6.8 9.8a5.2 5.2 0 0 1 10.4 0c0 5.1 2.1 5.2 2.1 6.5H4.7c0-1.3 2.1-1.4 2.1-6.5Z" />
          <path d="M9.8 19a2.5 2.5 0 0 0 4.4 0" />
        </svg>
      </button>
      {unread > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0.5 top-0.5 z-[1200] h-2.5 w-2.5 rounded-full border-2 border-[var(--color-background)] bg-indigo-500"
        />
      )}
      {open && <span className="notification-glass-backdrop" aria-hidden="true" />}
      {open && <NotificationPopover previewRole={previewRole} needsSetup={needsSetup} onClose={() => setOpen(false)} onUnreadCount={setNotificationUnread} />}
    </div>
  );
}
