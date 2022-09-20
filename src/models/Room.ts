import * as crypto from 'crypto';
import * as ws from 'ws';
import { Logger } from "../helpers/consoleHelpers";
import { ClusterFunMessageBase, ClusterFunSerializer } from '../libs/comms';
import { ServerModel } from "./ServerModel";

// Hack because the server uses Node v10
export const theTextEncoder = require("util").TextEncoder; 

export interface Endpoint {
    id: string;
    secret: string;
    name: string;
    socket?: ws;
}

const ONE_HOUR = 3600 * 1000

//------------------------------------------------------------------------------------------
// Room Class
//------------------------------------------------------------------------------------------
export class Room {
    id: string;
    endpoints: Map<string, Endpoint>;
    presenterId: string;
    game: string;
    lastMessageTime = Date.now();
    serializer: ClusterFunSerializer;
    logger: Logger
    idle = false;
    serverModel: ServerModel

    // Active means any messages in the last 10 minutes
    get isActive() { return (Date.now() - this.lastMessageTime ) < ONE_HOUR}

    get userCount() { return Array.from(this.endpoints.values()).reduce(
            (total: number, ep: Endpoint) => total + ((ep.name != "presenter" && ep.socket != null) ? 1 : 0),0) }

    //------------------------------------------------------------------------------------------
    // ctor
    //------------------------------------------------------------------------------------------
    constructor(id: string, serverModel: ServerModel, game: string, presenterId: string, presenterSecret: string, logger: Logger) {
        this.logger = logger;
        this.id = id;
        this.serverModel = serverModel;
        this.game = game;
        this.presenterId = presenterId;
        this.endpoints = new Map<string, Endpoint>();
        this.serializer = new ClusterFunSerializer();
        this.addEndpoint(presenterId, presenterSecret, 'presenter');
    }

    //------------------------------------------------------------------------------------------
    // clear
    //------------------------------------------------------------------------------------------
    clear() {
        // delete everyone but the presenter
        Array.from(this.endpoints.keys())
            .filter(k => k != this.presenterId)
            .forEach(k=> {
                this.endpoints.get(k)?.socket?.close();
                this.endpoints.delete(k)
            } )  
        this.idle = true; 
    }

    //------------------------------------------------------------------------------------------
    // validatePresenter
    //------------------------------------------------------------------------------------------
    validatePresenter(id: string, secret: string) {
        const player = this.endpoints.get(id);
        const isValid = player && player.secret === secret
        return isValid
    }

    //------------------------------------------------------------------------------------------
    // addEndpoint
    //------------------------------------------------------------------------------------------
    addEndpoint(id: string, secret: string, name: string) {
        this.endpoints.set(id, { id, secret, name });
    }

    //------------------------------------------------------------------------------------------
    // setSocket
    //------------------------------------------------------------------------------------------
    setSocket(id: string, allegedSecret: string, socket: ws) {
        const endpoint = this.endpoints.get(id);
        if(!endpoint) {
            throw new Error(`setSocket couldn't find player with id ${id}, in room ${this.id}`);
        }
        if (!crypto.timingSafeEqual(Buffer.from(allegedSecret, 'utf-8'), Buffer.from(endpoint.secret, 'utf-8'))) {
            throw new Error(`setSocket got a bad secret for player with id ${id}, in room ${this.id}`);
        }
        
        endpoint.socket = socket;
    }

    //------------------------------------------------------------------------------------------
    // removeSocket
    //------------------------------------------------------------------------------------------
    removeSocket(id: string) {
        const endpoint = this.endpoints.get(id);
        if (endpoint) {
            delete endpoint.socket;
        }
    }

    //------------------------------------------------------------------------------------------
    // sendMessage
    //------------------------------------------------------------------------------------------
    receiveMessage(sender: string, message: string) {
        
        const header = this.serializer.deserializeHeaderOnly(message);
        if (header.s !== sender) {
            throw new Error("Sender " + sender + " included non-matching sender " + header.s);
        }
        this.sendMessageInternal(header.r, sender, message);
    }

    //------------------------------------------------------------------------------------------
    // sendMessage
    //------------------------------------------------------------------------------------------
    sendMessage(receiver: string, sender: string, message: ClusterFunMessageBase)
    {
        const serializedMessage = this.serializer.serialize(receiver, sender, message);
        this.sendMessageInternal(receiver, sender, serializedMessage);
    }

    //------------------------------------------------------------------------------------------
    // sendMessageInternal
    //------------------------------------------------------------------------------------------
    private sendMessageInternal(receiver: string, _sender: string, serializedMessage: string)
    {
        this.lastMessageTime = Date.now();
        this.serverModel.reportSentMessage(serializedMessage)
        const endpoint = this.endpoints.get(receiver);
        if(!endpoint) {
            this.logger.logError(`No endpoint found for ${receiver}`)
        }
        else if(!endpoint.socket) {
            this.logger.logError(`No socket found for ${receiver}`)
        }
        else {
            try {
                endpoint.socket.send(serializedMessage);
            } catch (e) {
                console.error("Error encountered while sending message: ", e)
            }

        }
    }
}