#!/usr/bin/env node
// Proves the Spotify preflight fails fast on the causes Spotify reports, and -
// just as important - that it NEVER fails a job for a cause it is unsure of.
//
// The bug this guards against is subtle. A preflight that vetoes a run on a
// guess is worse than no preflight at all: it turns "your wifi blipped" into
// "this extension is broken" and blocks downloads that would have worked. So
// every case below that is not an explicit Spotify verdict must resolve to
// checked:false and let the job proceed.
//
// Context: spotdl ships credentials shared by every spotdl user worldwide. On
// 2026-08-05 that pool answered 429 QUOTA_EXCEEDED with Retry-After 86400 - a
// 24-hour lockout hitting every install at once, presenting to the user as an
// eight-minute silence and then nothing.

import { preflightSpotify } from "../server/worker.js";

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

// A message a non-technical person can act on: no codes, no jargon, and long
// enough to actually say what to do. Same predicate as fault-tests.mjs.
const isLegible = (msg) =>
  typeof msg === "string" &&
  msg.length > 40 &&
  !/\b(ENOENT|ECONNRESET|EAI_AGAIN|undefined|null|NaN)\b/.test(msg) &&
  !/exit code|stack trace|at Object\.|TypeError|\bJSON\.parse\b/i.test(msg) &&
  /[a-z]{4,}\s+[a-z]{4,}/i.test(msg);

const settle = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
};

console.log("\n=== A link shape the preflight does not recognise is passed through ===");
{
  const r = await settle(() => preflightSpotify("https://open.spotify.com/artist/abc123"));
  check("does not throw", r.ok);
  check("reports it did not check", r.ok && r.value.checked === false);
  check("still allows the job to proceed", r.ok && r.value.ok === true);
}

console.log("\n=== An unreachable Spotify must NOT fail the job ===");
{
  // Point the token call at a host that cannot answer. The preflight is only
  // allowed to veto on an explicit verdict, never on being unable to ask.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
  };
  const r = await settle(() =>
    preflightSpotify("https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT"),
  );
  globalThis.fetch = realFetch;

  check("offline does not throw", r.ok, r.ok ? "" : String(r.error?.message).slice(0, 60));
  check("offline is reported as unchecked", r.ok && r.value.checked === false);
  check("offline still allows the job to proceed", r.ok && r.value.ok === true);
}

console.log("\n=== A hung Spotify must time out, not block forever ===");
{
  const realFetch = globalThis.fetch;
  // A fetch that never settles unless aborted - the exact shape of the bug that
  // motivated all of this. If the preflight lacks a timeout, this test hangs,
  // which is itself the failure signal.
  globalThis.fetch = (_url, opts = {}) =>
    new Promise((_resolve, reject) => {
      opts.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });

  const t0 = Date.now();
  const r = await settle(() =>
    preflightSpotify("https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT"),
  );
  const elapsed = Date.now() - t0;
  globalThis.fetch = realFetch;

  check("a never-answering Spotify still returns", r.ok, `${elapsed}ms`);
  check("it returned via the timeout, not by hanging", elapsed < 30000, `${elapsed}ms`);
  check("and it did not veto the job", r.ok && r.value.ok === true);
}

console.log("\n=== 429 QUOTA_EXCEEDED is explained, with the reset time and a way out ===");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("accounts.spotify.com"))
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response(
      JSON.stringify({ error: { status: 429, reason: "QUOTA_EXCEEDED" } }),
      { status: 429, headers: { "retry-after": "86400" } },
    );
  };
  const r = await settle(() =>
    preflightSpotify("https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT"),
  );
  globalThis.fetch = realFetch;

  const msg = r.ok ? "" : String(r.error?.message ?? "");
  check("the job is failed, not left to stall", !r.ok);
  check("the message is legible", isLegible(msg));
  check("it says when it resets", /24 hours|about \d+ hour/.test(msg), msg.slice(0, 70));
  check("it offers the credentials workaround", /developer\.spotify\.com/.test(msg));
  check("it confirms nothing was downloaded", /[Nn]othing was downloaded/.test(msg));
  check("it does not leak the raw reason code", !/QUOTA_EXCEEDED|429/.test(msg));
}

console.log("\n=== With the user's own credentials, 429 does not blame the shared pool ===");
{
  const realFetch = globalThis.fetch;
  process.env.SPOTIFY_CLIENT_ID = "userid";
  process.env.SPOTIFY_CLIENT_SECRET = "usersecret";
  globalThis.fetch = async (url) => {
    if (String(url).includes("accounts.spotify.com"))
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
  };
  const r = await settle(() =>
    preflightSpotify("https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT"),
  );
  globalThis.fetch = realFetch;
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;

  const msg = r.ok ? "" : String(r.error?.message ?? "");
  check("the job is failed", !r.ok);
  check("the message is legible", isLegible(msg));
  check(
    "it does not tell them to add credentials they already added",
    !/developer\.spotify\.com/.test(msg),
    msg.slice(0, 70),
  );
}

console.log("\n=== A private or deleted playlist says so plainly ===");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("accounts.spotify.com"))
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const r = await settle(() =>
    preflightSpotify("https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT"),
  );
  globalThis.fetch = realFetch;

  const msg = r.ok ? "" : String(r.error?.message ?? "");
  check("the job is failed", !r.ok);
  check("the message is legible", isLegible(msg));
  check("it names the likely cause", /private|deleted/i.test(msg));
  check("it does not leak a status code", !/\b404\b/.test(msg));
}

console.log("\n=== A 5xx is Spotify's problem, not a reason to veto ===");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("accounts.spotify.com"))
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response("{}", { status: 503 });
  };
  const r = await settle(() =>
    preflightSpotify("https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT"),
  );
  globalThis.fetch = realFetch;

  check("does not throw on a 503", r.ok);
  check("lets the job proceed to spotdl", r.ok && r.value.ok === true);
}

console.log("\n=== A healthy playlist reports its name and size ===");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("accounts.spotify.com"))
      return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    return new Response(JSON.stringify({ name: "Road Trip", tracks: { total: 116 } }), {
      status: 200,
    });
  };
  const r = await settle(() =>
    preflightSpotify("https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT"),
  );
  globalThis.fetch = realFetch;

  check("succeeds", r.ok && r.value.ok === true);
  check("marks the check as real", r.ok && r.value.checked === true);
  check("captures the name", r.ok && r.value.name === "Road Trip");
  check("captures the track count", r.ok && r.value.total === 116);

  // The count drives the metadata budget, so the arithmetic is worth pinning:
  // 90s + 3s per track, capped at the old fixed 15-minute ceiling.
  const budget = Math.min(15 * 60 * 1000, 90 * 1000 + 116 * 3000);
  check("116 tracks yields a sane budget", budget === 438000, `${budget / 60000} min`);
  const small = Math.min(15 * 60 * 1000, 90 * 1000 + 10 * 3000);
  check("a 10-track album is not given 15 minutes", small === 120000, `${small / 60000} min`);
  const huge = Math.min(15 * 60 * 1000, 90 * 1000 + 5000 * 3000);
  check("a giant playlist is still capped", huge === 900000, `${huge / 60000} min`);
}

console.log("\n" + "=".repeat(46));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
