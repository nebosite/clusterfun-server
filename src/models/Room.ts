import * as crypto from "crypto";
import { WebSocket } from "ws";
import { Logger } from "../helpers/consoleHelpers.js";
import { ClusterFunMessageHeader } from "../libs/comms/ClusterFunMessageHeader.js";
import { ServerModel } from "./ServerModel.js";

export interface Endpoint {
  id: string;
  secret: string;
  name: string;
  socket?: WebSocket;
}

// Regex for finding the message header.
// The header is a JSON object never containing the ^ character,
// followed by a ^ character. The Regex captures the JSON object
// as "header"
const MESSAGE_HEADER_REGEX = /^(?<header>{[^^]*})\^/;
const ONE_HOUR = 3600 * 1000;

//------------------------------------------------------------------------------------------
// Room Class
//------------------------------------------------------------------------------------------
export class Room {
  id: string;
  endpoints: Map<string, Endpoint>;
  presenterId: string;
  game: string;
  lastMessageTime = Date.now();
  // When somebody last had a socket open here.  Kept separate from lastMessageTime so an
  // empty room can be told apart from a quiet one.
  private lastConnectedTime = Date.now();
  logger: Logger;
  idle = false;
  serverModel: ServerModel;

  // Active means any messages in the last 10 minutes
  get isActive() {
    return Date.now() - this.lastMessageTime < ONE_HOUR;
  }

  /** How many participants - presenter included - currently hold a socket. */
  get connectionCount() {
    return Array.from(this.endpoints.values()).reduce(
      (total: number, ep: Endpoint) => total + (ep.socket != null ? 1 : 0),
      0,
    );
  }

  /**
   * A room nobody has been connected to for a while.  "Recent traffic" is not enough to
   * call a room live: every game anyone has opened in the last hour looked active, so a
   * few minutes of testing left the health page claiming seven rooms when one was in use.
   * A grace period rather than an instant check, because refreshing the presenter drops
   * every socket for a moment and that must not bin the game.
   */
  isAbandoned(graceMs: number) {
    return this.connectionCount === 0 && Date.now() - this.lastConnectedTime > graceMs;
  }

  get userCount() {
    return Array.from(this.endpoints.values()).reduce(
      (total: number, ep: Endpoint) =>
        total + (ep.name != "presenter" && ep.socket != null ? 1 : 0),
      0,
    );
  }

  //------------------------------------------------------------------------------------------
  // ctor
  //------------------------------------------------------------------------------------------
  constructor(
    id: string,
    serverModel: ServerModel,
    game: string,
    presenterId: string,
    presenterSecret: string,
    logger: Logger,
  ) {
    this.logger = logger;
    this.id = id;
    this.serverModel = serverModel;
    this.game = game;
    this.presenterId = presenterId;
    this.endpoints = new Map<string, Endpoint>();
    this.addEndpoint(presenterId, presenterSecret, "presenter");
  }

  //------------------------------------------------------------------------------------------
  // clear
  //------------------------------------------------------------------------------------------
  clear() {
    // delete everyone but the presenter
    Array.from(this.endpoints.keys())
      .filter((k) => k != this.presenterId)
      .forEach((k) => {
        this.endpoints.get(k)?.socket?.close();
        this.endpoints.delete(k);
      });
    this.idle = true;
  }

  //------------------------------------------------------------------------------------------
  // validatePresenter
  //------------------------------------------------------------------------------------------
  validatePresenter(id: string, secret: string) {
    const player = this.endpoints.get(id);
    const isValid = player && player.secret === secret;
    return isValid;
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
  setSocket(id: string, allegedSecret: string, socket: WebSocket) {
    this.lastConnectedTime = Date.now();
    const endpoint = this.endpoints.get(id);
    if (!endpoint) {
      throw new Error(`setSocket couldn't find player with id ${id}, in room ${this.id}`);
    }
    if (
      !crypto.timingSafeEqual(
        Buffer.from(allegedSecret, "utf-8"),
        Buffer.from(endpoint.secret, "utf-8"),
      )
    ) {
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
    // Body only in a local run.  The thunk matters as much as the flag: building
    // "Received message: " + message allocates the whole 133KB of a PartyPix upload
    // even when nothing is going to print it.
    this.logger.logVerbose(() => "Received message: " + message);
    const headerMatch = message.match(MESSAGE_HEADER_REGEX);
    if (!headerMatch) {
      throw new Error("Received a message with an invalid header");
    }
    // Deserialize the header from the header string
    const header = JSON.parse(headerMatch.groups!["header"]) as ClusterFunMessageHeader;
    if (header.s !== sender) {
      throw new Error("Sender " + sender + " included non-matching sender " + header.s);
    }
    this.sendMessageInternal(header.r, sender, message);
  }

  //------------------------------------------------------------------------------------------
  // sendMessageInternal
  //------------------------------------------------------------------------------------------
  private sendMessageInternal(receiver: string, _sender: string, serializedMessage: string) {
    this.lastMessageTime = Date.now();
    const endpoint = this.endpoints.get(receiver);
    // A message is only "sent" once it is actually on a socket.  Counting it before
    // looking for the recipient made bytes-sent equal bytes-received by construction, and
    // hid the one thing the pair can usefully tell you: that traffic is going nowhere
    // because somebody's socket has gone away.
    if (!endpoint) {
      this.logger.logError(`No endpoint found for ${receiver}`);
      this.serverModel.reportUndeliveredMessage("no endpoint");
    } else if (!endpoint.socket) {
      this.logger.logError(`No socket found for ${receiver}`);
      this.serverModel.reportUndeliveredMessage("no socket");
    } else {
      try {
        endpoint.socket.send(serializedMessage);
        this.serverModel.reportSentMessage(serializedMessage);
      } catch (e) {
        console.error("Error encountered while sending message: ", e);
        this.serverModel.reportUndeliveredMessage("send failed");
      }
    }
  }
}
