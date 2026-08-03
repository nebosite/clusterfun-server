import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ==========================================================================================
// MusicCatalog - turns a folder of audio files into the manifest the client reads.
//
// The manifest is generated rather than hand-written so that adding music is exactly one
// step: drop a file in the folder.  There is no second thing to remember, and therefore
// nothing that can drift out of sync with what is actually on disk.
//
// Each track carries a content hash.  The client puts that in the track's URL, which is what
// lets the audio be cached forever and still be replaceable: change the file and the hash
// changes, so the URL changes, so every browser fetches the new bytes.  Hashes are computed
// once and remembered against (size, mtime), so a restart costs one pass over the folder and
// a request costs nothing.
// ==========================================================================================

export const MUSIC_SCHEMA_VERSION = 1;

/** What we are willing to call music.  Everything else in the folder is ignored. */
const AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".ogg", ".oga", ".opus", ".wav", ".aac"]);

export interface CatalogTrack {
  id: string;
  file: string;
  title: string;
  hash: string;
  bytes: number;
}

export interface MusicManifest {
  schema: number;
  version: string;
  tracks: CatalogTrack[];
}

interface HashEntry {
  size: number;
  mtimeMs: number;
  hash: string;
}

export class MusicCatalog {
  private readonly folder: string;
  private readonly hashes = new Map<string, HashEntry>();

  constructor(folder: string) {
    this.folder = folder;
  }

  get musicFolder(): string {
    return this.folder;
  }

  /**
   * The manifest for whatever is in the folder right now.  A missing or unreadable folder is
   * not an error - it is a server with no music, and the client treats an empty track list
   * exactly as it treats no music at all.
   */
  build(): MusicManifest {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.folder);
    } catch {
      return { schema: MUSIC_SCHEMA_VERSION, version: "empty", tracks: [] };
    }

    const tracks: CatalogTrack[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const full = path.join(this.folder, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const hash = this.hashFor(full, stat);
      if (!hash) continue;
      tracks.push({
        id: trackId(name),
        file: name,
        title: trackTitle(name),
        hash,
        bytes: stat.size,
      });
    }

    return { schema: MUSIC_SCHEMA_VERSION, version: versionOf(tracks), tracks };
  }

  // The cache-busting token for a track, remembered against the file's size and mtime.
  //
  // This NEVER reads the file.  It used to: `readFileSync` plus a SHA-256 over every track,
  // on the first request, which on a Pi meant several seconds of SD-card I/O with the event
  // loop blocked - every room, every socket and every other request frozen together, after
  // every single restart and deploy.
  //
  // So a cold entry gets a token derived from (size, mtime), which is free and changes
  // whenever the file changes; `warm()` replaces it with a real content hash in the
  // background.  A track's URL may therefore change once, shortly after startup, which costs
  // one re-fetch of one file and is a great deal cheaper than freezing the box.
  private hashFor(fullPath: string, stat: fs.Stats): string | undefined {
    const known = this.hashes.get(fullPath);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.hash;
    return quickToken(fullPath, stat);
  }

  // -------------------------------------------------------------------
  // warm - compute the real content hashes, off the request path.
  //
  // Content hashes are worth having because they are the same on every
  // machine: rsync preserves mtimes, but a rebuilt box or a file copied by
  // hand would otherwise hand every client a new URL for identical audio.
  //
  // Files are streamed through the hash one at a time rather than read whole:
  // 150MB of readFile would be 150MB of resident memory and one long
  // uninterruptible hash, where a stream yields between chunks and leaves the
  // server answering throughout.  Sequential on purpose - the bottleneck is a
  // single SD card, and reading four files at once only makes it seek.
  // -------------------------------------------------------------------
  async warm(): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.folder);
    } catch {
      return; // No music folder is a perfectly normal state.
    }

    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      if (!AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const full = path.join(this.folder, name);
      try {
        const stat = await fs.promises.stat(full);
        if (!stat.isFile()) continue;
        const known = this.hashes.get(full);
        if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue;
        const hash = await hashFile(full);
        this.hashes.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
      } catch {
        // An unreadable track is skipped, exactly as build() skips it.
      }
    }
  }
}

/**
 * A token that changes when the file does, costing nothing to compute.  Used until the real
 * content hash has been calculated in the background.
 *
 * The path is in the digest as well as the size and mtime: two different tracks that happen
 * to be the same length and were written in the same millisecond - which is exactly what a
 * copy or an rsync produces - would otherwise be handed the same token.
 */
function quickToken(fullPath: string, stat: fs.Stats): string {
  return crypto
    .createHash("sha256")
    .update(`${fullPath}:${stat.size}:${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 12);
}

/** SHA-256 of a file's contents, streamed so the event loop keeps breathing. */
function hashFile(fullPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(fullPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").slice(0, 12)));
  });
}

/** A stable, URL-safe id for a track, derived from its filename. */
export function trackId(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "track";
}

/** The filename, minus the extension, is the title - whatever the person naming it chose. */
export function trackTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

/**
 * A version string for the collection as a whole, so "which music is this presenter running?"
 * has an answer.  Derived from the track hashes, so it changes when - and only when - the
 * music does.
 */
export function versionOf(tracks: { hash: string }[]): string {
  if (tracks.length === 0) return "empty";
  const combined = crypto
    .createHash("sha256")
    .update(tracks.map((t) => t.hash).join(":"))
    .digest("hex")
    .slice(0, 8);
  return `${tracks.length}-${combined}`;
}
