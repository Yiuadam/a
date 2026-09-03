"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountIdentityComplete } from "@/lib/auth/account-identity";
import { fetchNotifications, previewNotificationReadStorageKey } from "@/lib/notifications/client";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/lib/notifications/types";
import type { OrganizationLivePreviewRole } from "@/lib/organizations/preview-client";
import { useAccountProfile } from "./AccountProfileProvider";

const NotificationPopover = dynamic(
  () => import("./NotificationInbox").then((module) => module.NotificationPopover),
  { ssr: false },
);

export default function NotificationBell({
  previewRole = null,
  signedOut = false,
}: {
  previewRole?: OrganizationLivePreviewRole | null;
  /*
    The header draws this bell for everybody now, including a visitor with no
    account (see HeaderNotificationBell). There is nothing to fetch for them and
    nothing to count, so this says so explicitly rather than being inferred from
    a `phase` that also covers "still loading" — which would have shown an empty
    panel for a moment to somebody who was about to have a full one.
  */
  signedOut?: boolean;
}) {
  const { phase, profile } = useAccountProfile();
  const [open, setOpen] = useState(false);
  const [notificationUnread, setNotificationUnread] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const signedIn =
    !signedOut &&
    (previewRole !== null || phase === "loading" || phase === "ready" || phase === "unavailable");
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

  /*
    Closing the panel, and putting the focus ring back somewhere that exists.

    Both routes end here. A tap outside dismisses through the document
    listener below; a second tap on the bell dismisses through the button's
    own toggle, and the listener deliberately stays out of its way — see the
    early return on the wrapper. Getting that wrong is the classic version of
    this bug: the outside handler closes on pointerdown, the button's click
    arrives a moment later and toggles it straight back open, and the panel
    looks like it will not close at all.

    Focus matters because the panel is a portal. Anything focused inside it is
    on a node that is about to be removed from the document, and focus left on
    a detached node falls to <body> — the next Tab starts from the top of the
    page rather than from the control the reader was using. Handing it back to
    the bell is also what completes the keyboard round-trip: open, Escape, and
    the ring is back on the button that opened it.
  */
  const dismiss = () => {
    const active = document.activeElement;
    if (active instanceof Element && active.closest(".notification-popover")) {
      root.current?.querySelector("button")?.focus();
    }
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      /*
        The bell itself is not an outside click. Its own onClick is what
        toggles the panel shut, and closing here as well would leave that
        toggle re-opening what this just closed.
      */
      if (root.current?.contains(target)) return;
      /*
        The panel is no longer a descendant of this wrapper — it is rendered
        into document.body (see the portal below) — so `root.contains` alone
        would treat every click inside the inbox as a click outside it and
        shut the panel the instant anyone tried to use it. Asking the target
        whether it is inside a `.notification-popover` says the same thing the
        DOM containment used to say, and needs no ref threaded through the
        lazily-imported panel component to say it.

        This is also what keeps the filter bar's drag safe. That control
        carries the knob under the finger and a gesture can easily finish
        outside the panel — but only `pointerdown` is listened for here, and a
        drag's pointerdown is on the bar, so the gesture is over before this
        handler could ever see it.
      */
      if (target instanceof Element && target.closest(".notification-popover")) return;
      dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
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
      The panel used to hang off this wrapper with `position: absolute`, which
      is why it only ever needed a mobile nudge published here. It is fixed to
      the viewport from document.body now, so it needs the bell's own position
      in viewport coordinates instead — the anchor's bottom edge and how far
      its right edge sits from the right of the screen. `position: fixed`
      resolves against the layout viewport and getBoundingClientRect reports
      in the same coordinates, so the two agree without any correction.

      Published on the document element rather than on this wrapper, because
      the element that reads them is no longer inside it and a custom property
      only travels down.
    */
    const positionPopover = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const style = document.documentElement.style;
      style.setProperty("--notification-anchor-bottom", `${anchorRect.bottom}px`);
      style.setProperty(
        "--notification-anchor-right",
        `${Math.max(0, document.documentElement.clientWidth - anchorRect.right)}px`,
      );
    };

    positionPopover();
    /*
      Scroll matters now in a way it did not before. The header is sticky, so
      the bell only moves while iOS is collapsing or expanding its toolbar —
      but during that the anchor really does travel, and a panel fixed to a
      stale measurement would visibly detach from the button it grew out of.
    */
    window.addEventListener("scroll", positionPopover, { passive: true });
    window.addEventListener("resize", positionPopover);
    window.visualViewport?.addEventListener("resize", positionPopover);
    window.visualViewport?.addEventListener("scroll", positionPopover);
    return () => {
      window.removeEventListener("scroll", positionPopover);
      window.removeEventListener("resize", positionPopover);
      window.visualViewport?.removeEventListener("resize", positionPopover);
      window.visualViewport?.removeEventListener("scroll", positionPopover);
      const style = document.documentElement.style;
      style.removeProperty("--notification-anchor-bottom");
      style.removeProperty("--notification-anchor-right");
    };
  }, [open]);

  /*
    Drawn for a signed-out visitor too, at the owner's ask — it used to vanish
    entirely, so the header changed shape on sign-in and a control appeared
    where none had been. `signedIn` still governs everything it *does*: no
    fetch, no polling, no count, and a panel that says there is nothing rather
    than an empty list that looks like a failure.
  */
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
        <svg className="app-icon-color relative z-10" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6.8 9.8a5.2 5.2 0 0 1 10.4 0c0 5.1 2.1 5.2 2.1 6.5H4.7c0-1.3 2.1-1.4 2.1-6.5Z" />
          <path d="M9.8 19a2.5 2.5 0 0 0 4.4 0" />
        </svg>
      </button>
      {unread > 0 && (
        <span
          aria-hidden="true"
          className="notification-unread-dot pointer-events-none absolute right-0.5 top-0.5 z-[1200] h-2.5 w-2.5 rounded-full border-2 border-[var(--color-background)]"
        />
      )}
      {/*
        The panel is rendered into document.body rather than here, and the
        reason is that it cannot do its job from inside the header.

        It is a pane of glass: what makes it readable is its own
        backdrop-filter blurring the page behind it. But an element carrying a
        backdrop-filter is a Backdrop Root, and the header carries one — so
        anything inside the header samples an empty backdrop and blurs
        nothing, at any radius, in any engine. Measured directly in a browser:
        a bare blur(30px) box put inside the header leaves the page perfectly
        sharp and the identical box at document level smears it completely.
        That is the whole of the "transparent window" this panel was reported
        as, and moving it out of the header is the only fix for it.

        Its viewport position comes from the anchor geometry published above,
        so it still opens from the bell; outside-click is handled by the
        selector check in the effect above rather than by DOM containment.
      */}
      {open && createPortal(
        /*
          A visitor with no account gets a panel that says so, not the real
          inbox: the inbox would fetch, fail, and show an empty list, which
          reads as "your notifications are gone" rather than "you have not got
          any yet". Portalled to the body like the real one, so it escapes the
          header's backdrop root the same way.
        */
        signedOut ? (
          <div className="notification-popover liquid-glass fixed z-[130] w-72 rounded-2xl border p-4" role="dialog" aria-label="Notifications">
            <p className="text-[0.875rem] font-semibold text-slate-900">No notifications</p>
            <p className="mt-1 text-[0.8125rem] leading-5 text-slate-600">
              Marked work, plan reminders and anything from your teacher arrive here once you have
              an account.
            </p>
            <a href="/account" className="btn-secondary mt-3 w-full !min-h-9 text-[0.875rem]">
              Sign in
            </a>
          </div>
        ) : (
          <NotificationPopover previewRole={previewRole} needsSetup={needsSetup} onClose={() => setOpen(false)} onUnreadCount={setNotificationUnread} />
        ),
        document.body,
      )}
    </div>
  );
}
