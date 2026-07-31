import express from "express";
import express_ws from "express-ws";
import * as path from "path";
import { fileURLToPath } from "url";
import { ClusterFunEventType, ServerModel } from "./models/ServerModel.js";
import { PopularityStore, defaultPopularityPath } from "./models/PopularityStore.js";
import bodyParser from "body-parser";
import { Logger } from "./helpers/consoleHelpers.js";
import { ApiHandler } from "./apis/ApiHandlers.js";
import { defaultMusicFolder, musicCacheControl } from "./helpers/musicFolder.js";
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

clusterFunApp.use(bodyParser.json());
clusterFunApp.use(function (req, res, next) {
  if (req.url.length < 2) {
    serverModel.logEvent(ClusterFunEventType.GetRequest, undefined, "ROOT");
  }
  logger.logLine(`Request: ${req.method}: ` + req.url);
  next();
});

// Clusterfun APIs
clusterFunApp.post("/api/startgame", api.startGame);
clusterFunApp.post("/api/joingame", api.joinGame);
clusterFunApp.post("/api/terminategame", api.terminateGame);
clusterFunApp.get("/api/am_i_healthy", api.showHealth);
clusterFunApp.get("/api/game_manifest", api.getGameManifest);
clusterFunApp.get("/api/game_popularity", api.getGamePopularity);

clusterFunApp_ws.app.ws("/talk/:roomId/:personalId", api.handleSocket);

// Background music, served by us rather than a third party so there is no other service to
// depend on and no CORS to configure - it is the same origin as the app.  The folder sits
// outside the deploy folder (deployit.sh wipes that), so tracks survive deploys and can be
// added or replaced by dropping files in, with no rebuild.  A missing folder simply 404s,
// which the client treats as "no music".
const musicFolder = defaultMusicFolder();
logger.logLine("Serving background music from " + musicFolder);
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
// Every 10 minutes: Drop a little note in the logs and purge rooms
setInterval(() => {
  logger.logLine(`I am alive: Roomcount:${serverModel.activeRoomCount}`);
  serverModel.purgeInactiveRooms();
}, 600000);

// ---------------------------------------------------------------------------------
// Let er rip!
// ---------------------------------------------------------------------------------
app.listen(portOverride, () => {
  logger.logLine(`Started clusterfun server on http://localhost:${portOverride}`);
});
