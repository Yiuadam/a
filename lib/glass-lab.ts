/*
  The enhanced optics below are an experiment, not a shipped decision. Reading
  the switch through a NEXT_PUBLIC_ variable means Next substitutes it at
  build time: a build made without it cannot contain the enhanced path at
  all, rather than carrying it behind a runtime branch that could be flipped
  by accident.
*/
export const GLASS_LAB = process.env.NEXT_PUBLIC_GLASS_LAB === "1";

export type GlassOptics = "standard" | "enhanced";

/*
  `lab` is a parameter rather than a direct read of GLASS_LAB so both branches
  stay testable from a build that never set the variable, rather than the
  function silently agreeing with itself.
*/
export function resolveOptics(optics: GlassOptics | undefined, lab: boolean = GLASS_LAB): GlassOptics {
  return optics === "enhanced" && lab ? "enhanced" : "standard";
}
