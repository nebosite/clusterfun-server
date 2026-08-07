import chalk from "chalk";

const pad2 = (n: number) => n.toString().padStart(2, "0");
const pad3 = (n: number) => n.toString().padStart(3, "0");

// ---------------------------------------------------------------------------------
// Verbose logging - per-message and per-request lines.
//
// OFF unless ISDEV is set, and that is not a preference.  console.log to a file is
// SYNCHRONOUS in Node, and production redirects stdout to ~/logs/server.log on an SD card:
// logging every relayed message put an SD write in the middle of the relay hot path, and a
// PartyPix upload wrote its whole 133KB body there.  It also grew the log without bound
// until the card filled, which takes down the entire server rather than one game.
//
// Locally, where the log is a terminal on an SSD, all of that is free and seeing the traffic
// is genuinely useful - hence env.dev sets ISDEV=1.
// ---------------------------------------------------------------------------------
export const VERBOSE_LOGGING = !!process.env.ISDEV;

export class Logger {
  // ---------------------------------------------------------------------------------
  // Get now formatted as YYYY/MM/DD HH:MM:SS.fff
  // ---------------------------------------------------------------------------------
  getCurrentDateString() {
    var d = new Date();

    return (
      `${d.getUTCFullYear()}` +
      `/${pad2(d.getUTCMonth() + 1)}` +
      `/${pad2(d.getUTCDate())}` +
      ` ${pad2(d.getUTCHours())}` +
      `:${pad2(d.getUTCMinutes())}` +
      `:${pad2(d.getUTCSeconds())}` +
      `.${pad3(d.getUTCMilliseconds())}`
    );
  }

  // ---------------------------------------------------------------------------------
  // Log a line prepended with date
  // ---------------------------------------------------------------------------------
  logLine(text: string) {
    console.log(this.getCurrentDateString() + "]  info: " + text);
  }

  // ---------------------------------------------------------------------------------
  // Log a line only in a local/dev run.  For anything that happens per message or per
  // request - see VERBOSE_LOGGING above for why that must not reach production.
  // ---------------------------------------------------------------------------------
  logVerbose(text: () => string) {
    if (!VERBOSE_LOGGING) return;
    console.log(this.getCurrentDateString() + "] debug: " + text());
  }

  // ---------------------------------------------------------------------------------
  // Log error with prepended date
  // ---------------------------------------------------------------------------------
  logError(text: string) {
    console.error(chalk.redBright(this.getCurrentDateString() + "] error: " + text));
  }
}
