// ==========================================================================================
// YouTube search proxy.
//
// The phones never talk to googleapis directly.  Two reasons, and both matter:
//
//   1. The API key stays here.  A key shipped in the client bundle is a key anybody can lift
//      out of devtools and spend.
//   2. Quota.  A `search.list` call costs 100 units against a default daily quota of 10,000 —
//      one hundred searches a DAY for the whole server.  A party of eight all typing "taylor
//      swift" would otherwise be eight calls.  Caching across every room turns repeated
//      searches into one call, which is the difference between the feature working on a
//      Saturday night and not.
//
// The result shape is `Track[]`, consumed verbatim by RelayMusicProvider in
// clusterfun-client/src/games/PassTheAux/models/musicProvider.ts.  It is duplicated rather
// than shared because the two projects are separate repos — if you change this shape, change
// it there too.
// ==========================================================================================

import * as https from "https";

const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

// Mirrors the client's GameSettings.ts.  Kept here as well so a malformed request cannot make
// the server ask YouTube for more than it is willing to pay for.
export const MAX_SEARCH_RESULTS = 12;
export const MAX_QUERY_LEN = 120;

// Defaults documented in scripts/clusterfun_env.example; override with YT_CACHE_TTL_MS and
// YT_CACHE_MAX.  A day is a long TTL for a search index, but song results barely move and the
// quota is the binding constraint, not freshness.
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MAX = 500;

export interface Track {
  videoId: string;
  title: string;
  artist: string;
  thumbnailUrl: string;
  durationSec: number; // always 0 — search.list does not return durations
}

interface CacheEntry {
  tracks: Track[];
  expiresAt: number;
}

interface SearchLogger {
  logLine(text: string): void;
  logError(text: string): void;
}

// Deliberately NOT global fetch.  scripts/autorun.sh pins the Pi to node-v16.14.0, which has
// no global fetch at all — this would build here on a modern Node, pass its tests, and then
// throw on every search in production.  The built-in https module works on both.
export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpGet = (url: string) => Promise<HttpResponse>;

// A hung socket must not park a request forever; the phone would just sit there spinning.
const REQUEST_TIMEOUT_MS = 10000;

export interface YouTubeSearchOptions {
  apiKey?: string;
  ttlMs?: number;
  maxEntries?: number;
  httpGet?: HttpGet;
  now?: () => number;
  logger?: SearchLogger;
}

// YouTube returns snippet text HTML-escaped ("Rock &amp; Roll", "Don&#39;t Stop").  The client
// renders it as plain text, so undo that here rather than in every view.
const ENTITY_PATTERN = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(text: string): string {
  if (!text) return "";
  return text.replace(ENTITY_PATTERN, (whole, dec, hex, name) => {
    if (dec !== undefined) return safeFromCodePoint(Number.parseInt(dec, 10), whole);
    if (hex !== undefined) return safeFromCodePoint(Number.parseInt(hex, 16), whole);
    const mapped = NAMED_ENTITIES[String(name).toLowerCase()];
    return mapped === undefined ? whole : mapped;
  });
}

// An out-of-range code point would throw out of String.fromCodePoint and take the whole search
// down over one bad character, so leave anything unconvertible as it was.
function safeFromCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

// The cache key: what makes "Taylor Swift" and "  taylor swift " the same search, which is the
// whole point of caching across rooms.
export function normalizeQuery(rawQuery: string | undefined | null): string {
  return (rawQuery ?? "").trim().slice(0, MAX_QUERY_LEN).replace(/\s+/g, " ").trim();
}

export class YouTubeSearch {
  private readonly apiKey: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly httpGet: HttpGet;
  private readonly now: () => number;
  private readonly logger?: SearchLogger;

  // Insertion-ordered, so the oldest key is simply the first one — that is the LRU.
  private readonly cache = new Map<string, CacheEntry>();
  // Two phones typing the same thing at the same moment must cost one upstream call, not two.
  private readonly inFlight = new Map<string, Promise<Track[]>>();
  private warnedAboutMissingKey = false;

  constructor(options: YouTubeSearchOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.YOUTUBE_API_KEY ?? "";
    this.ttlMs = options.ttlMs ?? numberFromEnv("YT_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
    this.maxEntries = options.maxEntries ?? numberFromEnv("YT_CACHE_MAX", DEFAULT_CACHE_MAX);
    this.httpGet = options.httpGet ?? httpsGet;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  get hasApiKey(): boolean {
    return !!this.apiKey;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache() {
    this.cache.clear();
  }

  //--------------------------------------------------------------------------------------
  // Search, with the cache in front of it.  An empty query and a missing key both return an
  // empty list rather than throwing: the phone shows "no results", which is a far better
  // failure than a red error in the middle of a party.
  //--------------------------------------------------------------------------------------
  async search(rawQuery: string | undefined | null): Promise<Track[]> {
    const query = normalizeQuery(rawQuery);
    if (!query) return [];

    const key = query.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expiresAt > this.now()) {
        // Re-insert to move it to the young end of the LRU.
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.tracks;
      }
      this.cache.delete(key);
    }

    if (!this.apiKey) {
      if (!this.warnedAboutMissingKey) {
        this.warnedAboutMissingKey = true;
        this.logger?.logError(
          "YOUTUBE_API_KEY is not set - /api/youtube_search will return no results. " +
            "See scripts/clusterfun_env.example.",
        );
      }
      return [];
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    // Note the in-flight entry is cleared on BOTH paths: leaving a rejected promise parked
    // there would make one transient failure permanent for that search term.
    const pending = this.fetchFromYouTube(query).then(
      (tracks) => {
        this.inFlight.delete(key);
        this.remember(key, tracks);
        return tracks;
      },
      (err) => {
        this.inFlight.delete(key);
        throw err;
      },
    );

    this.inFlight.set(key, pending);
    return pending;
  }

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  private remember(key: string, tracks: Track[]) {
    this.cache.set(key, { tracks, expiresAt: this.now() + this.ttlMs });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  //--------------------------------------------------------------------------------------
  // videoEmbeddable=true is not optional: the client plays these through the YouTube IFrame
  // player, and a video that refuses embedding is a track that silently plays nothing.
  //--------------------------------------------------------------------------------------
  private async fetchFromYouTube(query: string): Promise<Track[]> {
    const url = new URL(YOUTUBE_SEARCH_URL);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("videoEmbeddable", "true");
    url.searchParams.set("safeSearch", "moderate");
    url.searchParams.set("maxResults", String(MAX_SEARCH_RESULTS));
    url.searchParams.set("q", query);
    url.searchParams.set("key", this.apiKey);

    const response = await this.httpGet(url.toString());
    if (response.status < 200 || response.status >= 300) {
      // The body carries the real reason (quotaExceeded, keyInvalid, ...) and is worth having
      // in the log, but it must never reach the client — it can echo the key back.
      this.logger?.logError(
        `YouTube search failed (${response.status}): ${response.body.slice(0, 500)}`,
      );
      throw new Error(`YouTube search failed with status ${response.status}`);
    }

    let data: any;
    try {
      data = JSON.parse(response.body);
    } catch (err) {
      this.logger?.logError(`YouTube search returned unparseable JSON: ${err}`);
      throw new Error("YouTube search returned an unreadable response");
    }
    return toTracks(data);
  }
}

//--------------------------------------------------------------------------------------
// Anything unexpected in the response yields no track rather than a crash; one malformed
// item should not lose the other eleven.
//--------------------------------------------------------------------------------------
export function toTracks(data: any): Track[] {
  const items = Array.isArray(data?.items) ? data.items : [];
  const tracks: Track[] = [];
  for (const item of items) {
    const videoId = item?.id?.videoId;
    if (typeof videoId !== "string" || !videoId) continue;
    const snippet = item?.snippet ?? {};
    const thumbnails = snippet.thumbnails ?? {};
    tracks.push({
      videoId,
      title: decodeHtmlEntities(String(snippet.title ?? "")),
      artist: decodeHtmlEntities(String(snippet.channelTitle ?? "")),
      thumbnailUrl: thumbnails.medium?.url ?? thumbnails.default?.url ?? thumbnails.high?.url ?? "",
      durationSec: 0,
    });
    if (tracks.length >= MAX_SEARCH_RESULTS) break;
  }
  return tracks;
}

//--------------------------------------------------------------------------------------
// The default transport: plain https.get, because the Pi is on Node 16 (see the note by
// HttpGet).  Non-2xx is returned rather than thrown — the caller wants the status and the
// body to log.
//--------------------------------------------------------------------------------------
const httpsGet: HttpGet = (url) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const request = https.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("error", reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`YouTube search timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
  });

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
