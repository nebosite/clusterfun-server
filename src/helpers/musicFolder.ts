import * as path from "path";
import * as os from "os";

// ==========================================================================================
// Where background music lives, and how it is cached.
//
// Music is served by us, from a folder OUTSIDE the deploy folder - deployit.sh deletes and
// recreates `deploy` wholesale, so anything kept in there is wiped by every deploy.  Same
// reasoning as the popularity file in ~/analytics.
//
// Layout on the box:
//   ~/music/music.json                     the manifest - the one mutable file
//   ~/music/tracks/<name>.<hash>.m4a       tracks, named by content hash, never overwritten
// ==========================================================================================

/** The manifest is the only mutable object in the folder, so it is the only one re-validated. */
export const MUSIC_MANIFEST_NAME = "music.json";

export function defaultMusicFolder(): string {
  return process.env.CLUSTERFUN_MUSIC_PATH ?? path.join(os.homedir(), "music");
}

/**
 * The Cache-Control a music file should be served with.  Track filenames carry a content
 * hash and are replaced by uploading a new name, so caching them for a year is safe; the
 * manifest changes in place and must be re-validated or a replaced track never reaches
 * anybody.
 */
export function musicCacheControl(filePath: string): string {
  return path.basename(filePath).toLowerCase() === MUSIC_MANIFEST_NAME
    ? "no-cache"
    : "public, max-age=31536000, immutable";
}
