import { Logger } from "../helpers/consoleHelpers.js";
import { ServerModel } from "../models/ServerModel.js";
import { Request, Response } from "express";
import { WebSocket } from 'ws';

const CLOSECODE_POLICY_VIOLATION = 1008;
const CLOSECODE_WRONG_DATA = 1003;

const WEBSOCKET_PROTOCOL_HEADER = 'sec-websocket-protocol';
const SECRET_PREFIX = 'Secret';

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
    serverError(res: Response, err: any, errorType: string) {
        this.serverModel.reportError(errorType)
        const key = Date.now();
        this.logger.logError(`API Error: key: ${key} :${err as any}`);
        res.status(400).end(`Server error.  Key = ${key} `);
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    showHealth = (req: Request, res: Response) => {

        let span = req.query.span ? Number.parseInt(req.query.span as string) : 60000;
        let latest = req.query.latest ? Date.parse(req.query.latest as string) : Date.now();
        let earliest = req.query.earliest ? Date.parse(req.query.earliest as string) : 0;

        res.end(JSON.stringify(this.serverModel.getHealthData(earliest, span, latest), null,2));
    };

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    startGame = (req: Request, res: Response) => {

        if (!req.body) {
            res.status(400).end("Missing body");
            return;
        }
    
        try {
            const { gameName, existingRoom } = req.body;
            if(existingRoom) {
                this.logger.logLine(`Exisintg room specified: ${JSON.stringify(existingRoom)}`)
            }
            const roomProperties = this.serverModel.startGame(gameName, existingRoom);
    
            res.end(JSON.stringify(roomProperties));
        }
        catch (err)
        {
            this.serverError(res, err, "startGame")
            return;
        }
    };

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    joinGame = (req: Request, res: Response) => {
        if (!req.body) {
            res.status(400).end("Pls snd body");
            return;
        }
    
        try {
            const { roomId, playerName } = req.body;
            const roomProperties = this.serverModel.joinGame(roomId, playerName);

            res.end(JSON.stringify(roomProperties));
            return;
        } 
        catch (err)
        {
            this.serverError(res, err, "roomJoinError")
            return;
        }
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    terminateGame = (req: Request, res: Response) => {

        if (!req.body) {
            res.status(400).end("IIIIIII ain't go no body");
            return;
        }
    
        try {
            const { roomId, presenterSecret } = req.body;   
            this.serverModel.clearRoom(roomId, presenterSecret); 
            res.end(JSON.stringify({message: "OK"}));
        }
        catch (err)
        {
            this.serverError(res, err, "terminateGame")
        }
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