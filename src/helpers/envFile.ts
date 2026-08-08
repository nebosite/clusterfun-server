// ==========================================================================================
// A very small .env loader.
//
// There is no dotenv dependency here on purpose: this ships to a Raspberry Pi running
// node-v16.14.0, the format is a dozen lines of parsing, and the repo already prefers a
// tested local helper over another package in node_modules.
//
// Two rules matter more than the parsing:
//
//   - The real environment ALWAYS wins.  A variable already set in the process environment is
//     never overwritten by the file, so `YOUTUBE_API_KEY=... node ...`, a systemd unit, and
//     the older `~/.clusterfun_env` shell export all still work and still take precedence.
//     A config file that silently overrode what you just typed on the command line would be
//     a genuinely nasty thing to debug.
//   - Values are never logged.  The whole point of the file is that it holds secrets, so the
//     load reports variable NAMES and nothing else.
// ==========================================================================================

import * as fs from "fs";
import * as path from "path";

export const ENV_FILE_NAME = ".env";

// Only a plausible shell variable name is accepted; anything else is a typo, and applying it
// would just produce a variable nothing reads.
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface EnvFileLoadResult {
  /** The file that was read, or undefined if there was none. */
  path?: string;
  /** Names taken from the file. */
  applied: string[];
  /** Names present in the file but already set in the environment, which wins. */
  skipped: string[];
}

//--------------------------------------------------------------------------------------
// Parse .env text into plain key/value pairs.  Unparseable lines are skipped rather than
// thrown on: one bad line should not stop the server from booting.
//--------------------------------------------------------------------------------------
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // `export KEY=value` is accepted so the same file can also be `source`d from a shell,
    // which is exactly what scripts/clusterfun_env.example does.
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;

    const equals = withoutExport.indexOf("=");
    if (equals < 1) continue;

    const key = withoutExport.slice(0, equals).trim();
    if (!KEY_PATTERN.test(key)) continue;

    result[key] = parseValue(withoutExport.slice(equals + 1).trim());
  }
  return result;
}

function parseValue(raw: string): string {
  if (raw.length >= 2) {
    const quote = raw[0];
    if ((quote === '"' || quote === "'") && raw[raw.length - 1] === quote) {
      const inner = raw.slice(1, -1);
      // Escapes only mean anything inside double quotes, same as a shell.
      return quote === '"' ? unescapeDoubleQuoted(inner) : inner;
    }
  }
  // Unquoted: a trailing ` # comment` is a comment, not part of the value.  Quote the value
  // if you genuinely need a hash in it.
  const commentAt = raw.search(/\s#/);
  return (commentAt >= 0 ? raw.slice(0, commentAt) : raw).trim();
}

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\(.)/g, (_whole, char: string) => {
    switch (char) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return char;
    }
  });
}

//--------------------------------------------------------------------------------------
// Where the file is.  `appRoot` is the folder the server runs out of, which differs between
// the three ways this process starts:
//
//   production   ~/deploy            (dist/ lands at the deploy root)   -> ~/deploy/.env
//   built dev    clusterfun-server/dist                                 -> clusterfun-server/.env
//   ts-node dev  clusterfun-server/src                                  -> clusterfun-server/.env
//
// So: the app folder first, then its parent.  That is what makes `clusterfun-server/.env` the
// answer in both development shapes without a second setting to keep in sync.
// CLUSTERFUN_ENV_FILE overrides the search outright.
//--------------------------------------------------------------------------------------
export function findEnvFile(
  appRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.CLUSTERFUN_ENV_FILE;
  if (configured) {
    const resolved = path.resolve(appRoot, configured);
    return fs.existsSync(resolved) ? resolved : undefined;
  }
  for (const folder of [appRoot, path.join(appRoot, "..")]) {
    const candidate = path.join(folder, ENV_FILE_NAME);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

//--------------------------------------------------------------------------------------
// Read the file and apply it, without ever clobbering what is already set.  A missing file
// is not an error - most of the time there isn't one.
//--------------------------------------------------------------------------------------
export function loadEnvFile(
  appRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvFileLoadResult {
  const filePath = findEnvFile(appRoot, env);
  if (!filePath) return { applied: [], skipped: [] };

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return { path: filePath, applied: [], skipped: [] };
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { path: filePath, applied, skipped };
}
