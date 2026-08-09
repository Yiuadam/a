"use client";

import type { SessionTier } from "@/lib/entitlements/sessions";

/*
  The owner's switch: see the app as any tier, including as one with no limits
  at all.

  ---------------------------------------------------------------------------
  What it is not

  It is not a way to grant anybody anything. Every gate that costs money is on
  the server — requireFeature and checkAiUsage read the tier from the database
  and never ask the browser what it thinks it is. So this changes what is
  *drawn* and nothing else, and that asymmetry is what makes it safe to build:

    An admin previewing "free" sees the locks and the counters, but the server
      still knows they are an admin, so the tutor still answers. The preview is
      honest about layout and lies about permission, in the direction that
      cannot cost anything.

    A non-admin who sets this key by hand sees exactly what they saw before,
      because the app only reads it when the server has already said the
      account is an admin. Setting it grants nothing.

  Which is worth stating plainly: this is a drawing tool, not an entitlement.
  The one thing an owner genuinely needs — no limits — they already have from
  the `admin` row in the database, and this switch's default is to show that.

  ---------------------------------------------------------------------------
  Why "off" is a preview of free rather than a global kill

  "Switch off all the limitations" is the useful direction, and it is already
  the owner's normal state. What an owner cannot otherwise do is the opposite:
  look at their own app the way a visitor or a free account sees it, locks and
  counters and paywall included, without signing out and losing their session.
  So the switch runs the whole range, and "Owner" — no limits — is where it
  sits unless somebody moves it.

  localStorage rather than a database column, because it is a property of this
  browser window and not of the account: an owner checking the paywall on a
  laptop has not stopped being an owner on their phone.
*/

const KEY = "bandup.admin.preview";

export type PreviewTier = SessionTier;

export const PREVIEW_TIERS: { id: PreviewTier; label: string; note: string }[] = [
  { id: "admin", label: "Adam", note: "No limits on anything" },
  { id: "pro", label: "Standard", note: "As a subscriber sees it" },
  { id: "free", label: "Free", note: "Weekly limits and the paywall" },
  { id: "anonymous", label: "Signed out", note: "Locks on writing and speaking" },
];

function isPreviewTier(v: unknown): v is PreviewTier {
  return v === "admin" || v === "pro" || v === "free" || v === "anonymous";
}

/*
  An external store rather than useState, so every component reading it repaints
  together the moment it changes — the dashboard, the practice page and the
  billing page are three separate trees and a preview that updated one of them
  would be worse than no preview at all.
*/
const listeners = new Set<() => void>();

export function subscribePreview(onChange: () => void): () => void {
  listeners.add(onChange);
  /* Other tabs, too: an owner with the app open twice should see one answer. */
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function readPreview(): PreviewTier | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return isPreviewTier(raw) ? raw : null;
  } catch {
    /* Private mode, or storage disabled. No preview is a fine answer. */
    return null;
  }
}

/** Null on the server: there is no browser to have an opinion yet. */
export function previewOnServer(): PreviewTier | null {
  return null;
}

export function setPreview(tier: PreviewTier | null): void {
  try {
    if (tier === null || tier === "admin") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, tier);
  } catch {
    /* Nothing to do, and nothing worth telling the owner about. */
  }
  for (const l of listeners) l();
}
