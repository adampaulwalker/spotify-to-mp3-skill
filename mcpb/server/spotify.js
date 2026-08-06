// Read a Spotify link's track list over the Web API, and write the .spotdl
// save file that the download phase already consumes.
//
// Why this exists rather than `spotdl save`:
//
// `spotdl save` resolves each track separately and fans out roughly fifty
// concurrent connections to Spotify. Its HTTP client sets no socket read
// timeout, so if any single one of those responses stalls, that thread blocks
// forever and the process never exits. Measured 2026-08-05 on a 116-track
// playlist: 474 seconds of total silence, no save file, ~47 sockets open, the
// process parked in read() with no sleep frames anywhere in the sample. It
// reproduced on a 10-track album too, with known-good credentials, so it is
// neither a quota problem nor a credentials problem.
//
// The same playlist over the paginated endpoint: 116 tracks, 2 requests, 1.41
// seconds. This module is that path - a bounded number of sequential requests,
// each with a timeout this process controls, reporting progress as it goes.
//
// The save file's shape is spotDL's own `Song` dataclass, loaded via
// `cls(**data)`, so a missing required key is a TypeError at download time
// rather than anything graceful. All 19 required keys are written on every
// track; the 11 optional ones are written when Spotify supplies them.
// scripts/schema-test.mjs pins the required list against that dataclass.

const API = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_ATTEMPTS = 3;
// A 429 on a per-user app is a short breather. Anything claiming a longer wait
// than this is a quota lockout, which retrying cannot fix - surface it instead.
const MAX_RETRY_AFTER_MS = 60 * 1000;

// spotdl publishes these in its own config so it works with no setup. They are
// shared by every spotdl user worldwide and the pool does run dry - measured
// 2026-08-05 returning 429 QUOTA_EXCEEDED with Retry-After 86400, a 24-hour
// lockout hitting every install simultaneously. Used only as a fallback so a
// first run works out of the box; a user who adds their own app gets their own
// quota and stops sharing a failure domain with strangers.
export const SPOTDL_DEFAULT_CLIENT_ID = "5f573c9620494bae87890c0f08a60293";
export const SPOTDL_DEFAULT_CLIENT_SECRET = "212476d9b0f3472eaa762d90b19b0ba8";

export class SpotifyError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "quota" | "auth" | "missing" | "network"
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function credentials() {
  const own = Boolean(
    process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET,
  );
  return {
    usingOwn: own,
    id: process.env.SPOTIFY_CLIENT_ID || SPOTDL_DEFAULT_CLIENT_ID,
    secret: process.env.SPOTIFY_CLIENT_SECRET || SPOTDL_DEFAULT_CLIENT_SECRET,
  };
}

function quotaMessage(usingOwn, retryAfterSec) {
  const h = Math.round((retryAfterSec || 0) / 3600);
  const wait = h >= 2 ? `about ${h} hours` : "a little while";
  if (usingOwn) {
    return (
      `Spotify has temporarily rate-limited your credentials. They should work again in ${wait}. ` +
      "Nothing was downloaded, and starting the job again after that is safe."
    );
  }
  return (
    "Spotify's limit for this app's shared credentials is used up, so the track list cannot be " +
    `read right now. It resets in ${wait}.\n\n` +
    "To avoid waiting - and to stop sharing a limit with every other user of this extension - " +
    "add your own free Spotify credentials in this extension's settings. At " +
    "developer.spotify.com/dashboard click Create app: name it anything NOT starting with " +
    '"Spot", set the Redirect URI to exactly http://127.0.0.1:8888/callback (the form ' +
    "requires one; this tool never uses it), tick Web API and the terms box, then Save. " +
    "Copy the app's Client ID and Client Secret from its Settings page into the " +
    "extension's settings.\n\nNothing was downloaded."
  );
}

/** One HTTP request with a real timeout and a bounded, honest retry. */
async function request(url, init, { usingOwn }) {
  let lastNetworkError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ac.signal });
    } catch (err) {
      // Includes the abort. A request that hangs is the failure this whole
      // module exists to eliminate, so it must be retried, not waited on.
      lastNetworkError = err;
      clearTimeout(timer);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * attempt);
        continue;
      }
      throw new SpotifyError(
        "Could not reach Spotify. Check the internet connection and try again - " +
          "nothing was downloaded.",
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get("retry-after") || 0);
      if (retryAfterSec * 1000 <= MAX_RETRY_AFTER_MS && attempt < MAX_ATTEMPTS) {
        await sleep(Math.max(1000, retryAfterSec * 1000));
        continue;
      }
      throw new SpotifyError(quotaMessage(usingOwn, retryAfterSec), "quota");
    }

    if (res.status === 401 || res.status === 400) {
      throw new SpotifyError(
        usingOwn
          ? "Spotify rejected the Client ID and Secret in this extension's settings. Check both " +
            "were pasted in full, or clear them to fall back to the built-in credentials."
          : "Spotify rejected this extension's built-in credentials, which usually means the " +
            "extension needs an update. Adding your own Client ID and Secret in settings works around it.",
        "auth",
      );
    }

    if (res.status === 404) {
      throw new SpotifyError(
        "That Spotify link could not be found. It may have been deleted, or it may be private - " +
          "a link only works here if it is public.",
        "missing",
      );
    }

    if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
      await sleep(1000 * attempt);
      continue;
    }

    if (!res.ok) {
      throw new SpotifyError(
        // The status code stays in the message. An earlier version hid it to
        // keep the text friendly, and the first real remote failure - a fresh
        // install on someone else's machine - became undiagnosable: "unexpected
        // error" with the one distinguishing fact stripped out. One code in
        // parentheses costs a non-technical reader nothing and tells whoever is
        // helping them everything.
        `Spotify returned an unexpected error while reading the track list ` +
          `(HTTP ${res.status}). Trying again in a few minutes sometimes clears it - ` +
          "nothing was downloaded.\n\n" +
          (res.status === 403
            ? "A 403 on a newly created Spotify app usually means the app cannot read this " +
              "playlist: Spotify-made playlists (Top 50, Discover Weekly, editorial mixes) " +
              "are not readable by new apps. Try a playlist created by a person - your own, " +
              "or any public user playlist."
            : ""),
        "network",
      );
    }

    return res.json();
  }

  throw new SpotifyError(
    "Could not reach Spotify after several attempts. Nothing was downloaded.",
    "network",
  );
}

async function getToken(creds) {
  const body = await request(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${creds.id}:${creds.secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    },
    creds,
  );
  if (!body?.access_token) {
    throw new SpotifyError(
      "Spotify did not return an access token. Trying again usually clears it.",
      "auth",
    );
  }
  return body.access_token;
}

export function parseSpotifyLink(url) {
  const s = String(url).trim();

  // The host has to be checked, not just the path shape. An earlier version
  // matched on "/playlist/<id>" anywhere in the string, which happily accepted
  // https://example.com/playlist/x and sent it to Spotify as a real id.
  const uri = /^spotify:(playlist|album|track):([A-Za-z0-9]+)$/.exec(s);
  if (uri) return { kind: uri[1], id: uri[2] };

  // Localised share links carry an /intl-xx/ segment before the type.
  const web =
    /^https?:\/\/(?:[a-z0-9-]+\.)*spotify\.com\/(?:intl-[a-z]{2}\/)?(playlist|album|track)\/([A-Za-z0-9]+)/i.exec(
      s,
    );
  return web ? { kind: web[1].toLowerCase(), id: web[2] } : null;
}

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n),
  );

function largestCover(images) {
  if (!Array.isArray(images) || !images.length) return null;
  return images.reduce((a, b) => ((b?.width ?? 0) > (a?.width ?? 0) ? b : a)).url ?? null;
}

/**
 * Build one spotDL Song record. Every one of the 19 required keys is written
 * unconditionally - spotDL loads these with `cls(**data)`, so an omitted key is
 * a TypeError at download time, not a missing tag.
 */
function toSong(track, album, list) {
  const artists = (track.artists ?? []).map((a) => a.name).filter(Boolean);
  const releaseDate = album?.release_date ?? track.album?.release_date ?? "";
  const year = Number.parseInt(String(releaseDate).slice(0, 4), 10);
  const albumObj = album ?? track.album ?? {};

  const song = {
    name: track.name ?? "",
    artists: artists.length ? artists : ["Unknown"],
    artist: artists[0] ?? "Unknown",
    genres: Array.isArray(albumObj.genres) ? albumObj.genres : [],
    disc_number: track.disc_number ?? 1,
    disc_count: albumObj.__disc_count ?? track.disc_number ?? 1,
    album_name: albumObj.name ?? "",
    album_artist: albumObj.artists?.[0]?.name ?? artists[0] ?? "Unknown",
    duration: (track.duration_ms ?? 0) / 1000,
    year: Number.isFinite(year) ? year : 0,
    date: releaseDate,
    track_number: track.track_number ?? 1,
    tracks_count: albumObj.total_tracks ?? 1,
    song_id: track.id ?? "",
    explicit: Boolean(track.explicit),
    publisher: albumObj.label ?? "",
    url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
    isrc: track.external_ids?.isrc ?? null,
    cover_url: largestCover(albumObj.images) ?? null,
    copyright_text: albumObj.copyrights?.[0]?.text ?? null,
  };

  // Optional fields - written only when real, so nothing invents metadata.
  if (typeof track.popularity === "number") song.popularity = track.popularity;
  if (albumObj.id) song.album_id = albumObj.id;
  if (albumObj.album_type) song.album_type = albumObj.album_type;
  if (track.artists?.[0]?.id) song.artist_id = track.artists[0].id;
  if (list) {
    song.list_name = list.name;
    song.list_url = list.url;
    song.list_position = list.position;
    song.list_length = list.length;
  }
  return song;
}

/**
 * Resolve a Spotify link to spotDL Song records.
 *
 * onProgress({done, total, phase}) fires as pages arrive, so the phase that
 * used to be a silent multi-minute wait now reports real numbers.
 */
export async function resolveTracks(url, { onProgress = () => {} } = {}) {
  const link = parseSpotifyLink(url);
  if (!link) {
    throw new SpotifyError(
      "That does not look like a Spotify playlist, album, or song link.",
      "missing",
    );
  }

  const creds = credentials();
  const token = await getToken(creds);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const get = (path) => request(`${API}${path}`, auth, creds);

  let listMeta = null;
  let rawTracks = [];

  if (link.kind === "track") {
    rawTracks = [await get(`/tracks/${link.id}`)];
  } else if (link.kind === "album") {
    const album = await get(`/albums/${link.id}`);
    listMeta = { name: album.name, url: album.external_urls?.spotify ?? url };
    // Album track objects are the simplified shape - no ISRC, no popularity -
    // so they are re-fetched in full below alongside everything else.
    let items = album.tracks?.items ?? [];
    let next = album.tracks?.next;
    while (next) {
      const page = await request(next, auth, creds);
      items = items.concat(page.items ?? []);
      next = page.next;
      onProgress({ done: items.length, total: album.tracks?.total ?? null });
    }
    const ids = items.map((t) => t.id).filter(Boolean);
    for (const group of chunk(ids, 50)) {
      const full = await get(`/tracks?ids=${group.join(",")}`);
      rawTracks = rawTracks.concat((full.tracks ?? []).filter(Boolean));
      onProgress({ done: rawTracks.length, total: ids.length });
    }
  } else {
    const meta = await get(`/playlists/${link.id}?fields=name,external_urls,tracks(total)`);
    listMeta = { name: meta.name, url: meta.external_urls?.spotify ?? url };
    const total = meta.tracks?.total ?? null;

    let next = `${API}/playlists/${link.id}/tracks?limit=100&additional_types=track`;
    while (next) {
      const page = await request(next, auth, creds);
      for (const item of page.items ?? []) {
        const t = item?.track;
        // Local files and removed tracks come back as null or without an id;
        // they cannot be downloaded and must not occupy a track slot.
        if (t?.id && t.type !== "episode") rawTracks.push(t);
      }
      next = page.next;
      onProgress({ done: rawTracks.length, total });
    }
  }

  if (!rawTracks.length) {
    throw new SpotifyError(
      "That link contained no downloadable tracks. It may be empty, private, or contain only " +
        "local files or podcast episodes.",
      "missing",
    );
  }

  // Album details carry genres, label and copyright, which the track objects
  // omit. Batched 20 at a time, so a 116-track playlist costs a handful of
  // requests rather than one per track.
  const albumIds = [...new Set(rawTracks.map((t) => t.album?.id).filter(Boolean))];
  const albums = new Map();
  for (const group of chunk(albumIds, 20)) {
    try {
      const res = await get(`/albums?ids=${group.join(",")}`);
      for (const a of res.albums ?? []) if (a?.id) albums.set(a.id, a);
    } catch (err) {
      // Tags are worth having but not worth failing a download over.
      if (err instanceof SpotifyError && err.kind === "quota") throw err;
    }
  }

  // disc_count is per album, and only knowable once its tracks are grouped.
  const discMax = new Map();
  for (const t of rawTracks) {
    const id = t.album?.id;
    if (!id) continue;
    discMax.set(id, Math.max(discMax.get(id) ?? 1, t.disc_number ?? 1));
  }

  const total = rawTracks.length;
  return rawTracks.map((t, i) => {
    const album = albums.get(t.album?.id) ?? t.album ?? {};
    album.__disc_count = discMax.get(t.album?.id) ?? 1;
    return toSong(
      t,
      album,
      listMeta ? { ...listMeta, position: i + 1, length: total } : null,
    );
  });
}

/**
 * One cheap live probe for check_setup: are the credentials in use actually
 * accepted by Spotify right now?
 *
 * This exists because the first real remote failure happened on a machine
 * where nothing could be inspected, and check_setup - the tool whose whole job
 * is "tell me what is wrong" - never made a single Spotify call. It verified
 * the engines and stayed silent on the half of the system that actually fails
 * in the field: credentials and quota.
 *
 * Uses the search endpoint rather than a specific playlist so the result
 * reflects the credentials, not one playlist's visibility.
 */
export async function probeCredentials() {
  const creds = credentials();
  const which = creds.usingOwn
    ? "your own Spotify app from the extension settings"
    : "the built-in shared credentials (no Client ID set in the extension settings)";
  try {
    const token = await getToken(creds);
    const res = await request(
      `${API}/search?q=test&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
      creds,
    );
    if (res?.tracks) return { ok: true, line: `OK       spotify  reachable, using ${which}` };
    return { ok: true, line: `OK       spotify  token accepted, using ${which}` };
  } catch (err) {
    const msg = err instanceof SpotifyError ? err.message : String(err?.message ?? err);
    return {
      ok: false,
      line: `FAILED   spotify  using ${which}`,
      detail: msg,
    };
  }
}
