import { test, describe } from "node:test";
import assert from "node:assert";
import * as path from "path";
import * as os from "os";
import { defaultMusicFolder, musicCacheControl, MUSIC_MANIFEST_NAME } from "./musicFolder.js";

// Run a check with CLUSTERFUN_MUSIC_PATH set to something, or to nothing, and put the
// environment back afterwards whichever way it goes.
function withMusicPath(value: string | undefined, check: () => void) {
  const saved = process.env.CLUSTERFUN_MUSIC_PATH;
  if (value === undefined) delete process.env.CLUSTERFUN_MUSIC_PATH;
  else process.env.CLUSTERFUN_MUSIC_PATH = value;
  try {
    check();
  } finally {
    if (saved === undefined) delete process.env.CLUSTERFUN_MUSIC_PATH;
    else process.env.CLUSTERFUN_MUSIC_PATH = saved;
  }
}

describe("music folder", () => {
  test("defaults to hosted_content/music inside the app, so it ships with the deploy", () => {
    withMusicPath(undefined, () =>
      assert.strictEqual(
        defaultMusicFolder("/srv/clusterfun"),
        path.join("/srv/clusterfun", "hosted_content", "music"),
      ),
    );
  });

  test("a relative override is relative to the app, which is how dev finds the repo copy", () => {
    const appRoot = path.join("/repo", "clusterfun-server", "src");
    withMusicPath("../hosted_content/music", () =>
      assert.strictEqual(
        defaultMusicFolder(appRoot),
        // path.resolve, not join: on Windows it stamps the current drive onto a
        // rooted path, and the expectation has to do the same to match.
        path.resolve(path.join("/repo", "clusterfun-server", "hosted_content", "music")),
      ),
    );
  });

  test("an absolute override wins outright", () => {
    const elsewhere = path.resolve(path.join("/mnt", "bigdisk", "music"));
    withMusicPath(elsewhere, () =>
      assert.strictEqual(defaultMusicFolder("/srv/clusterfun"), elsewhere),
    );
  });

  test("with no app root at all it falls back to the home directory", () => {
    withMusicPath(undefined, () =>
      assert.strictEqual(defaultMusicFolder(), path.join(os.homedir(), "hosted_content", "music")),
    );
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
