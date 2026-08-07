import express from "express";
import express_ws from "express-ws";
import compression from "compression";
import * as path from "path";
import { fileURLToPath } from "url";
import { ClusterFunEventType, ServerModel } from "./models/ServerModel.js";
import { PopularityStore, defaultPopularityPath } from "./models/PopularityStore.js";
import bodyParser from "body-parser";
import { Logger } from "./helpers/consoleHelpers.js";
import { ApiHandler } from "./apis/ApiHandlers.js";
import {
  defaultMusicFolder,
  musicCacheControl,
  MUSIC_MANIFEST_NAME,
} from "./helpers/musicFolder.js";
import { MusicCatalog } from "./models/MusicCatalog.js";
import { trafficMeter } from "./helpers/trafficMeter.js";
import { version as VERSION } from "./version.js";

//--------------------------------------------------------------------------------------
// Local logging and evironment
//--------------------------------------------------------------------------------------
const logger = new Logger();
logger.logLine(
  "##################################################################################",
);
logger.logLine("## Starting ClusterFun Server  v" + VERSION);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------
let portOverride = 8080;
if (process.env.PORT_OVERRIDE) portOverride = Number.parseInt(process.env.PORT_OVERRIDE);
export const StartTime = Date.now();

let killPath: string | undefined;
// Process Arguments
for (let arg of process.argv.slice(2)) {
  const parts = arg.split("=", 2);
  if (parts[0].toLowerCase() === "killpath") {
    logger.logLine("**** Setting kill path to /" + parts[1] + " ****");
    killPath = parts[1];
  }
}

// ---------------------------------------------------------------------------------
// Set up models and base logic
// ---------------------------------------------------------------------------------
// The play counts live outside the deploy folder on purpose: deployit.sh
// deletes and recreates that wholesale, which would wipe them on every deploy.
// Override the location with CLUSTERFUN_ANALYTICS_PATH.
const popularityStore = new PopularityStore(defaultPopularityPath(), undefined, (line: string) =>
  logger.logLine(line),
);
logger.logLine(`Game popularity counts: ${defaultPopularityPath()}`);
const serverModel = new ServerModel(logger, popularityStore);
const api = new ApiHandler(serverModel, logger);

//--------------------------------------------------------------------------------------
// CLUSTERFUN app setup
//--------------------------------------------------------------------------------------
const app = express();

const clusterFunApp = express();

// HACK:  TODO:  For some reason, web socket api does not work
// with subdomains.  Only with the main express app.
const clusterFunApp_ws = express_ws(app);

if (killPath) {
  // Set up kill path as first processor.  Invoking the server with the killpath
  // specified allows testing logic to easily start and stop the server during tests
  clusterFunApp.get("/" + killPath, (req, res) => {
    logger.logLine("Server was killed with killpath");
    res.end("Arrrgh!");
    process.exit(0);
  });
}

// First in the chain, so it sees every response including static files and music.
//
// Deliberately BEFORE compression, so the traffic numbers on the health page are the bytes
// this box actually put on the wire rather than the pre-compression size.
clusterFunApp.use(trafficMeter((received, sent) => serverModel.reportHttpExchange(received, sent)));

// Gzip everything compressible.  This box is a Raspberry Pi on a home uplink, and the
// client bundle is the largest thing it sends: Lexible's dictionary chunk alone is 3.1MB
// raw against 732KB gzipped.  Cloudflare compresses to the browser, but only after the Pi
// has already pushed the full uncompressed body to Cloudflare on every cache miss.
//
// The default filter skips anything already compressed (m4a, png, jpg), so the music and
// the images are not pointlessly re-encoded on a slow CPU.
clusterFunApp.use(compression());

clusterFunApp.use(bodyParser.json());
clusterFunApp.use(function (req, res, next) {
  if (req.url.length < 2) {
    serverModel.logEvent(ClusterFunEventType.GetRequest, undefined, "ROOT");
  }
  // Per request, so local-only: every static file fetch would otherwise be a
  // synchronous SD-card write on the Pi.
  logger.logVerbose(() => `Request: ${req.method}: ` + req.url);
  next();
});

// Clusterfun APIs
clusterFunApp.post("/api/startgame", api.startGame);
clusterFunApp.post("/api/joingame", api.joinGame);
clusterFunApp.post("/api/terminategame", api.terminateGame);
clusterFunApp.get("/api/am_i_healthy", api.showHealth);
clusterFunApp.get("/api/health_data", api.getHealthData);
clusterFunApp.get("/api/game_manifest", api.getGameManifest);
clusterFunApp.get("/api/game_popularity", api.getGamePopularity);
clusterFunApp.get("/api/youtube_search", api.youtubeSearch);

clusterFunApp_ws.app.ws("/talk/:roomId/:personalId", api.handleSocket);

// Background music, served by us rather than a third party so there is no other service to
// depend on and no CORS to configure - it is the same origin as the app.  Adding music is
// one step: put a file in hosted_content/music.  The manifest is generated from whatever is
// in there, so there is nothing to keep in sync, and a missing folder is simply a server
// with no music.
const musicFolder = defaultMusicFolder(__dirname);
const musicCatalog = new MusicCatalog(musicFolder);
logger.logLine("Serving background music from " + musicFolder);
// Compute the real content hashes in the background.  Requests are served from
// the moment the server starts using a cheap (size, mtime) token, so nothing
// waits on this - it just upgrades the tokens to content hashes once it lands.
musicCatalog
  .warm()
  .then(() => logger.logLine("Music content hashes ready"))
  .catch((err) => logger.logLine("Could not hash the music folder: " + err));
clusterFunApp.get(`/music/${MUSIC_MANIFEST_NAME}`, (req, res) => {
  // The one music URL that changes: it must be re-validated, or a new track never appears.
  res.setHeader("Cache-Control", "no-cache");
  res.json(musicCatalog.build());
});
clusterFunApp.use(
  "/music",
  express.static(musicFolder, {
    setHeaders: (res, filePath) => res.setHeader("Cache-Control", musicCacheControl(filePath)),
  }),
);

const clientPath = process.env.CLUSTERFUN_DEV_CLIENT_PATH ?? "client";
const clusterfunRootFolder = path.join(__dirname, clientPath);
logger.logLine("Serving the Clusterfun from " + clusterfunRootFolder);
clusterFunApp.get("", (req, res) => {
  res.sendFile(`${clusterfunRootFolder}/index.html`);
  return;
});
clusterFunApp.use("/", express.static(clusterfunRootFolder));

//--------------------------------------------------------------------------------------
// Mount the ClusterFun app for every host. (It used to be behind
// vhost("localhost") to share the server with the now-removed HandsHigh app;
// with a single app that restriction only broke serving under the real
// clusterfun.tv Host header that the Cloudflare tunnel forwards.)
//--------------------------------------------------------------------------------------
app.use(clusterFunApp);

// ---------------------------------------------------------------------------------
// Message handling for the process
// ---------------------------------------------------------------------------------
process.on("exit", function () {
  // Write out any play counts still only in memory.  The store debounces its
  // writes, so a shutdown inside that window would otherwise lose them - and a
  // deploy restarts this process every time.
  serverModel.popularity.flush();
  logger.logLine(`*** PROCESS ${process.pid} EXIT`);
});

process.on("SIGTERM", (signal) => {
  logger.logLine(`*** PROCESS ${process.pid} received a SIGTERM signal`);
  process.exit(0);
});

process.on("SIGINT", (signal) => {
  logger.logLine(`*** PROCESS ${process.pid} has been interrupted`);
  process.exit(0);
});

// ---------------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------------
// Every minute: drop a little note in the logs and purge rooms.  Once every ten minutes
// was fine when a room lived for an hour regardless; now that an abandoned room is dropped
// after five minutes, checking ten-minutely would make the room count lag by more than the
// grace period it is meant to enforce.
setInterval(() => {
  logger.logLine(`I am alive: Roomcount:${serverModel.activeRoomCount}`);
  serverModel.purgeInactiveRooms();
}, 60000);

// ---------------------------------------------------------------------------------
// Let er rip!
// ---------------------------------------------------------------------------------
app.listen(portOverride, () => {
  logger.logLine(`Started clusterfun server on http://localhost:${portOverride}`);
});
