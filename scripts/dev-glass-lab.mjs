/*
  `npm run dev:glass` — the development server with the glass experiment on.

  A node script rather than `NEXT_PUBLIC_GLASS_LAB=1 next dev` in package.json
  because that form is a shell assignment, and it fails on Windows without
  saying why. Setting the variable here works the same on every platform.

  There is nothing to undo afterwards: the variable is set for this process
  only, and `npm run dev` is unaffected. What the flag switches on is described
  in lib/glass-lab.ts.
*/
import { spawn } from "node:child_process";

/* The lens is a fine-pointer, higher-tier-hardware enhancement by design, so
   say so once at startup rather than let it look broken on a machine that
   correctly declines it. See lib/glass-performance.ts for the exact rule. */
console.log(
  [
    "",
    "  Glass lab is ON (NEXT_PUBLIC_GLASS_LAB=1).",
    "",
    "  Where to look:  the “Start the 5-minute test” button on /",
    "                  the view tabs on /organization?preview=manager",
    "",
    "  It appears only with a mouse or trackpad, on a machine reporting more",
    "  than 4 CPU cores and more than 4 GB of memory, without reduced motion,",
    "  reduced transparency or Save-Data. On a phone, a touchscreen or a",
    "  low-powered machine it is meant to be absent, not broken.",
    "",
  ].join("\n"),
);

const child = spawn("npx", ["next", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NEXT_PUBLIC_GLASS_LAB: "1" },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
