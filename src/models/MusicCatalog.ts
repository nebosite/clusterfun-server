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

  // Content hash, remembered against the file's size and mtime so it is computed once per
  // file per change rather than once per request.
  private hashFor(fullPath: string, stat: fs.Stats): string | undefined {
    const known = this.hashes.get(fullPath);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.hash;
    try {
      const digest = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
      const hash = digest.slice(0, 12);
      this.hashes.set(fullPath, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
      return hash;
    } catch {
      return undefined;
    }
  }
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
