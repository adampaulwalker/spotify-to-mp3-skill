#!/usr/bin/env node
// Proves the output watchdog fires and, crucially, that a watchdog kill is
// never mistaken for success.
//
// This is the failure that actually happened: a network drop killed every
// in-flight request, the engine sat there alive and silent, and nothing timed
// out. The first fix for it was worse than the bug - a kill that exits 0 would
// have been read as a clean finish and a truncated track list reported as
// complete. That is what these cases exist to prevent regressing.

import { spawn } from "node:child_process";

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

// A faithful copy of the watchdog in server/worker.js run(). Kept in step by
// asserting on behaviour, not by importing - run() is bound to the engines.
function runWithWatchdog(bin, args, silenceMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let timer = null;
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGKILL");
        }
      }, silenceMs);
    };
    reset();
    const onData = () => reset();
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
}

console.log("\n=== A process that hangs silently ===");
const t0 = Date.now();
const hung = await runWithWatchdog("sleep", ["120"], 3000);
const elapsed = Date.now() - t0;

check("watchdog fires on silence", hung.timedOut === true);
check("kills promptly, does not wait out the process", elapsed < 10000, `${elapsed}ms`);
check("process is actually dead", hung.code !== null || hung.signal !== null);

console.log("\n=== A process that keeps talking is left alone ===");
const chatty = await runWithWatchdog(
  "bash",
  ["-c", 'for i in 1 2 3 4 5 6; do echo tick; sleep 0.5; done'],
  2000,
);
check("no false positive on a slow but live process", chatty.timedOut === false);
check("it completed normally", chatty.code === 0);

console.log("\n=== A kill that exits cleanly must NOT read as success ===");
// The dangerous shape: a process that traps SIGTERM and exits 0. Checking the
// exit code alone would call this a clean finish and parse whatever partial
// output existed as complete.
const trapped = await runWithWatchdog(
  "bash",
  ["-c", 'trap "exit 0" TERM; sleep 120'],
  2500,
);
check("timedOut is set even though the exit code is 0", trapped.timedOut === true);
check(
  "exit code alone would have been misleading",
  trapped.code === 0,
  `code=${trapped.code} - this is exactly why timedOut is checked separately`,
);

console.log("\n=== The caller must treat timedOut as failure ===");
const worker = await import("node:fs").then(({ readFileSync }) =>
  readFileSync(new URL("../server/worker.js", import.meta.url), "utf8"),
);
check(
  "metadata phase checks timedOut",
  /if \(saved\.timedOut\)/.test(worker),
);
check(
  "it is checked BEFORE the exit code",
  worker.indexOf("saved.timedOut") < worker.indexOf("saved.code !== 0"),
);
check(
  "download phase treats a timeout as a crash",
  /Boolean\(result\.timedOut\)/.test(worker),
);
check(
  "the failure message explains itself",
  /produced no output for/.test(worker),
);

console.log("\n" + "=".repeat(46));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
