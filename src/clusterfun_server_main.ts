import express from 'express';
import express_ws from 'express-ws';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ClusterFunEventType, ServerModel } from './models/ServerModel.js';
import bodyParser from "body-parser";
import { Logger } from './helpers/consoleHelpers.js';
import { ApiHandler } from './apis/ApiHandlers.js';
import { version as VERSION } from './version.js';
import vhost from 'vhost';

//--------------------------------------------------------------------------------------
// Local logging and evironment
//--------------------------------------------------------------------------------------
const logger = new Logger();
logger.logLine("##################################################################################")
logger.logLine("## Starting ClusterFun Server  v" + VERSION)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


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

// ---------------------------------------------------------------------------------
// Set up models and base logic
// ---------------------------------------------------------------------------------
const serverModel = new ServerModel(logger);
const api = new ApiHandler(serverModel, logger);

//--------------------------------------------------------------------------------------
// CLUSTERFUN app setup
//--------------------------------------------------------------------------------------
const clusterFunApp = express();
const clusterFunApp_ws = express_ws(clusterFunApp);

if(killPath) {
    // Set up kill path as first processor.  Invoking the server with the killpath
    // specified allows testing logic to easily start and stop the server during tests
    clusterFunApp.get("/" + killPath, (req, res) => {
        logger.logLine("Server was killed with killpath")
        res.end("Arrrgh!")
        process.exit(0);
    });
}

clusterFunApp.use(bodyParser.json());
clusterFunApp.use(function(req, res, next) {
    if(req.url.length < 2) {
        serverModel.logEvent(ClusterFunEventType.GetRequest, undefined, "ROOT")
    }
    logger.logLine(`Request: ${req.method}: ` + req.url)
    next();
});  

// Clusterfun APIs
clusterFunApp.post("/api/startgame", api.startGame);
clusterFunApp.post("/api/joingame", api.joinGame);
clusterFunApp.post("/api/terminategame", api.terminateGame);
clusterFunApp.get("/api/am_i_healthy", api.showHealth);
clusterFunApp.get("/api/game_manifest", api.getGameManifest);

clusterFunApp_ws.app.ws('/talk/:roomId/:personalId', api.handleSocket);

const clientPath = process.env.CLUSTERFUN_DEV_CLIENT_PATH ?? "client"
const clusterfunRootFolder = path.join(__dirname, clientPath);
logger.logLine("Serving the Clusterfun from " + clusterfunRootFolder);
clusterFunApp.get('', (req, res) => {
    res.sendFile(`${clusterfunRootFolder}/index.html`);
    return;
})
clusterFunApp.use('/', express.static(clusterfunRootFolder));


//--------------------------------------------------------------------------------------
// HANDSHIGH app setup
//--------------------------------------------------------------------------------------
const handsHighApp = express();
handsHighApp.use(function(req, res, next) {
    logger.logLine(`HH Request: ${req.method}: ${req.url}`)
    next();
});  

const handsHighPath =  process.env.HANDSHIGH_DEV_CLIENT_PATH ?? "HandsHigh"
const handsHighRoot = path.join(__dirname, handsHighPath);
logger.logLine("Serving the HandsHigh from " + handsHighRoot);

// React: Any kind of a normal routed path should go to the index
handsHighApp.get('*', (req, res, next) => {
    if(req.path.indexOf('.') > -1) {
        next();
        return;
    }
    res.sendFile(`${handsHighRoot}/index.html`);
    return;
})
handsHighApp.use(express.static(handsHighRoot, {redirect: false}))

//--------------------------------------------------------------------------------------
// VIRTUAL HOST app setup
//--------------------------------------------------------------------------------------
const app = express();
app.use(vhost('handshigh.localhost', handsHighApp))
app.use(vhost('localhost', clusterFunApp))


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

