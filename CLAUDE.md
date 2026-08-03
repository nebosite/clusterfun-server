# clusterfun-server

The ClusterFun **communications server**. Despite the name, it is _not_ a game server — it
runs no game logic and holds no game state. It is a message relay + identity/room manager
that also serves the static client bundle. All game logic lives in the client
(see [../clusterfun-client/CLAUDE.md](../clusterfun-client/CLAUDE.md)).

TypeScript, ESM (`"type": "module"`), Express + `express-ws` (WebSockets), no database —
all state is in-memory and ephemeral.

## What it does

1. **Identity & rooms** — creates rooms with 4-char codes, issues each participant a
   `personalId` + `personalSecret`, tracks who is the presenter.
2. **Message relay** — every participant opens one WebSocket. The server reads only the
   message _header_ (sender + receiver) and forwards the opaque payload to the target
   participant's socket. It never inspects or understands message bodies.
3. **Static hosting** — serves the built client at `/`.
4. **Health/telemetry** — counts traffic and errors into ten-second buckets covering a week,
   samples CPU/memory, and renders it as an HTML page at `/api/am_i_healthy`.

## Architecture

One `ServerModel` owns a `Map<roomId, Room>`. `ApiHandler` wires HTTP/WS endpoints to it.
`clusterfun_server_main.ts` is the entry point.

```
clusterfun_server_main.ts   Entry: express app, routes, background purge loop
  apis/ApiHandlers.ts        HTTP + WebSocket handlers; safeCall wrapper; UserError/AuthorizationError
  models/ServerModel.ts      All rooms; start/join/reuse/clear; health aggregation; event log
  models/Room.ts             One room: endpoints (participants), sockets, message forwarding
  helpers/id-codes.ts        generateRoomCode / generatePersonalId / generatePersonalSecret
  helpers/consoleHelpers.ts  Logger
  libs/comms/ClusterFunMessageHeader.ts   Header shape shared with the client
  libs/config/GameInstanceProperties.ts   Shape returned to client on start/join
```

### HTTP API (`clusterfun_server_main.ts`)

| Route                          | Handler             | Purpose                                                          |
| ------------------------------ | ------------------- | ---------------------------------------------------------------- |
| `POST /api/startgame`          | `startGame`         | Create (or reuse) a room for a game; returns presenter identity. |
| `POST /api/joingame`           | `joinGame`          | Join a room by code + player name; returns client identity.      |
| `POST /api/terminategame`      | `terminateGame`     | Presenter ends the game (validated by `presenterSecret`).        |
| `GET /api/am_i_healthy`        | `showHealth`        | Health **page** (HTML). Also what the deploy sanity check polls. |
| `GET /api/health_data`         | `getHealthData`     | The same numbers as JSON, for the Stressato load test.           |
| `GET /api/game_manifest`       | `getGameManifest`   | **Hardcoded** list of games shown in the production lobby.       |
| `GET /api/game_popularity`     | `getGamePopularity` | Per-game play counts; the lobby orders its list by these.        |
| `GET /music/*`                 | `express.static`    | Background music files (see below).                              |
| `WS /talk/:roomId/:personalId` | `handleSocket`      | The relay socket.                                                |

> **Adding a game to production** means editing the hardcoded array in `getGameManifest` —
> currently six: PartyPix, Lexible, RetroSpectro, Eittris, OneOhOne, Stressato. The client must
> also have the game in its release list. In dev/test lobby the manifest is bypassed.
>
> **This manifest is the only authority on game tags.** The client registry carries no tags at
> all, so `alpha` / `beta` / `debug` / release (no tag) is decided here and nowhere else, and
> the manifest's `displayName` also wins when set. Changing how a game is badged is therefore a
> **server deploy**, not a client build.
>
> The lobby renders a badge for `beta`, `alpha` and `debug`, and hides any game whose tags
> don't intersect its `showTags` (default `production`, `beta`, `alpha`) — which is what keeps
> `debug`-tagged Stressato out of the public lobby.

### The relay socket (`handleSocket` → `Room`)

- The client sends its `personalSecret` as the first WebSocket subprotocol string, prefixed
  with `Secret`. No secret / bad secret → socket closed (`timingSafeEqual` check in
  `Room.setSocket`).
- Messages are strings of the form **`{header}^{routing}^{payload}`** (the server only ever
  parses the first segment, which is why older notes here said `{header}^{payload}` — but a
  message you _construct_ needs all three). `Room.receiveMessage` parses only the JSON header
  (`MESSAGE_HEADER_REGEX`), reads `s` (sender) and `r` (receiver), verifies the claimed sender
  matches the socket's owner, then forwards the _entire raw string_ on. Payload is never
  deserialized server-side.
- **`Room.ts:154` logs every relayed message body in full** to stdout, which
  `startserver.sh` redirects to `~/logs/server.log`. `console.log` to a file is _synchronous_
  in Node, so this puts an SD-card write in the relay hot path and grows an unbounded log. See
  the risk register.

> ### Shared contracts — keep both copies byte-identical
>
> `libs/comms/ClusterFunMessageHeader.ts` and `libs/config/GameInstanceProperties.ts` are
> duplicated in the client, because the two projects are separate repos with no shared
> package. **They must match exactly**, and `scripts/check-shared-contracts.js` in the root
> repo enforces it — run by the deploy before it builds anything, or by hand with
> `npm run check:contracts`.
>
> They had drifted: this copy declared a required `t: string` that nothing sent and nothing
> read, exported it as `default` rather than named, and typed `id` more widely than the client.
> Treat an edit to either file as a two-repo change.

### Rooms & lifecycle (`ServerModel` / `Room`)

- `startGame` generates a fresh room, or **reuses** an existing one if the caller passes a
  valid `existingRoom` (presenterId + presenterSecret match) — this lets a presenter restart
  a game into the same room code.
- A `Room` holds `endpoints: Map<id, {id, secret, name, socket}>`. The presenter's endpoint
  is named `"presenter"`.
- `clear()` (terminate) closes and drops every endpoint except the presenter and marks the
  room `idle`.
- A room is **active** if it saw a message in the last hour (`isActive`). A background task
  (`purgeInactiveRooms`) runs **every 60 seconds** and deletes inactive rooms; there is also an
  abandoned-room path at `ABANDONED_ROOM_MS = 5 min` (`ServerModel.ts:19`). All rooms are
  transient — do not treat server state as durable.
  > The comment above `isActive` in `Room.ts:37` says "last 10 minutes"; the code compares
  > against `ONE_HOUR`. The code is right.
- Errors: throw `UserError` for a message that should reach the user (→ HTTP 400); other
  throws become a 500 with a timecode. `safeCall` wraps every HTTP handler.

### Background music (`models/MusicCatalog.ts`, `helpers/musicFolder.ts`)

The relay hosts the game music itself rather than leaning on a third party, so the client
fetches it same-origin and there is no CORS to configure.

- Files live in **`hosted_content/music`**, which **ships with the deploy** (`conan.json`
  copies `hosted_content` into the deploy folder). The audio is gitignored; the folder is
  not, because the copy would fail on a fresh clone with nothing there — hence
  `hosted_content/music/.gitkeep`. `CLUSTERFUN_MUSIC_PATH` overrides the location, and
  `env.dev` uses it to point a dev server at the repo copy.
- **The manifest is generated, not stored.** `GET /music/music.json` lists whatever audio is
  in the folder right now, so adding a song is exactly one step - drop the file in - and
  nothing can drift out of sync with what is on disk.
- Each track carries a **content hash** (SHA-256, first 12 hex, cached against size+mtime so
  it costs one pass per file per change). The client puts it in the track URL as `?v=`, which
  is what lets the audio be served `immutable, max-age=1y` and still be replaceable by
  overwriting the file. `music.json` itself is `no-cache`.
- A missing folder simply yields an empty track list. The client treats that as "no music"
  and plays on.
- The client half, the encoding recipe and the host's volume controls are in
  [../clusterfun-client/docs/music.md](../clusterfun-client/docs/music.md).

### Health (`models/HealthMetrics.ts`, `helpers/healthPage.ts`)

`GET /api/am_i_healthy` is a self-contained HTML page — no scripts, no external requests —
because it gets opened on a phone, over the tunnel, while something is going wrong. It shows
traffic, errors, CPU and memory over **1 min / 10 min / 1 hour / 24 hours / 1 week**, plus a
small table of room and user counts right now.

- `HealthMetrics` keeps counts in fixed **ten-second buckets** in a ring covering a week
  (typed arrays, so no per-bucket allocation and a constant few MB). A window is the sum of
  its buckets; CPU and memory are averaged, and a window nobody sampled reports `–` rather
  than a zero it never measured.
- This replaced an array of every event ever logged, which grew to a million records and then
  dropped the oldest fifth — so a busy hour silently discarded the history worth reporting.
- **History does not survive a restart**, like everything else on this server.
- The page must keep the lower-case word `version` in it: `conan.json`'s sanity check greps
  for it to decide the server came back up after a deploy. There is a test for that.
- `GET /api/health_data` serves the same numbers as JSON for the Stressato load-test game.

**Traffic counts cover HTTP as well as the relay** (`helpers/trafficMeter.ts`, mounted first
so it sees static files too). That is what makes "bytes sent" mean anything: within the relay
alone the server forwards each message exactly once, so bytes in equal bytes out by
construction and the pair tells you nothing. The client bundle and the music tracks are the
largest things this box sends and they go one way only.

Two smaller rules behind those numbers: byte counts are `Buffer.byteLength`, not string
length, so a name with an accent in it is not undercounted; and a relay message counts as
sent only once it is actually on a socket, so a gap between the rows means messages are
being _dropped_ rather than delivered.

### Game popularity (`models/PopularityStore.ts`)

The one piece of state here that is **not** ephemeral. The relay counts a _play_ every time a
room is opened for a game and a _player_ every time somebody joins one, and serves the
totals at `/api/game_popularity` so the lobby can order its list by what people actually
play. Deliberately independent of Google Analytics: the lobby has to sort itself without a
third party in the loop.

- Counts are kept in **daily buckets**, and the `score` the lobby sorts by decays with a
  30-day half-life — last year's hit should not outrank this month's.
- Buckets older than 400 days are folded into all-time totals and dropped.
- **The file lives outside the deploy folder** (`~/analytics/popularity.json`, override with
  `CLUSTERFUN_ANALYTICS_PATH`). The deploy mirrors `~/deploy` with `rsync --delete`, so
  anything stored in there would be wiped by every deploy.
- Writes are atomic (temp file + rename) and debounced to at most one per 5s, with a final
  flush on process exit — so a normal stop (`stopserver.sh` sends SIGTERM → `process.exit`)
  loses nothing. A power cut can lose up to 5 seconds of counts, which is the accepted trade
  for not rewriting the file on every join.
- Constructing a `PopularityStore` with **no path keeps it in memory and never touches
  disk**, and that is the default — so tests (which all build a `ServerModel`) cannot write
  into somebody's home directory. `clusterfun_server_main.ts` passes the real path.
- A missing, corrupt, or future-schema file is survivable: it starts fresh and keeps serving.

## Build & run

```
npm install
npm run startdev   # ts-node/esm + env.dev; regenerates src/version.js; serves ../../clusterfun-client/build
npm run build      # tsc → dist/  (also regenerates version.js via genversion)
npm start          # node dist/clusterfun_server_main.js  (production entry)
npm test           # builds, then runs the native node --test runner with coverage
```

**Add tests for new logic, and run `npm test` before committing.** The relay's routing,
secret validation, and room-lifecycle rules are exactly the kind of thing a small change can
silently break; the suite is fast, so run it often.

Tests use the built-in `node:test` runner + `node:assert` (no mocha/chai). Specs live
next to their source as `*.test.ts`, compile to `dist/**/*.test.js`, and are run with
`node --test` (`--test-force-exit` is required because `ServerModel` starts a CPU-usage
`setInterval` that otherwise keeps the test process alive). `--experimental-test-coverage`
prints a per-file coverage table.

- Listens on **8080** by default; override with `PORT_OVERRIDE` env var.
- `env.dev` sets `ISDEV=1` and points `CLUSTERFUN_DEV_CLIENT_PATH` at the client `build/`
  folder. In production the client bits live in a sibling `client/` folder next to the
  compiled server (per `conan.json`), and `CLUSTERFUN_DEV_CLIENT_PATH` defaults to `client`.
- Pass `killpath=<something>` as a process arg to expose a kill URL — used by the deploy
  sanity check to start/stop the server cleanly. Don't enable it in real production.
- `version.js` is generated (`genversion`) from `package.json`; don't hand-edit it.

## Formatting (Prettier)

Source is formatted with [Prettier](https://prettier.io). **Run `npm run format` before
committing** (`prettier --write --cache .`); `npm run format:check` verifies without writing.
Config is in `.prettierrc.json`: `printWidth: 100` (100 columns) and **double quotes**
(`singleQuote: false`); all else is Prettier defaults. `dist/` and the generated
`src/version.js` are in `.prettierignore`.

## Notes / cleanup opportunities

- **vhost is gone.** `clusterFunApp` is mounted for every host (`clusterfun_server_main.ts:133-139`).
  The `// HACK: TODO: ... does not work with subdomains` comment at `:67` and the `vhost` npm
  dependency are both leftovers from when it wasn't.
- **No gzip.** There is no `compression` dependency and `express.static` is mounted bare, so
  the client bundle and the 3.1 MB Lexible dictionary ship uncompressed off a home uplink.
  One `app.use(compression())` is roughly a 4× win. See the risk register.
- **The deployed `client/` folder contains ~29 MB of developer artifacts** — a 23 MB
  `bundle-stats.json` (from `react-scripts build --stats`) and 66 `.map` files — because
  `conan.json` rsyncs `clusterfun-client/build` wholesale. They are publicly fetchable.
- No persistence and no auth beyond the per-participant secret. Secrets are the only thing
  protecting a room; treat them accordingly.
- `models/HealthMetrics.ts:20` claims the windows array is "longest label first"; it is
  ordered shortest first.
