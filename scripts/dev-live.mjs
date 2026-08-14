/*
  `npm run dev:live` — the development server, following this branch.

  The problem it solves: an agent working on this repository pushes commits from
  somewhere else, and its localhost is not reachable from yours. Rather than
  tunnelling that machine to you, this keeps the server on *your* machine and
  moves the code instead: it polls the branch you are on, fast-forwards when new
  commits land, and lets Next's hot reload put them on screen. From your side it
  looks like a page that updates itself a few seconds after a change is made.

  It will never touch work of your own. A fast-forward is the only move it makes
  — no merge, no rebase, no stash, nothing discarded — and it stands down and
  says so if the branch has diverged or the tree is dirty.
*/
import { spawn, spawnSync } from "node:child_process";

const POLL_MS = Number(process.env.DEV_LIVE_POLL_MS ?? 10_000);
const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const out = (...args) => git(...args).stdout?.trim() ?? "";

const branch = out("rev-parse", "--abbrev-ref", "HEAD");
if (!branch || branch === "HEAD") {
  console.error("  Not on a branch (detached HEAD). Check one out first.");
  process.exit(1);
}

let paused = false;

function check() {
  if (paused) return;

  const fetched = git("fetch", "origin", branch);
  if (fetched.status !== 0) return; // Offline or a transient failure; try again next tick.

  const local = out("rev-parse", "HEAD");
  const remote = out("rev-parse", `origin/${branch}`);
  if (!remote || local === remote) return;

  /* Behind and clean is the only case worth acting on. Anything else is the
     developer's own state, and silently moving it would be unforgivable. */
  const dirty = out("status", "--porcelain");
  if (dirty) {
    console.log(`\n  ${remote.slice(0, 7)} is on the branch, but you have uncommitted changes.`);
    console.log("  Not touching them. Commit or stash, and this will pick it up.\n");
    paused = true;
    return;
  }

  const ahead = out("rev-list", "--count", `origin/${branch}..HEAD`);
  if (ahead !== "0") {
    console.log(`\n  Your branch has ${ahead} commit(s) the remote does not. Not fast-forwarding.\n`);
    paused = true;
    return;
  }

  const subjects = out("log", "--oneline", `HEAD..origin/${branch}`).split("\n").filter(Boolean);
  const pulled = git("merge", "--ff-only", `origin/${branch}`);
  if (pulled.status !== 0) {
    console.log(`\n  Could not fast-forward: ${pulled.stderr?.trim()}\n`);
    paused = true;
    return;
  }

  console.log(`\n  Pulled ${subjects.length} new commit(s):`);
  for (const line of subjects.reverse()) console.log(`    ${line}`);

  /* Hot reload handles source. It cannot handle a dependency that did not
     exist when the server started, so say so rather than let the page fail
     with a module-not-found that looks like a bug in the change. */
  const touched = out("diff", "--name-only", `${local}..${remote}`).split("\n");
  if (touched.includes("package.json") || touched.includes("package-lock.json")) {
    console.log("\n  Dependencies changed — stop this and run `npm ci` before trusting the page.");
  }
  console.log("");
}

console.log(
  [
    "",
    `  Following origin/${branch}, checking every ${Math.round(POLL_MS / 1000)}s.`,
    "  Glass lab is ON. New commits fast-forward and hot-reload themselves.",
    "",
    "  Where to look:  the “Start the 5-minute test” button on /",
    "                  the view tabs on /organization?preview=manager",
    "",
    "  The lens needs a mouse or trackpad and more than 4 CPU cores. On a phone",
    "  or a low-powered machine it is meant to be absent, not broken.",
    "",
  ].join("\n"),
);

const timer = setInterval(check, POLL_MS);
check();

const child = spawn("npx", ["next", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NEXT_PUBLIC_GLASS_LAB: "1" },
});

child.on("exit", (code, signal) => {
  clearInterval(timer);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
