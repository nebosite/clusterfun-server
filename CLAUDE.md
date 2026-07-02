# clusterfun-server

The ClusterFun **communications server**. Despite the name, it is *not* a game server — it
runs no game logic and holds no game state. It is a message relay + identity/room manager
that also serves the static client bundle. All game logic lives in the client
(see [../clusterfun-client/CLAUDE.md](../clusterfun-client/CLAUDE.md)).

TypeScript, ESM (`"type": "module"`), Express + `express-ws` (WebSockets), no database —
all state is in-memory and ephemeral.

## What it does

1. **Identity & rooms** — creates rooms with 4-char codes, issues each participant a
   `personalId` + `personalSecret`, tracks who is the presenter.
2. **Message relay** — every participant opens one WebSocket. The server reads only the
   message *header* (sender + receiver) and forwards the opaque payload to the target
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

| Route | Handler | Purpose |
|-------|---------|---------|
| `POST /api/startgame` | `startGame` | Create (or reuse) a room for a game; returns presenter identity. |
| `POST /api/joingame` | `joinGame` | Join a room by code + player name; returns client identity. |
| `POST /api/terminategame` | `terminateGame` | Presenter ends the game (validated by `presenterSecret`). |
| `GET /api/am_i_healthy` | `showHealth` | Health/metrics JSON (used by deploy sanity check). |
| `GET /api/game_manifest` | `getGameManifest` | **Hardcoded** list of games shown in the production lobby. |
| `WS /talk/:roomId/:personalId` | `handleSocket` | The relay socket. |

> **Adding a game to production** means editing the hardcoded array in `getGameManifest`
> (currently `Lexible` and `Stressato`). The client must also have the game registered in
> its release game list. In dev/test lobby, the manifest is bypassed.

### The relay socket (`handleSocket` → `Room`)

- The client sends its `personalSecret` as the first WebSocket subprotocol string, prefixed
  with `Secret`. No secret / bad secret → socket closed (`timingSafeEqual` check in
  `Room.setSocket`).
- Messages are strings of the form `{header}^{payload}`. `Room.receiveMessage` parses only
  the JSON header (`MESSAGE_HEADER_REGEX`), reads `s` (sender) and `r` (receiver), verifies
  the claimed sender matches the socket's owner, then forwards the *entire raw string* to the
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

## Build & run

```
npm install
npm run startdev   # ts-node/esm + env.dev; regenerates src/version.js; serves ../../clusterfun-client/build
npm run build      # tsc → dist/  (also regenerates version.js via genversion)
npm start          # node dist/clusterfun_server_main.js  (production entry)
npm test           # builds, then runs the native node --test runner with coverage
```

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

## Notes / cleanup opportunities

- The WebSocket route is registered on the *main* app rather than the clusterfun vhost
  because (per a code comment) `express-ws` doesn't cooperate with subdomains.
- No persistence and no auth beyond the per-participant secret. Secrets are the only thing
  protecting a room; treat them accordingly.
