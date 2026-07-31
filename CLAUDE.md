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
4. **Health/telemetry** — aggregates event counts (messages, errors, requests), CPU/memory,
   room/user counts, exposed via `/api/am_i_healthy`.

## Architecture

One `ServerModel` owns a `Map<roomId, Room>`. `ApiHandler` wires HTTP/WS endpoints to it.
`clusterfun_server_main.ts` is the entry point.

```
clusterfun_server_main.ts   Entry: express app, routes, vhosts, background purge loop
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
| `GET /api/am_i_healthy`        | `showHealth`        | Health/metrics JSON (used by deploy sanity check).               |
| `GET /api/game_manifest`       | `getGameManifest`   | **Hardcoded** list of games shown in the production lobby.       |
| `GET /api/game_popularity`     | `getGamePopularity` | Per-game play counts; the lobby orders its list by these.        |
| `GET /music/*`                 | `express.static`    | Background music files (see below).                              |
| `WS /talk/:roomId/:personalId` | `handleSocket`      | The relay socket.                                                |

> **Adding a game to production** means editing the hardcoded array in `getGameManifest`
> (currently `Lexible` and `Stressato`). The client must also have the game registered in
> its release game list. In dev/test lobby, the manifest is bypassed.

### The relay socket (`handleSocket` → `Room`)

- The client sends its `personalSecret` as the first WebSocket subprotocol string, prefixed
  with `Secret`. No secret / bad secret → socket closed (`timingSafeEqual` check in
  `Room.setSocket`).
- Messages are strings of the form `{header}^{payload}`. `Room.receiveMessage` parses only
  the JSON header (`MESSAGE_HEADER_REGEX`), reads `s` (sender) and `r` (receiver), verifies
  the claimed sender matches the socket's owner, then forwards the _entire raw string_ to the
  receiver's socket. Payload is never deserialized server-side.
- `ClusterFunMessageHeader` (`libs/comms`) is the header contract; keep it in sync with the
  client's `libs/comms/ClusterFunMessageHeader.ts`.

### Rooms & lifecycle (`ServerModel` / `Room`)

- `startGame` generates a fresh room, or **reuses** an existing one if the caller passes a
  valid `existingRoom` (presenterId + presenterSecret match) — this lets a presenter restart
  a game into the same room code.
- A `Room` holds `endpoints: Map<id, {id, secret, name, socket}>`. The presenter's endpoint
  is named `"presenter"`.
- `clear()` (terminate) closes and drops every endpoint except the presenter and marks the
  room `idle`.
- A room is **active** if it saw a message in the last hour (`isActive`). Every 10 minutes a
  background task (`purgeInactiveRooms`) deletes inactive rooms. So all rooms are transient —
  do not treat server state as durable.
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
  `CLUSTERFUN_ANALYTICS_PATH`). `deployit.sh` deletes and recreates `deploy` wholesale, so
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

- The WebSocket route is registered on the _main_ app rather than the clusterfun vhost
  because (per a code comment) `express-ws` doesn't cooperate with subdomains.
- No persistence and no auth beyond the per-participant secret. Secrets are the only thing
  protecting a room; treat them accordingly.
