// ==========================================================================================
// HealthMetrics - what the server has been doing lately, over several time windows.
//
// Counts go into fixed 10-second buckets held in a ring that covers a week; a window is the
// sum (or, for gauges, the average) of the buckets inside it.  That makes the memory cost a
// constant few megabytes no matter how busy the server gets, which is the point: the
// previous approach kept every event in an array and threw away the oldest million when it
// filled, so a busy hour could quietly eat the history it was supposed to be reporting.
//
// Typed arrays rather than objects, so there is no per-bucket allocation and nothing for the
// garbage collector to walk on a box as small as a Pi.
//
// History does not survive a restart.  Nothing here is durable and nothing else on this
// server is either - see the room lifecycle.
// ==========================================================================================

export const BUCKET_MS = 10_000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BUCKET_COUNT = WEEK_MS / BUCKET_MS; // 60480 buckets of ten seconds

/** The windows the health page reports, longest label first for the table header. */
export const HEALTH_WINDOWS: { label: string; ms: number }[] = [
  { label: "1 min", ms: 60_000 },
  { label: "10 min", ms: 600_000 },
  { label: "1 hour", ms: 3_600_000 },
  { label: "24 hours", ms: 86_400_000 },
  { label: "1 week", ms: WEEK_MS },
];

export interface HealthWindow {
  label: string;
  ms: number;
  messagesSent: number;
  bytesSent: number;
  bytesPerMessageSent: number;
  /** Average bytes per second over the window - what the link actually carried. */
  sentBytesPerSecond: number;
  messagesReceived: number;
  bytesReceived: number;
  bytesPerMessageReceived: number;
  receivedBytesPerSecond: number;
  invalidRoomJoins: number;
  errors: number;
  /** Average over the window of the samples taken in it, or undefined if none were. */
  cpuPercent: number | undefined;
  memoryRssMb: number | undefined;
}

export class HealthMetrics {
  private readonly now: () => number;
  private readonly startedAt: number;

  // One array per counter.  Index is the ring slot; `stamp` records which bucket the slot
  // currently holds, so a slot from a week ago is recognised as stale rather than summed.
  private readonly stamp = new Float64Array(BUCKET_COUNT).fill(-1);
  private readonly messagesSent = new Float64Array(BUCKET_COUNT);
  private readonly bytesSent = new Float64Array(BUCKET_COUNT);
  private readonly messagesReceived = new Float64Array(BUCKET_COUNT);
  private readonly bytesReceived = new Float64Array(BUCKET_COUNT);
  private readonly invalidRoomJoins = new Float64Array(BUCKET_COUNT);
  private readonly errors = new Float64Array(BUCKET_COUNT);
  private readonly cpuSum = new Float64Array(BUCKET_COUNT);
  private readonly cpuCount = new Float64Array(BUCKET_COUNT);
  private readonly rssSum = new Float64Array(BUCKET_COUNT);
  private readonly rssCount = new Float64Array(BUCKET_COUNT);

  // The clock is injectable so the tests can walk a week forward without waiting one.
  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.startedAt = now();
  }

  recordSentMessage(bytes: number) {
    const slot = this.currentSlot();
    this.messagesSent[slot]++;
    this.bytesSent[slot] += bytes;
  }

  recordReceivedMessage(bytes: number) {
    const slot = this.currentSlot();
    this.messagesReceived[slot]++;
    this.bytesReceived[slot] += bytes;
  }

  /** A join that named a room the server does not have - the one error worth its own row. */
  recordInvalidRoomJoin() {
    const slot = this.currentSlot();
    this.invalidRoomJoins[slot]++;
    this.errors[slot]++;
  }

  recordError() {
    this.errors[this.currentSlot()]++;
  }

  /** A periodic reading of the gauges: CPU as a percentage, resident memory in bytes. */
  sampleResources(cpuPercent: number, rssBytes: number) {
    const slot = this.currentSlot();
    this.cpuSum[slot] += cpuPercent;
    this.cpuCount[slot]++;
    this.rssSum[slot] += rssBytes;
    this.rssCount[slot]++;
  }

  /** Every window in HEALTH_WINDOWS, which is what the health page tabulates. */
  report(): HealthWindow[] {
    return HEALTH_WINDOWS.map((w) => this.window(w.label, w.ms));
  }

  window(label: string, ms: number): HealthWindow {
    const now = this.now();
    // Inclusive of the bucket the window starts in: a "1 min" window covers the six
    // ten-second buckets up to and including the one in progress.
    const firstBucket = Math.floor((now - ms) / BUCKET_MS);
    const lastBucket = Math.floor(now / BUCKET_MS);

    let messagesSent = 0,
      bytesSent = 0,
      messagesReceived = 0,
      bytesReceived = 0,
      invalidRoomJoins = 0,
      errors = 0,
      cpuSum = 0,
      cpuCount = 0,
      rssSum = 0,
      rssCount = 0;

    for (let bucket = firstBucket; bucket <= lastBucket; bucket++) {
      if (bucket < 0) continue;
      const slot = bucket % BUCKET_COUNT;
      // A slot whose stamp is a different bucket belongs to some older week, or was never
      // written; either way it is not part of this window.
      if (this.stamp[slot] !== bucket) continue;
      messagesSent += this.messagesSent[slot];
      bytesSent += this.bytesSent[slot];
      messagesReceived += this.messagesReceived[slot];
      bytesReceived += this.bytesReceived[slot];
      invalidRoomJoins += this.invalidRoomJoins[slot];
      errors += this.errors[slot];
      cpuSum += this.cpuSum[slot];
      cpuCount += this.cpuCount[slot];
      rssSum += this.rssSum[slot];
      rssCount += this.rssCount[slot];
    }

    // Spread the bytes over the time actually covered.  Clamped to how long this process
    // has been up, or a server five minutes old would report its week-long bandwidth as
    // near zero - technically true and completely useless for spotting a problem.
    const coveredMs = Math.max(1, Math.min(ms, now - this.startedAt));
    const perSecond = (total: number) => (total * 1000) / coveredMs;

    return {
      label,
      ms,
      messagesSent,
      bytesSent,
      bytesPerMessageSent: messagesSent > 0 ? bytesSent / messagesSent : 0,
      sentBytesPerSecond: perSecond(bytesSent),
      messagesReceived,
      bytesReceived,
      bytesPerMessageReceived: messagesReceived > 0 ? bytesReceived / messagesReceived : 0,
      receivedBytesPerSecond: perSecond(bytesReceived),
      invalidRoomJoins,
      errors,
      cpuPercent: cpuCount > 0 ? cpuSum / cpuCount : undefined,
      memoryRssMb: rssCount > 0 ? rssSum / rssCount / 1_000_000 : undefined,
    };
  }

  // The slot for right now, cleared first if it is still holding a bucket from a week ago.
  private currentSlot(): number {
    const bucket = Math.floor(this.now() / BUCKET_MS);
    const slot = bucket % BUCKET_COUNT;
    if (this.stamp[slot] !== bucket) {
      this.stamp[slot] = bucket;
      this.messagesSent[slot] = 0;
      this.bytesSent[slot] = 0;
      this.messagesReceived[slot] = 0;
      this.bytesReceived[slot] = 0;
      this.invalidRoomJoins[slot] = 0;
      this.errors[slot] = 0;
      this.cpuSum[slot] = 0;
      this.cpuCount[slot] = 0;
      this.rssSum[slot] = 0;
      this.rssCount[slot] = 0;
    }
    return slot;
  }
}
