export const GLASS_PERFORMANCE_QUERY =
  "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";

export type GlassCapability = {
  finePointer: boolean;
  reducedMotion: boolean;
  reducedTransparency: boolean;
  saveData: boolean;
  memoryGb: number | null;
  cores: number | null;
};

/* A conservative gate for the high-detail SVG displacement layer. CSS
   backdrop-filter remains the real glass everywhere, so declining this tier
   changes fidelity rather than functionality. Unknown hardware is allowed on
   a fine-pointer desktop; known low-tier hardware is not. */
export function supportsDetailedGlass(capability: GlassCapability) {
  if (
    !capability.finePointer ||
    capability.reducedMotion ||
    capability.reducedTransparency ||
    capability.saveData
  ) return false;

  if (capability.memoryGb !== null && capability.memoryGb <= 4) return false;
  if (capability.cores !== null && capability.cores <= 4) return false;
  return true;
}
