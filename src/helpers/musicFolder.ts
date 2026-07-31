import * as path from "path";
import * as os from "os";

// ==========================================================================================
// Where background music lives, and how it is cached.
//
// Music ships WITH the app, in hosted_content/music - it is part of the deploy payload, not
// something staged separately on the box.  The audio is gitignored (it is large and it is
// not source), so the folder is whatever the person deploying has put in it.
//
// Layout:
//   <app>/hosted_content/music/*.m4a       the tracks, named however you like
//   GET /music/music.json                  the manifest, generated from that folder
//
// Track URLs carry a content hash as a query string, so the files can be cached forever and
// still be replaced by overwriting them - see MusicCatalog.
// ==========================================================================================

/** The manifest is generated, not a file - it is the only music URL that is not immutable. */
export const MUSIC_MANIFEST_NAME = "music.json";

/**
 * Where the music folder is.  `appRoot` is the folder the server is running out of; in a
 * deploy that is the deploy folder, in dev it is `src`, which is why env.dev overrides it.
 * An absolute CLUSTERFUN_MUSIC_PATH wins outright.
 */
export function defaultMusicFolder(appRoot: string = os.homedir()): string {
  const configured = process.env.CLUSTERFUN_MUSIC_PATH;
  if (configured) return path.resolve(appRoot, configured);
  return path.join(appRoot, "hosted_content", "music");
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
