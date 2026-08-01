import { test, describe } from "node:test";
import assert from "node:assert";
import { HealthMetrics, BUCKET_MS, WEEK_MS } from "./HealthMetrics.js";

// The clock is injected, so a week of history costs a variable rather than a week.  What is
// worth pinning: numbers land in the right windows, they fall out of them on time, and the
// ring cannot be made to report stale data from a week ago as if it were current.

function atClock() {
  let now = 1_000_000_000_000; // a round, arbitrary starting point
  const metrics = new HealthMetrics(() => now);
  return {
    metrics,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

const win = (m: HealthMetrics, ms: number) => m.window("w", ms);

describe("HealthMetrics - counting", () => {
  test("counts messages and bytes in both directions", () => {
    const { metrics } = atClock();
    metrics.recordSentMessage(100);
    metrics.recordSentMessage(300);
    metrics.recordReceivedMessage(50);

    const w = win(metrics, 60_000);
    assert.strictEqual(w.messagesSent, 2);
    assert.strictEqual(w.bytesSent, 400);
    assert.strictEqual(w.messagesReceived, 1);
    assert.strictEqual(w.bytesReceived, 50);
  });

  test("works out bytes per message, and does not divide by zero", () => {
    const { metrics } = atClock();
    metrics.recordSentMessage(100);
    metrics.recordSentMessage(200);
    assert.strictEqual(win(metrics, 60_000).bytesPerMessageSent, 150);
    // Nothing received at all - the answer is 0, not NaN or Infinity
    assert.strictEqual(win(metrics, 60_000).bytesPerMessageReceived, 0);
  });

  test("an invalid room join counts as its own metric and as an error", () => {
    const { metrics } = atClock();
    metrics.recordInvalidRoomJoin();
    metrics.recordInvalidRoomJoin();
    metrics.recordError();

    const w = win(metrics, 60_000);
    assert.strictEqual(w.invalidRoomJoins, 2);
    assert.strictEqual(w.errors, 3);
  });
});

describe("HealthMetrics - windows", () => {
  test("a number sits in every window long enough to hold it", () => {
    const { metrics, advance } = atClock();
    metrics.recordSentMessage(10);
    advance(5 * 60_000); // five minutes later

    assert.strictEqual(win(metrics, 60_000).messagesSent, 0, "gone from the 1 minute window");
    assert.strictEqual(win(metrics, 600_000).messagesSent, 1, "still in 10 minutes");
    assert.strictEqual(win(metrics, 3_600_000).messagesSent, 1, "still in the hour");
    assert.strictEqual(win(metrics, WEEK_MS).messagesSent, 1, "still in the week");
  });

  test("traffic accumulates across buckets inside a window", () => {
    const { metrics, advance } = atClock();
    for (let i = 0; i < 30; i++) {
      metrics.recordSentMessage(10);
      advance(BUCKET_MS); // one message every ten seconds for five minutes
    }
    assert.strictEqual(win(metrics, 600_000).messagesSent, 30);
    assert.strictEqual(win(metrics, 600_000).bytesSent, 300);
    // A minute spans seven ten-second buckets counting the one in progress, but that last
    // one is empty here - the clock advanced past the final message.
    assert.strictEqual(win(metrics, 60_000).messagesSent, 6);
  });

  test("everything ages out after a week", () => {
    const { metrics, advance } = atClock();
    metrics.recordSentMessage(999);
    advance(WEEK_MS + BUCKET_MS);
    assert.strictEqual(win(metrics, WEEK_MS).messagesSent, 0);
  });

  test("a slot reused a week later does not report the old week's traffic", () => {
    // This is the ring's one real hazard: slot N is reused every week, so a stale slot has
    // to be recognised as stale rather than summed into today's numbers.
    const { metrics, advance } = atClock();
    metrics.recordSentMessage(500);
    advance(WEEK_MS); // exactly one week: same slot, different bucket
    metrics.recordSentMessage(7);

    const w = win(metrics, WEEK_MS);
    assert.strictEqual(w.messagesSent, 1, "only the new message");
    assert.strictEqual(w.bytesSent, 7, "and only its bytes");
  });

  test("reports every window the health page asks for", () => {
    const { metrics } = atClock();
    const labels = metrics.report().map((w) => w.label);
    assert.deepStrictEqual(labels, ["1 min", "10 min", "1 hour", "24 hours", "1 week"]);
  });
});

describe("HealthMetrics - gauges", () => {
  test("averages the samples in the window rather than summing them", () => {
    const { metrics, advance } = atClock();
    metrics.sampleResources(10, 100_000_000);
    advance(BUCKET_MS);
    metrics.sampleResources(30, 300_000_000);

    const w = win(metrics, 60_000);
    assert.strictEqual(w.cpuPercent, 20);
    assert.strictEqual(w.memoryRssMb, 200);
  });

  test("a window with no samples reports nothing, not zero", () => {
    // Zero CPU and zero memory would both be lies - nobody measured.
    const { metrics } = atClock();
    const w = win(metrics, 60_000);
    assert.strictEqual(w.cpuPercent, undefined);
    assert.strictEqual(w.memoryRssMb, undefined);
  });

  test("old samples stop counting toward the short windows", () => {
    const { metrics, advance } = atClock();
    metrics.sampleResources(90, 900_000_000); // a spike, an hour ago
    advance(3_600_000);
    metrics.sampleResources(10, 100_000_000);

    assert.strictEqual(win(metrics, 60_000).cpuPercent, 10, "the last minute is calm");
    assert.strictEqual(win(metrics, 86_400_000).cpuPercent, 50, "the day still remembers");
  });
});

describe("HealthMetrics - bandwidth", () => {
  test("averages the bytes over the time the window actually covers", () => {
    const { metrics, advance } = atClock();
    advance(600_000); // let the process be ten minutes old, so nothing is clamped
    for (let i = 0; i < 6; i++) {
      metrics.recordSentMessage(1000);
      metrics.recordReceivedMessage(500);
      advance(BUCKET_MS);
    }
    // 6KB out and 3KB in over the last minute
    const w = win(metrics, 60_000);
    assert.strictEqual(Math.round(w.sentBytesPerSecond), 100);
    assert.strictEqual(Math.round(w.receivedBytesPerSecond), 50);
  });

  test("a young server does not report its week-long bandwidth as nearly zero", () => {
    // Ten seconds old, 10KB sent.  Divided by a week that is ~0 B/s and useless; divided by
    // the ten seconds the process has existed it is the 1KB/s that is actually happening.
    const { metrics, advance } = atClock();
    metrics.recordSentMessage(10_000);
    advance(10_000);
    assert.strictEqual(Math.round(win(metrics, WEEK_MS).sentBytesPerSecond), 1000);
  });

  test("is zero when nothing has moved", () => {
    const { metrics, advance } = atClock();
    advance(60_000);
    assert.strictEqual(win(metrics, 60_000).sentBytesPerSecond, 0);
    assert.strictEqual(win(metrics, 60_000).receivedBytesPerSecond, 0);
  });
});
