import { test, describe } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MusicCatalog, trackId, trackTitle, versionOf } from "./MusicCatalog.js";

// The catalog is what makes "adding music" a one-step job, so the behaviour worth pinning is
// what happens with a folder somebody has actually been using: files named by a human, files
// that are not music, and a folder that is not there at all.

// One folder for the whole file, laid out the way a real one is: files named by a
// human, something that is not music, and a directory that looks like a track.
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "cf-music-"));
fs.writeFileSync(path.join(folder, "Bill G Force.m4a"), "one");
fs.writeFileSync(path.join(folder, "aryx.m4a"), "two");
fs.writeFileSync(path.join(folder, "notes.txt"), "not music");
fs.mkdirSync(path.join(folder, "subfolder.m4a"));
process.on("exit", () => fs.rmSync(folder, { recursive: true, force: true }));

describe("MusicCatalog", () => {
  test("lists the audio files, and only those", () => {
    const tracks = new MusicCatalog(folder).build().tracks;
    assert.deepStrictEqual(
      tracks.map((t) => t.file),
      ["aryx.m4a", "Bill G Force.m4a"],
    );
  });

  test("keeps the human name as the title and derives a URL-safe id", () => {
    const track = new MusicCatalog(folder).build().tracks.find((t) => t.file.startsWith("Bill"))!;
    assert.strictEqual(track.title, "Bill G Force");
    assert.strictEqual(track.id, "bill-g-force");
  });

  test("gives every track a content hash and its size", () => {
    const tracks = new MusicCatalog(folder).build().tracks;
    for (const t of tracks) {
      assert.match(t.hash, /^[0-9a-f]{12}$/);
      assert.ok(t.bytes > 0);
    }
    // Different contents, different hashes - that is the whole point of them
    assert.notStrictEqual(tracks[0].hash, tracks[1].hash);
  });

  // build() must never read a file.  It used to: readFileSync plus a SHA-256 over every
  // track, on the first request, which on a Pi froze the whole box - every room, every
  // socket - for seconds after each restart.  warm() does that work in the background
  // instead, streaming each file so the event loop keeps breathing.
  test("serves a usable manifest before anything has been hashed", () => {
    const catalog = new MusicCatalog(folder);
    const tracks = catalog.build().tracks;
    for (const t of tracks) {
      assert.match(t.hash, /^[0-9a-f]{12}$/);
    }
    assert.notStrictEqual(tracks[0].hash, tracks[1].hash);
  });

  test("warm() upgrades the tokens to real content hashes", async () => {
    const catalog = new MusicCatalog(folder);
    const before = catalog.build().tracks.map((t) => t.hash);

    await catalog.warm();
    const after = catalog.build().tracks.map((t) => t.hash);

    // Same files, but now hashed by content rather than by (path, size, mtime)
    assert.notDeepStrictEqual(before, after);
    for (const hash of after) assert.match(hash, /^[0-9a-f]{12}$/);

    // A content hash is the same wherever the file is: a second catalog over the
    // same folder must agree, which is the reason to bother computing them at all.
    const other = new MusicCatalog(folder);
    await other.warm();
    assert.deepStrictEqual(
      other.build().tracks.map((t) => t.hash),
      after,
    );
  });

  test("warm() is stable when nothing has changed", async () => {
    const catalog = new MusicCatalog(folder);
    await catalog.warm();
    const first = catalog.build().tracks.map((t) => t.hash);
    await catalog.warm();
    assert.deepStrictEqual(
      catalog.build().tracks.map((t) => t.hash),
      first,
    );
  });

  test("warm() on a folder that is not there is not an error", async () => {
    const catalog = new MusicCatalog(path.join(folder, "nope"));
    await assert.doesNotReject(() => catalog.warm());
    assert.deepStrictEqual(catalog.build().tracks, []);
  });

  test("the hash follows the contents, so a replaced file busts the cache", () => {
    const catalog = new MusicCatalog(folder);
    const before = catalog.build().tracks.find((t) => t.file === "aryx.m4a")!.hash;

    const target = path.join(folder, "aryx.m4a");
    fs.writeFileSync(target, "completely different audio");
    // Force a different mtime - a same-second write would otherwise look unchanged
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(target, later, later);

    const after = catalog.build().tracks.find((t) => t.file === "aryx.m4a")!.hash;
    assert.notStrictEqual(after, before);
  });

  test("the collection version changes when the music does", () => {
    const one = versionOf([{ hash: "aaaaaa" }, { hash: "bbbbbb" }]);
    assert.strictEqual(one, versionOf([{ hash: "aaaaaa" }, { hash: "bbbbbb" }]));
    assert.notStrictEqual(one, versionOf([{ hash: "aaaaaa" }, { hash: "cccccc" }]));
    assert.notStrictEqual(one, versionOf([{ hash: "aaaaaa" }]));
    assert.strictEqual(versionOf([]), "empty");
  });

  test("a folder that is not there is a server with no music, not an error", () => {
    const manifest = new MusicCatalog(path.join(folder, "nope", "nothing")).build();
    assert.deepStrictEqual(manifest.tracks, []);
    assert.strictEqual(manifest.schema, 1);
  });
});

describe("track naming", () => {
  test("ids survive spaces, case and punctuation", () => {
    assert.strictEqual(trackId("CHIPPY Volume 1.m4a"), "chippy-volume-1");
    assert.strictEqual(trackId("cut and dried.m4a"), "cut-and-dried");
    assert.strictEqual(trackId("Beast-pl.m4a"), "beast-pl");
    assert.strictEqual(trackId("!!!.m4a"), "track");
  });

  test("titles are the filename as written, minus the extension", () => {
    assert.strictEqual(trackTitle("CHIPPY Volume 1.m4a"), "CHIPPY Volume 1");
    assert.strictEqual(trackTitle("no-extension"), "no-extension");
  });
});
