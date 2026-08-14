/**
 * The lookup trigger belongs to the selected text, not the pointer. Keep its
 * coordinate calculation deliberately literal: callers place the trigger at
 * the selection's centre and lift it above the selection with static CSS.
 */
export function lookupSelectionAnchor(rect: { left: number; top: number; width: number }) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top,
  };
}
