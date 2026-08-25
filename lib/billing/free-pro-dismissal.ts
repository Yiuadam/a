"use client";

/*
  Whether this device has already had the free Pro trial poster.

  It lived in components/billing/FreeProPoster.tsx, which was the right place
  while the poster was the only thing that touched it. Giving the trial up makes
  a second: the offer is available again the moment a learner hands the grant
  back, and a "seen it" flag left behind on the device would hide the only place
  the offer is made — so the exit has to forget the flag as well as release the
  row, and both files now read the same key from one place rather than spelling
  it twice.

  What is stored is "this person has seen the poster", and the worst a cleared
  browser can do with it is show the poster a second time. The grant itself is a
  database row resolved server-side, where clearing a browser can do nothing to
  it. Keeping the two apart is deliberate: the honest reason there is no
  server-side dismissal is that recording one would need a migration, and a
  migration cannot be previewed.
*/

/** Set when the reader has decided, either way. */
const DISMISSED_KEY = "bandup.promo.free-pro.v1";

export function dismissedAlready(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    // Private browsing, or storage switched off. Drawing the poster once per
    // visit is a better failure than never drawing it.
    return false;
  }
}

export function rememberDecision(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, new Date().toISOString());
  } catch {
    /* Nothing to do, and nothing worth telling the reader about. */
  }
}

/**
 * Forgets that the poster was seen, so the offer can be made again.
 *
 * Called when a learner gives the trial up. Without it the server would offer
 * the trial again and this device would never draw the offer — a reversible
 * decision that cannot actually be reversed anywhere the learner can see.
 */
export function forgetDecision(): void {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* Then it was never stored, and there is nothing to forget. */
  }
}

/*
  A guest who taps "Sign up free" on the poster has already decided —
  making them find the poster again and tap a second button afterward
  would be asking the same question twice. sessionStorage rather than
  localStorage: this is a one-time continuation of a click just made, not
  a standing preference, and it should not survive past the tab that made
  it.
*/
const AUTO_ACCEPT_KEY = "bandup.promo.free-pro.autoaccept.v1";

export function rememberAutoAcceptIntent(): void {
  try {
    window.sessionStorage.setItem(AUTO_ACCEPT_KEY, "1");
  } catch {
    /* Worst case: signing up lands back on the poster instead of past it. */
  }
}

/** Read-and-clear, so a later reload of the same tab does not repeat the accept. */
export function consumeAutoAcceptIntent(): boolean {
  try {
    const present = window.sessionStorage.getItem(AUTO_ACCEPT_KEY) !== null;
    window.sessionStorage.removeItem(AUTO_ACCEPT_KEY);
    return present;
  } catch {
    return false;
  }
}
