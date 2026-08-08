import { test, describe } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseEnvFile, findEnvFile, loadEnvFile, ENV_FILE_NAME } from "./envFile.js";

// A throwaway folder tree, cleaned up however the check ends.
function withTempDir(check: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-envfile-"));
  try {
    check(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("parsing a .env file", () => {
  test("reads plain assignments", () => {
    assert.deepStrictEqual(parseEnvFile("YOUTUBE_API_KEY=abc123"), { YOUTUBE_API_KEY: "abc123" });
  });

  test("ignores blank lines and comments", () => {
    const parsed = parseEnvFile(["# a comment", "", "   ", "A=1", "#B=2"].join("\n"));
    assert.deepStrictEqual(parsed, { A: "1" });
  });

  test("accepts the `export KEY=value` form, so one file can also be sourced by a shell", () => {
    assert.deepStrictEqual(parseEnvFile("export YOUTUBE_API_KEY=abc"), {
      YOUTUBE_API_KEY: "abc",
    });
  });

  test("strips surrounding quotes", () => {
    assert.deepStrictEqual(parseEnvFile(`A="one two"\nB='three'`), { A: "one two", B: "three" });
  });

  test("a value with an = in it keeps the rest - keys often end in padding", () => {
    assert.deepStrictEqual(parseEnvFile("TOKEN=abc=="), { TOKEN: "abc==" });
  });

  test("an unquoted trailing comment is not part of the value", () => {
    assert.deepStrictEqual(parseEnvFile("A=value # explain"), { A: "value" });
  });

  test("but a quoted hash is, because someone will have one in a password", () => {
    assert.deepStrictEqual(parseEnvFile('A="value # not a comment"'), {
      A: "value # not a comment",
    });
  });

  test("escapes only mean something inside double quotes", () => {
    assert.deepStrictEqual(parseEnvFile('A="one\\ntwo"'), { A: "one\ntwo" });
    assert.deepStrictEqual(parseEnvFile("B='one\\ntwo'"), { B: "one\\ntwo" });
  });

  test("handles CRLF, because this file gets edited on Windows", () => {
    assert.deepStrictEqual(parseEnvFile("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
  });

  test("skips malformed lines rather than refusing to boot", () => {
    const parsed = parseEnvFile(["no-equals-here", "=novalue", "9BAD=x", "GOOD=y"].join("\n"));
    assert.deepStrictEqual(parsed, { GOOD: "y" });
  });
});

describe("finding the file", () => {
  test("prefers the app folder, which is what production has (~/deploy/.env)", () => {
    withTempDir((dir) => {
      const appRoot = path.join(dir, "deploy");
      fs.mkdirSync(appRoot);
      fs.writeFileSync(path.join(appRoot, ENV_FILE_NAME), "A=1");
      fs.writeFileSync(path.join(dir, ENV_FILE_NAME), "A=2");
      assert.strictEqual(findEnvFile(appRoot, {}), path.join(appRoot, ENV_FILE_NAME));
    });
  });

  test("falls back to the parent, which is how dev finds clusterfun-server/.env from dist", () => {
    withTempDir((dir) => {
      const appRoot = path.join(dir, "dist");
      fs.mkdirSync(appRoot);
      fs.writeFileSync(path.join(dir, ENV_FILE_NAME), "A=2");
      assert.strictEqual(findEnvFile(appRoot, {}), path.join(dir, ENV_FILE_NAME));
    });
  });

  test("no file anywhere is undefined, not a throw", () => {
    withTempDir((dir) => {
      assert.strictEqual(findEnvFile(path.join(dir, "nothing-here"), {}), undefined);
    });
  });

  test("CLUSTERFUN_ENV_FILE overrides the search", () => {
    withTempDir((dir) => {
      const elsewhere = path.join(dir, "secrets.env");
      fs.writeFileSync(elsewhere, "A=1");
      fs.writeFileSync(path.join(dir, ENV_FILE_NAME), "A=2");
      assert.strictEqual(findEnvFile(dir, { CLUSTERFUN_ENV_FILE: elsewhere }), elsewhere);
    });
  });
});

describe("applying the file", () => {
  test("sets what is missing and reports the names", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, ENV_FILE_NAME), "YOUTUBE_API_KEY=from-file");
      const env: NodeJS.ProcessEnv = {};
      const result = loadEnvFile(dir, env);
      assert.strictEqual(env.YOUTUBE_API_KEY, "from-file");
      assert.deepStrictEqual(result.applied, ["YOUTUBE_API_KEY"]);
      assert.deepStrictEqual(result.skipped, []);
    });
  });

  // The rule that keeps `KEY=x node ...`, systemd and ~/.clusterfun_env all working.
  test("never overwrites something already set in the environment", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, ENV_FILE_NAME), "YOUTUBE_API_KEY=from-file\nOTHER=x");
      const env: NodeJS.ProcessEnv = { YOUTUBE_API_KEY: "from-the-shell" };
      const result = loadEnvFile(dir, env);
      assert.strictEqual(env.YOUTUBE_API_KEY, "from-the-shell");
      assert.deepStrictEqual(result.skipped, ["YOUTUBE_API_KEY"]);
      assert.deepStrictEqual(result.applied, ["OTHER"]);
    });
  });

  test("an empty string in the environment still counts as set", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, ENV_FILE_NAME), "A=from-file");
      const env: NodeJS.ProcessEnv = { A: "" };
      loadEnvFile(dir, env);
      assert.strictEqual(env.A, "");
    });
  });

  test("no file is a quiet no-op", () => {
    withTempDir((dir) => {
      const result = loadEnvFile(path.join(dir, "nothing-here"), {});
      assert.deepStrictEqual(result, { applied: [], skipped: [] });
    });
  });

  test("an unreadable file does not stop the server booting", () => {
    withTempDir((dir) => {
      // A directory named .env is readable by existsSync but not by readFileSync.
      fs.mkdirSync(path.join(dir, ENV_FILE_NAME));
      const result = loadEnvFile(dir, {});
      assert.deepStrictEqual(result.applied, []);
      assert.strictEqual(result.path, path.join(dir, ENV_FILE_NAME));
    });
  });
});
