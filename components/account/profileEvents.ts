import type { ProfileFields } from "./types";

/**
 * One-tab profile updates.
 *
 * The profile editor and the site header are siblings under the root layout,
 * so neither can pass state directly to the other. This small browser event
 * lets a successful save update the persistent header immediately without a
 * page reload or another account request.
 */
export const PROFILE_UPDATED_EVENT = "bandup:profile-updated";

export type ProfileUpdate = Partial<ProfileFields>;

export function publishProfileUpdate(update: ProfileUpdate): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ProfileUpdate>(PROFILE_UPDATED_EVENT, { detail: update }),
  );
}
