#!/usr/bin/env node
// Pins the .spotdl save-file shape against spotDL's Song dataclass.
//
// This is the one genuine risk in resolving tracks ourselves. spotDL loads a
// save file with `cls(**data)`, so a required key we forget is a TypeError the
// moment the download starts - after the user has waited, and with a message
// only a developer could read. A key we add that spotDL does not define is the
// same crash from the other direction.
//
// The required list below is spotDL 4.5.2's Song dataclass: the 19 fields with
// no default. If a future bundled spotdl changes it, this test is where that
// shows up, rather than in a user's failed download.

import { resolveTracks, parseSpotifyLink, SpotifyError } from "../server/spotify.js";

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

const REQUIRED = [
  "name", "artists", "artist", "genres", "disc_number", "disc_count",
  "album_name", "album_artist", "duration", "year", "date", "track_number",
  "tracks_count", "song_id", "explicit", "publisher", "url", "isrc", "cover_url",
  "copyright_text",
];
const OPTIONAL = [
  "download_url", "lyrics", "popularity", "album_id", "list_name", "list_url",
  "list_position", "list_length", "artist_id", "album_type",
];

// --- a stand-in Spotify, so this runs offline and deterministically ---------
const TRACK = (i) => ({
  id: `track${i}`,
  name: `Song ${i}`,
  type: "track",
  artists: [{ name: "The Band", id: "artist1" }, { name: "Guest", id: "artist2" }],
  album: { id: "album1" },
  duration_ms: 210000 + i,
  explicit: i % 2 === 0,
  popularity: 40 + i,
  track_number: i,
  disc_number: i > 2 ? 2 : 1,
  external_ids: { isrc: `ISRC00${i}` },
  external_urls: { spotify: `https://open.spotify.com/track/track${i}` },
});

const ALBUM = {
  id: "album1",
  name: "The Album",
  album_type: "album",
  artists: [{ name: "The Band", id: "artist1" }],
  release_date: "2019-04-05",
  total_tracks: 4,
  label: "Some Label",
  genres: ["indie"],
  copyrights: [{ text: "2019 Some Label", type: "C" }],
  images: [
    { url: "https://img/small.jpg", width: 64 },
    { url: "https://img/big.jpg", width: 640 },
  ],
};

function mockFetch(handlers) {
  return async (url) => {
    const u = String(url);
    for (const [pattern, body] of handlers) {
      if (u.includes(pattern)) {
        const value = typeof body === "function" ? body(u) : body;
        if (value instanceof Response) return value;
        return new Response(JSON.stringify(value), { status: 200 });
      }
    }
    return new Response("{}", { status: 404 });
  };
}

const TOKEN = ["accounts.spotify.com", { access_token: "tok" }];

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err };
  } finally {
    globalThis.fetch = real;
  }
};

console.log("\n=== Link parsing ===");
for (const [url, kind] of [
  ["https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT", "playlist"],
  ["https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3", "album"],
  ["https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", "track"],
  ["spotify:playlist:2o9U1YbCHiq2pwuYLyXyjT", "playlist"],
]) {
  const p = parseSpotifyLink(url);
  check(`${kind} link parses`, p?.kind === kind, p ? "" : "returned null");
}
check("a localised /intl-de/ link parses",
  parseSpotifyLink("https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT")?.kind === "track");
check("an artist link is rejected", parseSpotifyLink("https://open.spotify.com/artist/x") === null);

// A look-alike host must not be treated as Spotify. An earlier version matched
// the path shape anywhere in the string and accepted all three of these.
for (const bad of [
  "https://example.com/playlist/2o9U1YbCHiq2pwuYLyXyjT",
  "https://spotify.com.evil.net/playlist/2o9U1YbCHiq2pwuYLyXyjT",
  "https://notspotify.com/album/x",
]) {
  check(`rejected: ${bad.slice(8, 34)}`, parseSpotifyLink(bad) === null);
}

console.log("\n=== A playlist produces records spotDL can load ===");
{
  const r = await withFetch(
    mockFetch([
      TOKEN,
      ["/playlists/2o9U1YbCHiq2pwuYLyXyjT?fields", {
        name: "Road Trip",
        external_urls: { spotify: "https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT" },
        tracks: { total: 4 },
      }],
      ["/playlists/2o9U1YbCHiq2pwuYLyXyjT/tracks", {
        items: [1, 2, 3, 4].map((i) => ({ track: TRACK(i) })),
        next: null,
      }],
      ["/albums?ids=", { albums: [ALBUM] }],
    ]),
    () => resolveTracks("https://open.spotify.com/playlist/2o9U1YbCHiq2pwuYLyXyjT"),
  );

  check("resolves without throwing", r.ok, r.ok ? "" : String(r.error?.message).slice(0, 60));
  const songs = r.ok ? r.value : [];
  check("all four tracks present", songs.length === 4, `got ${songs.length}`);

  if (songs.length) {
    const s = songs[0];
    const missing = REQUIRED.filter((k) => !(k in s));
    check("every required Song field is present", missing.length === 0, missing.join(", "));

    const unknown = Object.keys(s).filter(
      (k) => !REQUIRED.includes(k) && !OPTIONAL.includes(k),
    );
    check("no field spotDL does not define", unknown.length === 0, unknown.join(", "));

    check("artists is a list of names", Array.isArray(s.artists) && s.artists[0] === "The Band");
    check("artist is the primary, not the list", s.artist === "The Band");
    check("duration is seconds, not milliseconds", s.duration > 100 && s.duration < 400, String(s.duration));
    check("year parsed from the release date", s.year === 2019, String(s.year));
    check("publisher taken from the album label", s.publisher === "Some Label");
    check("genres came from the album lookup", Array.isArray(s.genres) && s.genres[0] === "indie");
    check("copyright captured", typeof s.copyright_text === "string");
    check("largest cover chosen, not the first", s.cover_url === "https://img/big.jpg", String(s.cover_url));
    check("isrc captured", s.isrc === "ISRC001");
    check("explicit is a real boolean", typeof s.explicit === "boolean");
    check("disc_count spans both discs", s.disc_count === 2, String(s.disc_count));

    check("list_position is 1-based", s.list_position === 1, String(s.list_position));
    check("list_length is the playlist size", s.list_length === 4, String(s.list_length));
    check("last track's position is last", songs[3].list_position === 4);
    check("list_name is the playlist name", s.list_name === "Road Trip");

    // Numbering drives the output filenames, so a duplicate silently overwrites.
    const positions = new Set(songs.map((x) => x.list_position));
    check("positions are unique", positions.size === songs.length);

    check("JSON round-trips", (() => {
      try { return JSON.parse(JSON.stringify(songs)).length === 4; } catch { return false; }
    })());
  }
}

console.log("\n=== Unplayable entries never occupy a track slot ===");
{
  const r = await withFetch(
    mockFetch([
      TOKEN,
      ["/playlists/x?fields", { name: "Mixed", external_urls: {}, tracks: { total: 4 } }],
      ["/playlists/x/tracks", {
        items: [
          { track: TRACK(1) },
          { track: null },                                   // removed track
          { track: { id: null, name: "Local File" } },        // local file
          { track: { id: "ep1", name: "Ep", type: "episode" } }, // podcast
        ],
        next: null,
      }],
      ["/albums?ids=", { albums: [ALBUM] }],
    ]),
    () => resolveTracks("https://open.spotify.com/playlist/x"),
  );
  check("resolves", r.ok, r.ok ? "" : String(r.error?.message).slice(0, 50));
  check("only the real track survives", r.ok && r.value.length === 1, r.ok ? `got ${r.value.length}` : "");
  check("list_length reflects what survived", r.ok && r.value[0].list_length === 1);
}

console.log("\n=== Pagination is followed to the end ===");
{
  let calls = 0;
  const r = await withFetch(
    mockFetch([
      TOKEN,
      ["/playlists/p?fields", { name: "Big", external_urls: {}, tracks: { total: 150 } }],
      ["/tracks", (u) => {
        calls++;
        const isSecond = u.includes("offset=100");
        return {
          items: Array.from({ length: isSecond ? 50 : 100 }, (_, i) => ({
            track: TRACK(i + 1 + (isSecond ? 100 : 0)),
          })),
          next: isSecond ? null : "https://api.spotify.com/v1/playlists/p/tracks?offset=100",
        };
      }],
      ["/albums?ids=", { albums: [ALBUM] }],
    ]),
    () => resolveTracks("https://open.spotify.com/playlist/p"),
  );
  check("both pages fetched", calls === 2, `${calls} page requests`);
  check("all 150 tracks returned", r.ok && r.value.length === 150, r.ok ? `got ${r.value.length}` : "");
  check("numbering continues across the page break", r.ok && r.value[149].list_position === 150);
}

console.log("\n=== Failures are legible, and a hang is impossible ===");
{
  const quota = await withFetch(
    mockFetch([
      TOKEN,
      ["/playlists/", new Response("{}", { status: 429, headers: { "retry-after": "86400" } })],
    ]),
    () => resolveTracks("https://open.spotify.com/playlist/q"),
  );
  const msg = String(quota.error?.message ?? "");
  check("quota lockout throws", !quota.ok);
  check("tagged as a quota problem", quota.error instanceof SpotifyError && quota.error.kind === "quota");
  check("names the reset window", /about \d+ hours|a little while/.test(msg));
  check("points at the self-serve fix", /developer\.spotify\.com/.test(msg));
  check("no status code leaks", !/\b429\b/.test(msg));

  const gone = await withFetch(
    mockFetch([TOKEN, ["/playlists/", new Response("{}", { status: 404 })]]),
    () => resolveTracks("https://open.spotify.com/playlist/z"),
  );
  check("a missing playlist throws", !gone.ok);
  check("and says it may be private", /private|deleted/i.test(String(gone.error?.message)));

  // The whole point of this module: a Spotify that never answers must not hang.
  const t0 = Date.now();
  const hung = await withFetch(
    (_url, opts = {}) =>
      new Promise((_res, rej) =>
        opts.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        ),
      ),
    () => resolveTracks("https://open.spotify.com/playlist/hang"),
  );
  const elapsed = Date.now() - t0;
  check("a never-answering Spotify still returns", !hung.ok, `${Math.round(elapsed / 1000)}s`);
  check("it gives up rather than blocking forever", elapsed < 130000, `${Math.round(elapsed / 1000)}s`);
  check("and explains itself", /Could not reach Spotify/.test(String(hung.error?.message)));
}

console.log("\n" + "=".repeat(46));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
