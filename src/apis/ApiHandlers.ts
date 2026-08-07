import { Logger } from "../helpers/consoleHelpers.js";
import { ServerModel } from "../models/ServerModel.js";
import { Request, Response } from "express";
import { WebSocket } from "ws";
import { UserError } from "../helpers/errors.js";
import { renderHealthPage } from "../helpers/healthPage.js";

const CLOSECODE_POLICY_VIOLATION = 1008;
const CLOSECODE_WRONG_DATA = 1003;

const WEBSOCKET_PROTOCOL_HEADER = "sec-websocket-protocol";
const SECRET_PREFIX = "Secret";

// Re-exported so the many existing importers of ApiHandlers keep working
export { UserError, AuthorizationError } from "../helpers/errors.js";

export class ApiHandler {
  serverModel: ServerModel;
  logger: Logger;

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  constructor(serverModel: ServerModel, logger: Logger) {
    this.serverModel = serverModel;
    this.logger = logger;
  }

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  async safeCall(req: Request, res: Response, label: string, runMe: () => Promise<any>) {
    try {
      const data = await runMe();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data, null, 2));
    } catch (err) {
      if (err instanceof UserError) {
        const errorResponse = {
          errorMessage: (err as UserError).message,
        };
        res.status(400).end(JSON.stringify(errorResponse, null, 2));
      } else {
        const timecode = Date.now();
        this.logger.logError(
          `Error at timecode ${timecode} on ${label}: ${err} ${JSON.stringify(err)}`,
        );
        const errorResponse = {
          errorMessage: `There was a server error in ${label}.  Reference timecode ${timecode}`,
        };
        res.status(500).end(JSON.stringify(errorResponse, null, 2));
      }
    }
  }

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  // A page rather than a payload: this is the thing somebody opens on their phone when
  // they want to know whether the server is unwell, so it renders itself.
  showHealth = (req: Request, res: Response) => {
    try {
      const report = this.serverModel.getHealthReport();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(renderHealthPage({ ...report, generatedAt: new Date().toISOString() }));
    } catch (err) {
      const timecode = Date.now();
      this.logger.logError(`Error at timecode ${timecode} on ShowHealth: ${err}`);
      res.status(500).setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<h1>Health page failed</h1><p>Reference timecode ${timecode}</p>`);
    }
  };

  // The same numbers as JSON, for the Stressato load-test game.
  getHealthData = (req: Request, res: Response) => {
    this.safeCall(req, res, "GetHealthData", async () => this.serverModel.getHealthData());
  };

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  // ---------------------------------------------------------------------------------
  // getGamePopularity - ClusterFun's own play counts, used by the lobby to order
  // the game list.  Anonymous aggregate counts only: how many times each game has
  // been opened and joined, never by whom.
  // ---------------------------------------------------------------------------------
  getGamePopularity = (req: Request, res: Response) => {
    this.safeCall(req, res, "GetGamePopularity", async () => {
      return this.serverModel.popularity.report();
    });
  };

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  getGameManifest = (req: Request, res: Response) => {
    this.safeCall(req, res, "GetGameManifest", async () => {
      return [
        { name: "PassTheAux", displayName: "Pass the AUX (Mixtape)", tags: ["alpha"] },
        { name: "PartyPix", displayName: "PartyPix", tags: ["alpha"] },
        { name: "Lexible", displayName: "Lexible", tags: ["alpha"] },
        { name: "RetroSpectro", displayName: "Retro Spectro", tags: ["alpha"] },
        { name: "Eittris", displayName: "EITtris", tags: ["beta"] },
        { name: "OneOhOne", displayName: "101", tags: ["alpha"] },
        { name: "Stressato", displayName: "Stress Test", tags: ["debug"] },
      ];
    });
  };

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  startGame = (req: Request, res: Response) => {
    this.safeCall(req, res, "StartGame", async () => {
      if (!req.body) {
        throw new UserError("Missing Body for Start Game");
      }

      const { gameName, existingRoom } = req.body;
      if (existingRoom) {
        this.logger.logLine(`Existing room specified: ${JSON.stringify(existingRoom)}`);
      }
      const roomProperties = this.serverModel.startGame(gameName, existingRoom);

      return roomProperties;
    });
  };

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  joinGame = (req: Request, res: Response) => {
    this.safeCall(req, res, "JoinGame", async () => {
      if (!req.body) {
        throw new UserError("Missing Body for Join Game");
      }

      const { roomId, playerName } = req.body;
      const roomProperties = this.serverModel.joinGame(roomId, playerName);

      return roomProperties;
    });
  };

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  terminateGame = (req: Request, res: Response) => {
    this.safeCall(req, res, "TerminateGame", async () => {
      if (!req.body) {
        throw new UserError("Missing Body for Terminate Game");
      }

      const { roomId, presenterSecret } = req.body;
      this.serverModel.clearRoom(roomId, presenterSecret);

      return { message: "OK" };
    });
  };

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  handleSocket = (ws: WebSocket, req: Request) => {
    if (!(WEBSOCKET_PROTOCOL_HEADER in req.headers)) {
      // there is no secret - close it pls
      this.logger.logLine("Got socket connection with no protocol header");
      ws.close(CLOSECODE_POLICY_VIOLATION);
      return;
    }
    const protocolsRaw = req.headers[WEBSOCKET_PROTOCOL_HEADER] as string | string[];
    const protocols = typeof protocolsRaw === "string" ? [protocolsRaw] : protocolsRaw;
    if (!protocols[0].startsWith(SECRET_PREFIX)) {
      // there is no secret
      this.logger.logLine("Secret not provided as first protocol");
      ws.close(CLOSECODE_POLICY_VIOLATION);
      return;
    }

    try {
      const personalSecret = protocols[0].substring(SECRET_PREFIX.length);

      const roomId: string = req.params.roomId;
      const personalId: string = req.params.personalId;

      const room = this.serverModel.getRoom(roomId);
      if (!room || room.idle) {
        this.logger.logLine(`Socket request with ID ${personalId}: Non-existent room: ${roomId}`);
        ws.close(CLOSECODE_POLICY_VIOLATION);
        return;
      }

      this.logger.logLine(
        `New Socket Request with ID ${personalId} for room ${roomId} (${room.game})`,
      );

      room.setSocket(personalId, personalSecret, ws);

      ws.on("message", (msgRaw) => {
        const messageJson = msgRaw.toString();
        this.serverModel.reportRecievedMessage(messageJson);
        try {
          room.receiveMessage(personalId, messageJson);
        } catch (e) {
          this.logger.logError(`Message parsing error: ${e}`);
          ws.close(CLOSECODE_WRONG_DATA);
          return;
        }
      });

      ws.on("close", (reason) => {
        this.logger.logLine(
          `Socket for room ${roomId} with ID ${personalId} closing because ${reason}`,
        );
        room.removeSocket(personalId);
      });
    } catch (e) {
      this.serverModel.reportError("socket");
      this.logger.logError(`Socket message handler error: ${e}`);
      ws.close(CLOSECODE_POLICY_VIOLATION);
      return;
    }
  };
}
