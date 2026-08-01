import { HealthWindow } from "../models/HealthMetrics.js";

// ==========================================================================================
// healthPage - the /api/am_i_healthy page.
//
// Deliberately one self-contained HTML document with inline styles and no scripts: it gets
// looked at from a phone, over a tunnel, while something is going wrong, and it should render
// on anything without fetching a single extra file.
// ==========================================================================================

export interface HealthPageData {
  version: string;
  uptime: string;
  windows: HealthWindow[];
  rooms: { roomCount: number; activeRooms: number; activeUsers: number };
  generatedAt: string;
}

/** Rows of the big table: one metric each, read across the time windows. */
const METRIC_ROWS: { label: string; value: (w: HealthWindow) => string }[] = [
  { label: "messages sent", value: (w) => count(w.messagesSent) },
  { label: "sent (KB)", value: (w) => kb(w.bytesSent) },
  { label: "per message sent (KB)", value: (w) => kb(w.bytesPerMessageSent, 2) },
  { label: "average sent bandwidth (KB/s)", value: (w) => kb(w.sentBytesPerSecond, 2) },
  { label: "messages received", value: (w) => count(w.messagesReceived) },
  { label: "received (KB)", value: (w) => kb(w.bytesReceived) },
  { label: "per message received (KB)", value: (w) => kb(w.bytesPerMessageReceived, 2) },
  { label: "average received bandwidth (KB/s)", value: (w) => kb(w.receivedBytesPerSecond, 2) },
  { label: "join with invalid room id", value: (w) => count(w.invalidRoomJoins) },
  { label: "errors (all kinds)", value: (w) => count(w.errors) },
  { label: "CPU utilization (%)", value: (w) => gauge(w.cpuPercent, 2) },
  { label: "memory rss (KB)", value: (w) => gauge(w.memoryRssMb, 0, 1000) },
];

export function renderHealthPage(data: HealthPageData): string {
  const headers = data.windows.map((w) => `<th>${escapeHtml(w.label)}</th>`).join("");
  const rows = METRIC_ROWS.map((row) => {
    const cells = data.windows.map((w) => `<td>${row.value(w)}</td>`).join("");
    return `<tr><th scope="row">${escapeHtml(row.label)}</th>${cells}</tr>`;
  }).join("\n      ");

  // "version" stays lower case and in the page on purpose: the deploy sanity check greps
  // this page for it to decide the server came back up.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClusterFun server health</title>
<style>
  body { font-family: "Segoe UI", Tahoma, Verdana, sans-serif; margin: 24px;
         background: #16213a; color: #e8edf6; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; font-weight: 600; color: #b9c9e4; }
  .sub { color: #93a7c9; font-size: 13px; margin-bottom: 4px; }
  table { border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #3a4d72; padding: 5px 12px; text-align: right;
           font-variant-numeric: tabular-nums; }
  thead th { background: #22304f; text-align: center; }
  th[scope="row"] { text-align: left; background: #1c2942; font-weight: 500; }
  tbody tr:nth-child(even) td { background: #1a2540; }
  .wrap { overflow-x: auto; }
</style>
</head>
<body>
  <h1>ClusterFun server health</h1>
  <div class="sub">version ${escapeHtml(data.version)} &middot; up ${escapeHtml(data.uptime)} &middot; as of ${escapeHtml(data.generatedAt)}</div>

  <h2>Over the last&hellip;</h2>
  <div class="wrap">
  <table>
    <thead><tr><th scope="col">metric</th>${headers}</tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  </div>

  <h2>Right now</h2>
  <table>
    <tbody>
      <tr><th scope="row">room count</th><td>${count(data.rooms.roomCount)}</td></tr>
      <tr><th scope="row">active rooms</th><td>${count(data.rooms.activeRooms)}</td></tr>
      <tr><th scope="row">active users</th><td>${count(data.rooms.activeUsers)}</td></tr>
    </tbody>
  </table>
</body>
</html>
`;
}

// A gauge with no samples in its window is not zero - nobody was looking.  Saying so beats
// reporting an idle CPU that was never measured.  `scale` converts the stored unit into the
// one the row heading promises.
function gauge(value: number | undefined, places: number, scale = 1): string {
  if (value === undefined) return "&ndash;";
  return (value * scale).toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

function count(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

// Everything to do with size is in KB, said once in the row heading rather than repeated in
// every cell - a table of numbers is far easier to compare down a column when the numbers
// are bare and all in the same unit.
function kb(bytes: number, places = 1): string {
  return (bytes / 1000).toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
