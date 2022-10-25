import express from 'express';
import express_ws from 'express-ws';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ClusterFunEventType, ServerModel } from './models/ServerModel.js';
import bodyParser from "body-parser";
import { Logger } from './helpers/consoleHelpers.js';
import { ApiHandler } from './apis/ApiHandlers.js';
import { version as VERSION } from './version.js';

const logger = new Logger();

// ---------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------
let portOverride = 8080;
if(process.env.PORT_OVERRIDE) portOverride = Number.parseInt(process.env.PORT_OVERRIDE)
export const StartTime = Date.now();

let killPath: string | undefined;
// Process Arguments
for(let arg of process.argv.slice(2))
{
    const parts = arg.split('=',2);
    if(parts[0].toLowerCase() === "killpath") {
        logger.logLine("**** Setting kill path to /" + parts[1] + " ****")
        killPath = parts[1];
    }
}


logger.logLine("##################################################################################")
logger.logLine("## Starting ClusterFun Server  v" + VERSION)


// ---------------------------------------------------------------------------------
// Set up models and base logic
// ---------------------------------------------------------------------------------
const app = express();
const app_ws = express_ws(app);
const serverModel = new ServerModel(logger);
const api = new ApiHandler(serverModel, logger);

// ---------------------------------------------------------------------------------
// Special request handling
// ---------------------------------------------------------------------------------
if(killPath) {
    // Set up kill path as first processor.  Invoking the server with the killpath
    // specified allows testing logic to easily start and stop the server during tests
    app.get("/" + killPath, (req, res) => {
        logger.logLine("Server was killed with killpath")
        res.end("Arrrgh!")
        process.exit(0);
    });
}

app.use(bodyParser.json());
app.use(function(req, res, next) {
    if(req.url.length < 2) {
        serverModel.logEvent(ClusterFunEventType.GetRequest, undefined, "ROOT")
    }
    logger.logLine(`Request: ${req.method}: ` + req.url)
    next();
});  

// ---------------------------------------------------------------------------------
// REST APIs / socket apis
// ---------------------------------------------------------------------------------
app.post("/api/startgame", api.startGame);
app.post("/api/joingame", api.joinGame);
app.post("/api/terminategame", api.terminateGame);
app.get("/api/am_i_healthy", api.showHealth);
app.get("/api/game_manifest", api.getGameManifest);

app_ws.app.ws('/talk/:roomId/:personalId', api.handleSocket);

// ---------------------------------------------------------------------------------
// Lobby setup
// ---------------------------------------------------------------------------------
// NOTE: This previously fetched "../../../frontend/build" in a production environment.
// The deploy system should instead either deploy the frontend and games to this
// "client" folder in dist, or the server should determine the path to the lobby from
// a manifest file
const clientPath = process.env.CLUSTERFUN_DEV_CLIENT_PATH ?? "client"
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const lobbyRoot = path.join(__dirname, clientPath);

logger.logLine("Serving the lobby from " + lobbyRoot);

app.get('', (req, res) => {
    res.sendFile(`${lobbyRoot}/index.html`);
    return;
})
app.use('/', express.static(lobbyRoot));

// ---------------------------------------------------------------------------------
// Message handling for the process
// ---------------------------------------------------------------------------------
process.on('exit', function () {
    logger.logLine(`*** PROCESS ${process.pid} EXIT`)
});

process.on('SIGTERM', signal => {
    logger.logLine(`*** PROCESS ${process.pid} received a SIGTERM signal`)
    process.exit(0)
})

process.on('SIGINT', signal => {
    logger.logLine(`*** PROCESS ${process.pid} has been interrupted`)
    process.exit(0)
})


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

