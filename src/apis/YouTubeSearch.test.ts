import { test, describe } from "node:test";
import assert from "node:assert";
import {
  YouTubeSearch,
  decodeHtmlEntities,
  normalizeQuery,
  toTracks,
  MAX_SEARCH_RESULTS,
  MAX_QUERY_LEN,
  FetchLike,
} from "./YouTubeSearch.js";

// A fake fetch that records the URLs it was asked for and hands back canned responses.
function fakeFetch(responses: Array<{ ok?: boolean; status?: number; body?: any }>) {
  const calls: string[] = [];
  let index = 0;
  const impl: FetchLike = async (url) => {
    calls.push(String(url));
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body ?? {},
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  return { impl, calls, callCount: () => index };
}

function item(videoId: string, title: string, channelTitle = "A Channel", thumbs?: any) {
  return {
    id: { videoId },
    snippet: {
      title,
      channelTitle,
      thumbnails: thumbs ?? { medium: { url: `https://img/${videoId}.jpg` } },
    },
  };
}

describe("query normalization", () => {
  test("collapses whitespace and case so one search serves the whole party", () => {
    assert.strictEqual(normalizeQuery("  Taylor   Swift "), "Taylor Swift");
  });

  test("clamps to MAX_QUERY_LEN, because the client does and the quota is ours to protect", () => {
    const long = "a".repeat(MAX_QUERY_LEN + 50);
    assert.strictEqual(normalizeQuery(long).length, MAX_QUERY_LEN);
  });

  test("null and undefined are empty, not a crash", () => {
    assert.strictEqual(normalizeQuery(undefined), "");
    assert.strictEqual(normalizeQuery(null), "");
  });
});

describe("HTML entity decoding", () => {
  // YouTube snippets arrive escaped; the phone renders them as plain text.
  test("decodes the named entities YouTube actually emits", () => {
    assert.strictEqual(decodeHtmlEntities("Rock &amp; Roll"), "Rock & Roll");
    assert.strictEqual(decodeHtmlEntities("&quot;Hello&quot;"), '"Hello"');
    assert.strictEqual(decodeHtmlEntities("a &lt; b &gt; c"), "a < b > c");
  });

  test("decodes numeric and hex references", () => {
    assert.strictEqual(decodeHtmlEntities("Don&#39;t Stop"), "Don't Stop");
    assert.strictEqual(decodeHtmlEntities("Don&#x27;t Stop"), "Don't Stop");
  });

  test("leaves an unknown or out-of-range entity alone rather than throwing", () => {
    assert.strictEqual(decodeHtmlEntities("&bogus; &#999999999;"), "&bogus; &#999999999;");
  });
});

describe("response mapping", () => {
  test("maps a snippet to a Track, with duration 0 because search.list has none", () => {
    const tracks = toTracks({ items: [item("abc12345678", "Midnight &amp; Highway", "Neon")] });
    assert.deepStrictEqual(tracks, [
      {
        videoId: "abc12345678",
        title: "Midnight & Highway",
        artist: "Neon",
        thumbnailUrl: "https://img/abc12345678.jpg",
        durationSec: 0,
      },
    ]);
  });

  test("falls back through thumbnail sizes, then to an empty string", () => {
    assert.strictEqual(
      toTracks({ items: [item("v1", "t", "c", { default: { url: "d.jpg" } })] })[0].thumbnailUrl,
      "d.jpg",
    );
    assert.strictEqual(toTracks({ items: [item("v2", "t", "c", {})] })[0].thumbnailUrl, "");
  });

  test("skips items with no videoId instead of losing the whole page", () => {
    const tracks = toTracks({
      items: [{ id: { kind: "youtube#channel" } }, item("keeper", "Keep Me")],
    });
    assert.strictEqual(tracks.length, 1);
    assert.strictEqual(tracks[0].videoId, "keeper");
  });

  test("a malformed body yields no tracks rather than an exception", () => {
    assert.deepStrictEqual(toTracks(undefined), []);
    assert.deepStrictEqual(toTracks({ items: "nope" }), []);
    assert.deepStrictEqual(toTracks({ items: [null, 7] }), []);
  });

  test("never returns more than MAX_SEARCH_RESULTS", () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`v${i}`, `t${i}`));
    assert.strictEqual(toTracks({ items }).length, MAX_SEARCH_RESULTS);
  });
});

describe("search behaviour", () => {
  test("an empty query costs no quota at all", async () => {
    const f = fakeFetch([{ body: { items: [] } }]);
    const search = new YouTubeSearch({ apiKey: "k", fetchImpl: f.impl });
    assert.deepStrictEqual(await search.search("   "), []);
    assert.strictEqual(f.callCount(), 0);
  });

  test("with no API key it returns nothing and never calls out", async () => {
    const f = fakeFetch([{ body: { items: [item("v", "t")] } }]);
    const errors: string[] = [];
    const search = new YouTubeSearch({
      apiKey: "",
      fetchImpl: f.impl,
      logger: { logLine: () => {}, logError: (t) => errors.push(t) },
    });
    assert.deepStrictEqual(await search.search("anything"), []);
    assert.strictEqual(f.callCount(), 0);
    assert.strictEqual(errors.length, 1, "should say why, once");
    await search.search("anything else");
    assert.strictEqual(errors.length, 1, "and not once per search");
  });

  test("asks YouTube for embeddable videos only - the client plays these in an IFrame", async () => {
    const f = fakeFetch([{ body: { items: [item("v", "t")] } }]);
    await new YouTubeSearch({ apiKey: "secret-key", fetchImpl: f.impl }).search("hello world");
    const url = new URL(f.calls[0]);
    assert.strictEqual(url.searchParams.get("videoEmbeddable"), "true");
    assert.strictEqual(url.searchParams.get("type"), "video");
    assert.strictEqual(url.searchParams.get("part"), "snippet");
    assert.strictEqual(url.searchParams.get("q"), "hello world");
    assert.strictEqual(url.searchParams.get("key"), "secret-key");
    assert.strictEqual(url.searchParams.get("maxResults"), String(MAX_SEARCH_RESULTS));
  });

  test("an upstream failure throws without leaking the body - it can echo the key", async () => {
    const f = fakeFetch([{ ok: false, status: 403, body: { error: "quotaExceeded key=abc" } }]);
    const errors: string[] = [];
    const search = new YouTubeSearch({
      apiKey: "k",
      fetchImpl: f.impl,
      logger: { logLine: () => {}, logError: (t) => errors.push(t) },
    });
    const thrown = await search.search("x").then(
      () => undefined,
      (err) => err as Error,
    );
    assert.ok(thrown, "should have thrown");
    assert.match(thrown!.message, /status 403/);
    assert.doesNotMatch(thrown!.message, /quotaExceeded/, "the body must not reach the client");
    assert.ok(
      errors.some((e) => /quotaExceeded/.test(e)),
      "the detail belongs in the log",
    );
  });

  test("a failed search is not cached, so the next attempt tries again", async () => {
    const f = fakeFetch([
      { ok: false, status: 500 },
      { ok: true, body: { items: [item("v", "t")] } },
    ]);
    const search = new YouTubeSearch({ apiKey: "k", fetchImpl: f.impl });
    await assert.rejects(() => search.search("x"));
    assert.strictEqual((await search.search("x")).length, 1);
    assert.strictEqual(f.callCount(), 2);
  });
});

describe("caching - the reason this proxy exists", () => {
  test("a repeated search costs one call, not two", async () => {
    const f = fakeFetch([{ body: { items: [item("v", "t")] } }]);
    const search = new YouTubeSearch({ apiKey: "k", fetchImpl: f.impl });
    await search.search("taylor swift");
    await search.search("  TAYLOR   SWIFT ");
    assert.strictEqual(f.callCount(), 1, "case and spacing must not miss the cache");
  });

  test("concurrent identical searches share one upstream call", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const impl: FetchLike = async () => {
      calls++;
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [item("v", "t")] }),
        text: async () => "",
      };
    };

    const search = new YouTubeSearch({ apiKey: "k", fetchImpl: impl });
    const both = Promise.all([search.search("same"), search.search("same")]);
    release();
    const [a, b] = await both;
    assert.strictEqual(calls, 1, "eight phones typing at once is still one call");
    assert.deepStrictEqual(a, b);
  });

  test("an entry past its TTL is refetched", async () => {
    let clock = 1000;
    const f = fakeFetch([{ body: { items: [item("v", "t")] } }]);
    const search = new YouTubeSearch({
      apiKey: "k",
      fetchImpl: f.impl,
      ttlMs: 100,
      now: () => clock,
    });
    await search.search("x");
    clock += 50;
    await search.search("x");
    assert.strictEqual(f.callCount(), 1, "still fresh");
    clock += 100;
    await search.search("x");
    assert.strictEqual(f.callCount(), 2, "expired, so ask again");
  });

  test("the cache is capped, evicting least-recently-used first", async () => {
    const f = fakeFetch([{ body: { items: [item("v", "t")] } }]);
    const search = new YouTubeSearch({ apiKey: "k", fetchImpl: f.impl, maxEntries: 2 });
    await search.search("one");
    await search.search("two");
    await search.search("one"); // touch "one" so "two" becomes the oldest
    await search.search("three");
    assert.strictEqual(search.cacheSize, 2);

    const before = f.callCount();
    await search.search("one");
    assert.strictEqual(f.callCount(), before, "'one' was touched, so it survived");
    await search.search("two");
    assert.strictEqual(f.callCount(), before + 1, "'two' was evicted, so it costs a call");
  });
});
