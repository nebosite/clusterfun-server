import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { PopularityStore, dayKey, RETAIN_DAYS } from "./PopularityStore.js";

// PopularityStore is what the lobby sorts by, so the properties that matter are:
// it counts the right things, recent play outranks old play, it survives a
// restart, and a damaged file never takes the server down with it.

const DAY_MS = 86400000;
const tempDirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-pop-"));
  tempDirs.push(dir);
  return path.join(dir, "nested", "popularity.json");
}

// node:test's typings here have no afterEach, so clean up on the way out.
// These are directories under the OS temp dir either way.
process.on("exit", () => {
  while (tempDirs.length) {
    try {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* a temp dir we could not remove is not worth failing a test run over */
    }
  }
});

// A store with a clock we control, so decay is testable without waiting a month
function storeAt(file: string, clock: { now: number }) {
  const store = new PopularityStore(file, () => clock.now);
  store.load();
  return store;
}

describe("PopularityStore - counting", () => {
  it("counts plays and players per game", () => {
    const clock = { now: Date.UTC(2026, 6, 29) };
    const store = storeAt(tempFile(), clock);

    store.recordPlay("Eittris");
    store.recordPlay("Eittris");
    store.recordJoin("Eittris");
    store.recordJoin("Eittris");
    store.recordJoin("Eittris");
    store.recordPlay("Lexible");

    const report = store.report();
    assert.equal(report["Eittris"].plays, 2);
    assert.equal(report["Eittris"].players, 3);
    assert.equal(report["Lexible"].plays, 1);
    assert.equal(report["Lexible"].players, 0);
    store.stop();
  });

  it("remembers when a game was last played", () => {
    const clock = { now: Date.UTC(2026, 6, 29, 12) };
    const store = storeAt(tempFile(), clock);
    store.recordPlay("Eittris");
    assert.equal(store.report()["Eittris"].lastPlayed, clock.now);
    store.stop();
  });

  it("reports nothing for a game nobody has played", () => {
    const store = storeAt(tempFile(), { now: Date.now() });
    assert.deepEqual(store.report(), {});
    store.stop();
  });

  it("ignores a blank game name rather than making a phantom entry", () => {
    const store = storeAt(tempFile(), { now: Date.now() });
    store.recordPlay("");
    assert.deepEqual(store.report(), {});
    store.stop();
  });
});

describe("PopularityStore - recent play outranks old play", () => {
  it("decays a play by half over the half-life", () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    const store = storeAt(tempFile(), clock);

    store.recordPlay("OldFavourite");
    clock.now += 30 * DAY_MS; // one half-life later
    store.recordPlay("NewHotness");

    const report = store.report();
    // The old play is worth about half of the fresh one
    assert.ok(report["NewHotness"].score > report["OldFavourite"].score);
    assert.ok(Math.abs(report["OldFavourite"].score - 0.5) < 0.01);
    assert.ok(Math.abs(report["NewHotness"].score - 1) < 0.01);
    store.stop();
  });

  it("lets a game played a lot last year lose to one played twice this week", () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    const store = storeAt(tempFile(), clock);
    for (let i = 0; i < 20; i++) store.recordPlay("LastYearsHit");

    clock.now += 300 * DAY_MS;
    store.recordPlay("ThisWeek");
    store.recordPlay("ThisWeek");

    const report = store.report();
    assert.ok(report["LastYearsHit"].plays > report["ThisWeek"].plays); // all-time still says otherwise
    assert.ok(report["ThisWeek"].score > report["LastYearsHit"].score); // but the sort order is current
    store.stop();
  });

  it("counts only the last 30 days as recent", () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    const store = storeAt(tempFile(), clock);
    store.recordPlay("Eittris");
    clock.now += 40 * DAY_MS;
    store.recordPlay("Eittris");

    const report = store.report();
    assert.equal(report["Eittris"].plays, 2);
    assert.equal(report["Eittris"].recentPlays, 1);
    store.stop();
  });
});

describe("PopularityStore - surviving restarts", () => {
  it("writes and reads back its counts, creating the folder if needed", () => {
    const file = tempFile();
    const clock = { now: Date.UTC(2026, 6, 29) };
    const store = storeAt(file, clock);
    store.recordPlay("Eittris");
    store.recordJoin("Eittris");
    store.flush();
    store.stop();

    assert.ok(fs.existsSync(file), "the data file should exist after a flush");

    const reloaded = storeAt(file, clock);
    const report = reloaded.report();
    assert.equal(report["Eittris"].plays, 1);
    assert.equal(report["Eittris"].players, 1);
    reloaded.stop();
  });

  it("leaves no half-written file behind - the write is atomic", () => {
    const file = tempFile();
    const store = storeAt(file, { now: Date.now() });
    store.recordPlay("Eittris");
    store.flush();
    store.stop();
    assert.ok(!fs.existsSync(`${file}.tmp`), "the temp file should have been renamed away");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schema, 1);
  });

  it("starts fresh, and keeps serving, when the file is corrupt", () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json", "utf8");

    const store = storeAt(file, { now: Date.now() });
    assert.deepEqual(store.report(), {});
    store.recordPlay("Eittris"); // and it still works afterwards
    assert.equal(store.report()["Eittris"].plays, 1);
    store.stop();
  });

  it("starts fresh when the file is from a future schema", () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 99, days: {}, totals: {} }), "utf8");
    const store = storeAt(file, { now: Date.now() });
    assert.deepEqual(store.report(), {});
    store.stop();
  });

  it("treats a missing file as an empty history", () => {
    const store = storeAt(tempFile(), { now: Date.now() });
    assert.deepEqual(store.report(), {});
    store.stop();
  });
});

describe("PopularityStore - pruning", () => {
  it("drops ancient daily buckets but keeps the all-time totals", () => {
    const file = tempFile();
    const clock = { now: Date.UTC(2020, 0, 1) };
    const store = storeAt(file, clock);
    store.recordPlay("Ancient");
    store.recordJoin("Ancient");
    store.flush();
    store.stop();

    // Come back long after the retention window
    clock.now = Date.UTC(2020, 0, 1) + (RETAIN_DAYS + 10) * DAY_MS;
    const reloaded = storeAt(file, clock);
    const report = reloaded.report();
    assert.equal(report["Ancient"].plays, 1, "all-time totals survive pruning");
    assert.equal(report["Ancient"].players, 1);
    assert.equal(report["Ancient"].score, 0, "but it no longer counts toward the sort order");
    reloaded.stop();
  });
});

describe("dayKey", () => {
  it("buckets by UTC date, so the server's timezone cannot reshuffle history", () => {
    assert.equal(dayKey(Date.UTC(2026, 6, 29, 23, 59)), "2026-07-29");
    assert.equal(dayKey(Date.UTC(2026, 6, 30, 0, 1)), "2026-07-30");
  });
});
