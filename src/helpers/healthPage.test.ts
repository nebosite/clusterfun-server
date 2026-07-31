import { test, describe } from "node:test";
import assert from "node:assert";
import { renderHealthPage } from "./healthPage.js";
import { HealthWindow } from "../models/HealthMetrics.js";

function windowOf(label: string, over: Partial<HealthWindow> = {}): HealthWindow {
  return {
    label,
    ms: 60_000,
    messagesSent: 0,
    bytesSent: 0,
    bytesPerMessageSent: 0,
    messagesReceived: 0,
    bytesReceived: 0,
    bytesPerMessageReceived: 0,
    invalidRoomJoins: 0,
    errors: 0,
    cpuPercent: 0,
    memoryRssMb: 0,
    ...over,
  };
}

const page = (over: Partial<Parameters<typeof renderHealthPage>[0]> = {}) =>
  renderHealthPage({
    version: "1.2.3",
    uptime: "2 03:04:05",
    windows: [windowOf("1 min"), windowOf("1 week")],
    rooms: { roomCount: 12, activeRooms: 8, activeUsers: 22 },
    generatedAt: "2026-07-31T12:00:00.000Z",
    ...over,
  });

describe("health page", () => {
  test("is a whole HTML document that needs nothing else to render", () => {
    const html = page();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<\/html>/);
    // No scripts and no external requests: it gets opened over a tunnel when things are bad
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /https?:\/\//);
  });

  test("keeps the word the deploy sanity check greps for", () => {
    // conan.json waits for /api/am_i_healthy to match "version" before calling a deploy
    // good.  Losing this word silently breaks every future deploy.
    assert.match(page(), /version/);
  });

  test("has a row for every metric asked for", () => {
    const html = page();
    for (const label of [
      "messages sent",
      "bytes sent",
      "bytes per message sent",
      "messages received",
      "bytes received",
      "bytes per message received",
      "join with invalid room id",
      "errors",
      "CPU utilization %",
      "memory (rss) MB",
    ]) {
      assert.ok(html.includes(label), `missing row: ${label}`);
    }
  });

  test("has a column for every window it is given", () => {
    const html = page();
    assert.ok(html.includes("<th>1 min</th>"));
    assert.ok(html.includes("<th>1 week</th>"));
  });

  test("shows the instantaneous counts in their own table", () => {
    const html = page();
    assert.match(html, /room count<\/th><td>12<\/td>/);
    assert.match(html, /active rooms<\/th><td>8<\/td>/);
    assert.match(html, /active users<\/th><td>22<\/td>/);
  });

  test("scales big byte counts instead of printing a wall of digits", () => {
    const html = page({ windows: [windowOf("1 week", { bytesSent: 2_500_000_000 })] });
    assert.ok(html.includes("2.50 GB"), "expected GB");
  });

  test("prints a dash for a gauge nobody sampled", () => {
    const html = page({
      windows: [windowOf("1 min", { cpuPercent: undefined, memoryRssMb: undefined })],
    });
    assert.ok(html.includes("&ndash;"));
  });

  test("escapes anything that could be turned into markup", () => {
    const html = page({ version: '<script>alert("x")</script>' });
    assert.doesNotMatch(html, /<script/i);
    assert.ok(html.includes("&lt;script&gt;"));
  });
});
