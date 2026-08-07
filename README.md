# clusterfun-server

The ClusterFun **communications server** for clusterfun.tv. Despite the name it is not a game
server: it runs no game logic and holds no game state. It relays messages between players,
hands out room codes and identities, and serves the built client and the background music.

All state is in memory and ephemeral — rooms are purged when they go quiet, and nothing
survives a restart except the game-popularity counts.

## Run it

```
npm install
npm run startdev   # http://localhost:8080, serving ../clusterfun-client/build
npm run build      # tsc → dist/
npm start          # production entry
npm test           # builds, then node --test with coverage
npm run format     # Prettier; run before committing
```

`npm run startdev` reads `env.dev`, which points at the client's `build/` folder — so rebuild
the client to see front-end changes. Phones on the same network can join at
`http://<your-ip>:8080`.

## Worth knowing while it runs

- `http://localhost:8080/api/am_i_healthy` — a self-contained HTML page showing traffic,
  errors, CPU and memory over 1 min / 10 min / 1 hour / 24 hours / 1 week, plus current room
  and user counts. Built to be opened on a phone while something is going wrong.
- `http://localhost:8080/music/music.json` — the generated list of music the server can see.
  Adding a song is one step: drop the file in `hosted_content/music`.

## Adding a game to production

A game appears in the production lobby only if it is in the hardcoded manifest in
`src/apis/ApiHandlers.ts` **and** in the client's release list — and the manifest's tags and
display name override the client's. So shipping a game needs a server deploy, not just a
client build.

Deeper notes are in [CLAUDE.md](CLAUDE.md); deployment is documented in the
[root README](../README.md).
