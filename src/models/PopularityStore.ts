import fs from "fs";
import path from "path";
import os from "os";

// ==========================================================================================
// PopularityStore - how often each game actually gets played, over time.
//
// This is ClusterFun's own counting, deliberately separate from Google Analytics: the lobby
// sorts its game list by these numbers, so they have to be available to the server that
// serves the lobby, without depending on a third party being reachable or on anyone holding
// a GA login.
//
// Counts are kept in daily buckets so "popularity" can mean "lately" rather than "ever".
// A game that was huge last spring should not outrank the one everybody is playing now, so
// the sort score decays with a half-life (see `score`).
//
// Durability matters more than precision here: the whole thing lives on a Raspberry Pi
// under a desk that will lose power one day.  Writes are atomic (temp file + rename) and
// debounced, and the file lives OUTSIDE the deploy directory - `deployit.sh` deletes and
// replaces that wholesale on every deploy.
// ==========================================================================================

export const POPULARITY_SCHEMA = 1;
// Daily buckets older than this are folded into the all-time totals and dropped
export const RETAIN_DAYS = 400;
// A play counts half as much toward the sort order after this long
export const SCORE_HALF_LIFE_DAYS = 30;
// Never write more often than this, however busy the server is
export const FLUSH_INTERVAL_MS = 5000;

export interface GameDayCounts {
  plays: number;
  players: number;
}

export interface GameTotals {
  plays: number;
  players: number;
  lastPlayed: number;
}

interface PopularityFile {
  schema: number;
  totals: Record<string, GameTotals>;
  days: Record<string, Record<string, GameDayCounts>>;
}

// What the lobby gets back for each game
export interface GamePopularity {
  plays: number; // all-time starts
  players: number; // all-time players across those starts
  recentPlays: number; // starts in the last 30 days
  lastPlayed: number; // epoch ms, 0 if never
  score: number; // recency-weighted, for sorting
}

function emptyFile(): PopularityFile {
  return { schema: POPULARITY_SCHEMA, totals: {}, days: {} };
}

// YYYY-MM-DD in UTC, so a server that moves timezone does not reshuffle history
export function dayKey(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

function daysBetween(fromDay: string, toMs: number): number {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  if (Number.isNaN(from)) return 0;
  return Math.max(0, (toMs - from) / 86400000);
}

// Where the data lives.  Explicitly outside the deploy folder, which is deleted
// and recreated by every deploy.
export function defaultPopularityPath(): string {
  return (
    process.env.CLUSTERFUN_ANALYTICS_PATH ?? path.join(os.homedir(), "analytics", "popularity.json")
  );
}

export class PopularityStore {
  private data: PopularityFile = emptyFile();
  private dirty = false;
  private lastWriteMs = 0;
  private flushTimer?: NodeJS.Timeout;

  // An empty filePath means "keep the counts in memory and never touch disk".
  // That is the default so that merely constructing a ServerModel - which every
  // test does - cannot write into somebody's home directory.  The real server
  // passes a path explicitly (see clusterfun_server_main.ts).
  constructor(
    private readonly filePath: string = "",
    private readonly now: () => number = () => Date.now(),
    private readonly log: (line: string) => void = () => {},
  ) {}

  get isPersistent() {
    return !!this.filePath;
  }

  // -------------------------------------------------------------------
  // load - read what we had.  A missing file is normal (first run); a
  // corrupt one is survivable, and losing counts must never stop the server
  // from serving games.
  // -------------------------------------------------------------------
  load() {
    if (!this.filePath) return;
    try {
      if (!fs.existsSync(this.filePath)) {
        this.data = emptyFile();
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PopularityFile;
      if (!parsed || parsed.schema !== POPULARITY_SCHEMA || typeof parsed.days !== "object") {
        this.log(`Popularity file has an unusable shape; starting fresh`);
        this.data = emptyFile();
        return;
      }
      this.data = { schema: POPULARITY_SCHEMA, totals: parsed.totals ?? {}, days: parsed.days };
      this.prune();
    } catch (err) {
      this.log(`Could not read popularity data (${err}); starting fresh`);
      this.data = emptyFile();
    }
  }

  // -------------------------------------------------------------------
  // recordPlay / recordJoin - the two things worth counting.  A "play" is a
  // room being opened for a game; "joins" are how many people turned up,
  // which is what tells a 12-player hit apart from a game one person opens
  // and abandons.
  // -------------------------------------------------------------------
  recordPlay(gameName: string) {
    if (!gameName) return;
    this.bump(gameName, (day) => day.plays++);
    const totals = this.totalsFor(gameName);
    totals.plays++;
    totals.lastPlayed = this.now();
  }

  recordJoin(gameName: string) {
    if (!gameName) return;
    this.bump(gameName, (day) => day.players++);
    this.totalsFor(gameName).players++;
  }

  private totalsFor(gameName: string): GameTotals {
    let totals = this.data.totals[gameName];
    if (!totals) {
      totals = { plays: 0, players: 0, lastPlayed: 0 };
      this.data.totals[gameName] = totals;
    }
    return totals;
  }

  private bump(gameName: string, change: (day: GameDayCounts) => void) {
    const key = dayKey(this.now());
    const byDay = (this.data.days[gameName] ??= {});
    const day = (byDay[key] ??= { plays: 0, players: 0 });
    change(day);
    this.dirty = true;
    this.scheduleFlush();
  }

  // -------------------------------------------------------------------
  // report - what the lobby asks for
  // -------------------------------------------------------------------
  report(): Record<string, GamePopularity> {
    const now = this.now();
    const out: Record<string, GamePopularity> = {};
    const games = new Set([...Object.keys(this.data.totals), ...Object.keys(this.data.days)]);
    for (const game of games) {
      const totals = this.data.totals[game] ?? { plays: 0, players: 0, lastPlayed: 0 };
      const byDay = this.data.days[game] ?? {};
      let recentPlays = 0;
      let score = 0;
      for (const [day, counts] of Object.entries(byDay)) {
        const age = daysBetween(day, now);
        if (age <= 30) recentPlays += counts.plays;
        // Half-life decay: a play is worth 1 today, 0.5 a month ago, 0.25 two
        // months ago.  Summed, this is the sort order.
        score += counts.plays * Math.pow(0.5, age / SCORE_HALF_LIFE_DAYS);
      }
      out[game] = {
        plays: totals.plays,
        players: totals.players,
        recentPlays,
        lastPlayed: totals.lastPlayed,
        score: Math.round(score * 1000) / 1000,
      };
    }
    return out;
  }

  // -------------------------------------------------------------------
  // prune - fold buckets older than RETAIN_DAYS away.  The all-time totals
  // already hold them, so nothing is lost except the day-by-day detail.
  // -------------------------------------------------------------------
  private prune() {
    const now = this.now();
    for (const [game, byDay] of Object.entries(this.data.days)) {
      for (const day of Object.keys(byDay)) {
        if (daysBetween(day, now) > RETAIN_DAYS) {
          delete byDay[day];
          this.dirty = true;
        }
      }
      if (Object.keys(byDay).length === 0) delete this.data.days[game];
    }
  }

  // -------------------------------------------------------------------
  // Writing.  Debounced, because a busy evening would otherwise rewrite the
  // file on every join.
  // -------------------------------------------------------------------
  private scheduleFlush() {
    if (!this.filePath || this.flushTimer) return;
    const sinceLast = this.now() - this.lastWriteMs;
    const wait = Math.max(0, FLUSH_INTERVAL_MS - sinceLast);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, wait);
    // Never hold the process open just to write a counter file
    this.flushTimer.unref?.();
  }

  // Write now.  Atomic: a half-written file after a power cut would be worse
  // than a slightly stale one.
  flush() {
    if (!this.filePath || !this.dirty) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.data), "utf8");
      fs.renameSync(temp, this.filePath);
      this.dirty = false;
      this.lastWriteMs = this.now();
    } catch (err) {
      this.log(`Could not write popularity data: ${err}`);
    }
  }

  // Stop the pending write timer (tests, and a clean shutdown)
  stop() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}
