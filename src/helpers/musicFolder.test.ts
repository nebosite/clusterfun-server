import { test, describe } from "node:test";
import assert from "node:assert";
import * as path from "path";
import * as os from "os";
import { defaultMusicFolder, musicCacheControl, MUSIC_MANIFEST_NAME } from "./musicFolder.js";

describe("music folder", () => {
  test("defaults to ~/music, next to the app rather than inside the deploy", () => {
    const saved = process.env.CLUSTERFUN_MUSIC_PATH;
    delete process.env.CLUSTERFUN_MUSIC_PATH;
    try {
      assert.strictEqual(defaultMusicFolder(), path.join(os.homedir(), "music"));
    } finally {
      if (saved !== undefined) process.env.CLUSTERFUN_MUSIC_PATH = saved;
    }
  });

  test("can be pointed somewhere else for a dev box", () => {
    const saved = process.env.CLUSTERFUN_MUSIC_PATH;
    process.env.CLUSTERFUN_MUSIC_PATH = path.join("C:", "temp", "music");
    try {
      assert.strictEqual(defaultMusicFolder(), path.join("C:", "temp", "music"));
    } finally {
      if (saved === undefined) delete process.env.CLUSTERFUN_MUSIC_PATH;
      else process.env.CLUSTERFUN_MUSIC_PATH = saved;
    }
  });
});

describe("music cache headers", () => {
  // The whole replace-a-track-without-a-deploy design rests on these two lines: tracks are
  // immutable because their name carries a content hash, and the manifest is the one thing
  // that changes in place.  Cache the manifest and a replacement never reaches anybody.
  test("the manifest is always re-validated", () => {
    assert.strictEqual(musicCacheControl("/home/pi/music/music.json"), "no-cache");
    assert.strictEqual(musicCacheControl(MUSIC_MANIFEST_NAME), "no-cache");
    assert.strictEqual(musicCacheControl("C:\\music\\MUSIC.JSON"), "no-cache");
  });

  test("tracks are cached for a year, because their names are content-addressed", () => {
    const forever = "public, max-age=31536000, immutable";
    assert.strictEqual(musicCacheControl("/home/pi/music/tracks/main.a91f3c.m4a"), forever);
    assert.strictEqual(musicCacheControl("tracks/anything.else"), forever);
  });

  test("a file merely named like the manifest deeper in the tree is still the manifest", () => {
    // basename, not a path match - a manifest is a manifest wherever it sits
    assert.strictEqual(musicCacheControl("tracks/sub/music.json"), "no-cache");
  });
});
