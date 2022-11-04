import { Logger } from "../helpers/consoleHelpers.js";
import { ServerModel } from "../models/ServerModel.js";
import { Request, Response } from "express";
import { WebSocket } from 'ws';

const CLOSECODE_POLICY_VIOLATION = 1008;
const CLOSECODE_WRONG_DATA = 1003;

const WEBSOCKET_PROTOCOL_HEADER = 'sec-websocket-protocol';
const SECRET_PREFIX = 'Secret';

// ---------------------------------------------------------------------------------
// UserError - throw a UserError if you want the error text to make it back to the user
// ---------------------------------------------------------------------------------
export class UserError {
    message:string; 
    constructor(message: string)
    {
        this.message = message;
    }
}

// ---------------------------------------------------------------------------------
// AuthorizationError - throw an AuthorizationError for auth problems
// ---------------------------------------------------------------------------------
export class AuthorizationError {
    message:string; 
    constructor(message: string)
    {
        this.message = message;
    }
}

export class ApiHandler {
    serverModel: ServerModel
    logger: Logger

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    constructor(serverModel: ServerModel, logger: Logger) {
        this.serverModel  = serverModel;
        this.logger = logger
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    async safeCall(req: Request, res: Response, label: string, runMe: () => Promise<any>) {
        try {
            const data = await runMe();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data, null, 2));
        }
        catch(err) {
            if(err instanceof UserError){
                const errorResponse = {
                    errorMessage: (err as UserError).message   
                }
                res.status(400).end(JSON.stringify(errorResponse, null, 2))
            }
            else {
                const timecode = Date.now();
                this.logger.logError(`Error at timecode ${timecode} on ${label}: ${err} ${JSON.stringify(err)}`)
                const errorResponse = {
                    errorMessage: `There was a server error in ${label}.  Reference timecode ${timecode}`   
                }
                res.status(500).end(JSON.stringify(errorResponse, null, 2))
            }
        }
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    showHealth = (req: Request, res: Response) => {
        this.safeCall(req, res, "ShowHealth", async () => {
            let span = req.query.span ? Number.parseInt(req.query.span as string) : 60000;
            let latest = req.query.latest ? Date.parse(req.query.latest as string) : Date.now();
            let earliest = req.query.earliest ? Date.parse(req.query.earliest as string) : 0;

            return this.serverModel.getHealthData(earliest, span, latest);
        })        
    };

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    getGameManifest = (req: Request, res: Response) => {
        this.safeCall(req, res, "GetGameManifest", async () => {
            return [ 
                { name: "Lexible", displayName: "Lexible", tags: ["alpha"], },
                { name: "Testato", displayName: "Testato", tags: ["debug"], } 
            ]
        })        
    };

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    startGame = (req: Request, res: Response) => {
        this.safeCall(req, res, "StartGame", async () => {
            if (!req.body) {
                throw new UserError("Missing Body for Start Game")
            }
        
            const { gameName, existingRoom } = req.body;
            if(existingRoom) {
                this.logger.logLine(`Existing room specified: ${JSON.stringify(existingRoom)}`)
            }
            const roomProperties = this.serverModel.startGame(gameName, existingRoom);
    
            return roomProperties;
        })
    };

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    joinGame = (req: Request, res: Response) => {
        this.safeCall(req, res, "JoinGame", async () => {
            if (!req.body) {
                throw new UserError("Missing Body for Join Game")
            }
        
            const { roomId, playerName } = req.body;
            const roomProperties = this.serverModel.joinGame(roomId, playerName);

            return roomProperties;
        })
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    terminateGame = (req: Request, res: Response) => {
        this.safeCall(req, res, "TerminateGame", async () => {
            if (!req.body) {
                throw new UserError("Missing Body for Terminate Game")
            }
        
            const { roomId, presenterSecret } = req.body;   
            this.serverModel.clearRoom(roomId, presenterSecret); 

            return {message: "OK"};
        })
    };

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    handleSocket = (ws: WebSocket, req: Request)  =>{
        if (!(WEBSOCKET_PROTOCOL_HEADER in req.headers)) {
            // there is no secret - close it pls
            this.logger.logLine('Got socket connection with no protocol header');
            ws.close(CLOSECODE_POLICY_VIOLATION);
            return;
        }
        const protocolsRaw = req.headers[WEBSOCKET_PROTOCOL_HEADER] as string | string[];
        const protocols = typeof protocolsRaw === 'string' ? [protocolsRaw] : protocolsRaw; 
        if (!protocols[0].startsWith(SECRET_PREFIX)) {
            // there is no secret
            this.logger.logLine('Secret not provided as first protocol');
            ws.close(CLOSECODE_POLICY_VIOLATION);
            return;
        }
    
        try {
            const personalSecret = protocols[0].substring(SECRET_PREFIX.length);
    
            const roomId: string = req.params.roomId;
            const personalId: string = req.params.personalId;
    
            const room = this.serverModel.getRoom(roomId);
            if(!room || room.idle) {
                this.logger.logLine(`Socket request with ID ${personalId}: Non-existent room: ${roomId}`);
                ws.close(CLOSECODE_POLICY_VIOLATION);
                return;
            }
    
            this.logger.logLine(`New Socket Request with ID ${personalId} for room ${roomId} (${room.game})`)
    
            room.setSocket(personalId, personalSecret, ws);
    
            ws.on('message',  (msgRaw) => {
                const messageJson = msgRaw.toString()
                this.serverModel.reportRecievedMessage(messageJson);
                try {
                    room.receiveMessage(personalId, messageJson);
                } catch (e) {
                    this.logger.logError(`Message parsing error: ${e}`);
                    ws.close(CLOSECODE_WRONG_DATA);
                    return;
                }
            });
            
            ws.on('close', (reason) => {
                this.logger.logLine(`Socket for room ${roomId} with ID ${personalId} closing because ${reason}`);
                room.removeSocket(personalId);
            });
        } catch (e) {
            this.serverModel.reportError("socket")
            this.logger.logError(`Socket message handler error: ${e}`);
            ws.close(CLOSECODE_POLICY_VIOLATION);
            return;
        }     
    }
}