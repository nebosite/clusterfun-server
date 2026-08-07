import { test, describe } from "node:test";
import assert from "node:assert";
import { Logger, VERBOSE_LOGGING } from "./consoleHelpers.js";

// Verbose logging is per-message and per-request, and production redirects stdout to a file
// on an SD card where console.log is SYNCHRONOUS.  Leaving it on put an SD write in the
// middle of the relay hot path and grew the log until the card filled.  These tests pin the
// two things that keep it harmless: it stays off unless ISDEV is set, and when it is off it
// does not even build the string.

describe("Logger.logVerbose", () => {
  test("is off unless ISDEV is set", () => {
    // The test runner is not a dev server, so this must be false here.  If this
    // ever fails, production is about to start logging every relayed message.
    assert.strictEqual(VERBOSE_LOGGING, !!process.env.ISDEV);
    assert.strictEqual(VERBOSE_LOGGING, false);
  });

  test("does not even build the message when it is off", () => {
    // This is the half that is easy to lose.  `logVerbose("..." + message)` would
    // allocate the whole 133KB body of a PartyPix upload on every relayed message
    // before discovering nobody wants it - so the argument is a thunk, and the
    // thunk must not be called.
    let built = 0;
    new Logger().logVerbose(() => {
      built++;
      return "expensive";
    });
    assert.strictEqual(built, 0);
  });

  test("writes nothing to the console when it is off", () => {
    const original = console.log;
    let lines = 0;
    console.log = () => {
      lines++;
    };
    try {
      new Logger().logVerbose(() => "anything");
    } finally {
      console.log = original;
    }
    assert.strictEqual(lines, 0);
  });

  test("logLine still writes - ordinary logging is unaffected", () => {
    const original = console.log;
    let lines = 0;
    console.log = () => {
      lines++;
    };
    try {
      new Logger().logLine("something worth saying");
    } finally {
      console.log = original;
    }
    assert.strictEqual(lines, 1);
  });
});
