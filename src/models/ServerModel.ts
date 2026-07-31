import { Room } from "./Room.js";
import { Logger } from "../helpers/consoleHelpers.js";
import { version as VERSION } from "../version.js";
import {
  generateRoomCode,
  generatePersonalId,
  generatePersonalSecret,
} from "../helpers/id-codes.js";
import { GameInstanceProperties } from "../libs/config/GameInstanceProperties.js";
import { PopularityStore } from "./PopularityStore.js";
import { HealthMetrics, HealthWindow } from "./HealthMetrics.js";
import os from "os";
import { UserError } from "../helpers/errors.js";

const cores = os.cpus();

interface ExistingRoomInfo {
  id: string;
  presenterId: string;
  presenterSecret: string;
}

export enum ClusterFunEventType {
  BadJoin = 0,
  BadRoomCreation,
  GeneralError,
  MessageSend,
  MessageReceive,
  GetRequest,
  EVENT_COUNT,
}

const eventNames = [
  "BadJoin",
  "BadRoomCreation",
  "GeneralError",
  "MessageSend",
  "MessageReceive",
  "GetRequest",
];
interface EventRecord {
  event: ClusterFunEventType;
  time: number;
  value?: number;
  info?: string;
}

//------------------------------------------------------------------------------------------
// The state of the server overall
//------------------------------------------------------------------------------------------
export class ServerModel {
  private rooms: Map<string, Room> = new Map<string, Room>();
  logger: Logger;

  // ClusterFun's own play counts, kept on disk so the lobby can order games by
  // what people actually play.  Separate from Google Analytics on purpose: the
  // lobby must be able to sort itself without a third party in the loop.
  readonly popularity: PopularityStore;

  startTime = Date.now();

  // What the server has been doing lately, in fixed buckets over the last week.  This
  // replaced an array of every event ever logged, which grew to a million records and then
  // discarded the oldest fifth - so under load it lost exactly the history worth having.
  readonly health = new HealthMetrics();
  summarySegment = new Map<string, { count: number; sum: number }>();
  get activeRoomCount() {
    return this.rooms.size;
  }

  private _trackedUsage = { user: 0, system: 0 };

  //------------------------------------------------------------------------------------------
  // ctor
  //------------------------------------------------------------------------------------------
  constructor(logger: Logger, popularity?: PopularityStore) {
    this.logger = logger;
    // Defaults to an in-memory store; the real server hands in a persistent one
    this.popularity = popularity ?? new PopularityStore();
    this.popularity.load();

    let lastUsage = process.cpuUsage();
    const secondsPerInterval = 2;
    const divisor = secondsPerInterval * 1000000.0 * cores.length;
    setInterval(() => {
      let currentUsage = process.cpuUsage();
      const deltaUsage = {
        user: currentUsage.user - lastUsage.user,
        system: currentUsage.system - lastUsage.system,
      };
      const newUser = deltaUsage.user / divisor;
      const newSystem = deltaUsage.system / divisor;
      this._trackedUsage.user = this._trackedUsage.user * 0.3 + newUser * 0.7;
      this._trackedUsage.system = this._trackedUsage.system * 0.3 + newSystem * 0.7;
      lastUsage = currentUsage;
      // The raw reading for this interval, not the smoothed one - averaging an already
      // smoothed value over a window would flatten every spike out of existence.
      this.health.sampleResources((newUser + newSystem) * 100, process.memoryUsage().rss);
    }, secondsPerInterval * 1000);
  }

  //--------------------------------------------------------------------------------------
  // logEvent
  //--------------------------------------------------------------------------------------
  logEvent(
    event: ClusterFunEventType,
    value: number | undefined = undefined,
    info: string | undefined = undefined,
  ) {
    const newRecord: EventRecord = { event, time: Date.now(), value, info };
    this.addToSegment(this.summarySegment, newRecord);

    switch (event) {
      case ClusterFunEventType.MessageSend:
        this.health.recordSentMessage(value ?? 0);
        break;
      case ClusterFunEventType.MessageReceive:
        this.health.recordReceivedMessage(value ?? 0);
        break;
      case ClusterFunEventType.BadJoin:
        this.health.recordInvalidRoomJoin();
        break;
      case ClusterFunEventType.GeneralError:
      case ClusterFunEventType.BadRoomCreation:
        this.health.recordError();
        break;
    }
  }

  //------------------------------------------------------------------------------------------
  //
  //------------------------------------------------------------------------------------------
  reportSentMessage(message: string) {
    this.logEvent(ClusterFunEventType.MessageSend, message.length);
  }

  //------------------------------------------------------------------------------------------
  //
  //------------------------------------------------------------------------------------------
  reportRecievedMessage(message: string) {
    this.logEvent(ClusterFunEventType.MessageReceive, message.length);
  }

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  reportError(errorType: string) {
    this.logEvent(ClusterFunEventType.GeneralError, undefined, errorType);
  }

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  addToSegment = (segment: Map<string, { count: number; sum: number }>, ev: EventRecord) => {
    let segmentKey = eventNames[ev.event];
    if (
      ev.event === ClusterFunEventType.GeneralError ||
      ev.event === ClusterFunEventType.GetRequest
    )
      segmentKey += `_${ev.info}`;
    if (!segment?.has(segmentKey)) segment?.set(segmentKey, { count: 0, sum: 0 });
    const datum = segment.get(segmentKey)!;
    datum.count++;
    if (ev.value) datum.sum += ev.value;
  };

  //------------------------------------------------------------------------------------------
  // How long this process has been up, as "days hh:mm:ss".
  //------------------------------------------------------------------------------------------
  get uptimeText(): string {
    let upTime = Date.now() - this.startTime;
    const msPerDay = 1000 * 3600 * 24;
    const days = Math.floor(upTime / msPerDay);
    upTime %= msPerDay;
    const msPerHour = 1000 * 3600;
    const hours = Math.floor(upTime / msPerHour);
    upTime %= msPerHour;
    const minutes = Math.floor(upTime / 60000);
    upTime %= 60000;
    const seconds = Math.floor(upTime / 1000);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${days} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  //------------------------------------------------------------------------------------------
  // The instantaneous side of the health report: what is going on in this second.
  //------------------------------------------------------------------------------------------
  get roomSummary() {
    const allRooms = Array.from(this.rooms.values());
    return {
      roomCount: this.rooms.size,
      activeRooms: allRooms.reduce((total, room) => total + (room.isActive ? 1 : 0), 0),
      activeUsers: allRooms.reduce(
        (total, room) => (total += room.isActive ? room.userCount : 0),
        0,
      ),
    };
  }

  //------------------------------------------------------------------------------------------
  // Everything the health page shows: the windowed metrics plus the live counts.
  //------------------------------------------------------------------------------------------
  getHealthReport(): {
    version: string;
    uptime: string;
    windows: HealthWindow[];
    rooms: { roomCount: number; activeRooms: number; activeUsers: number };
  } {
    return {
      version: VERSION,
      uptime: this.uptimeText,
      windows: this.health.report(),
      rooms: this.roomSummary,
    };
  }

  //------------------------------------------------------------------------------------------
  // The same numbers as JSON, for the Stressato load-test game, which watches the server
  // while it hammers it.  The health page is for people; this is for a program.
  //------------------------------------------------------------------------------------------
  getHealthData() {
    return {
      version: VERSION,
      uptime: this.uptimeText,
      rooms: this.roomSummary,
      summary: Array.from(this.summarySegment.keys()).map((sk) => ({
        label: sk,
        data: this.summarySegment.get(sk)!,
      })),
      windows: this.health.report(),
      cpuUsage: this._trackedUsage,
      memoryUsage: process.memoryUsage(),
    };
  }

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  startGame(gameName: string, existingRoom: ExistingRoomInfo) {
    if (!gameName) {
      throw Error("Game name not specified");
    }

    let roomId = generateRoomCode();
    let personalId = generatePersonalId();
    let personalSecret = generatePersonalSecret();

    if (existingRoom && this.reuseRoom(gameName, existingRoom)) {
      this.logger.logLine(`Reusing room id: ${existingRoom.id} for ${gameName}`);
      roomId = existingRoom.id;
      personalId = existingRoom.presenterId;
      personalSecret = existingRoom.presenterSecret;
    } else {
      while (this.hasRoom(roomId)) {
        roomId = generateRoomCode();
      }
      this.createRoom(roomId, gameName as string, personalId, personalSecret);
      this.logger.logLine(`Created a new room id: ${roomId} for ${gameName}`);
    }
    // One "play" per room opened.  Reusing a room (the presenter restarting
    // into the same code) counts too - it is another sitting of the game.
    this.popularity.recordPlay(gameName);

    const presenterId = personalId;

    const properties: GameInstanceProperties = {
      gameName,
      roomId,
      personalId,
      presenterId,
      personalSecret,
      role: "presenter",
    };

    return properties;
  }

  //--------------------------------------------------------------------------------------
  //
  //--------------------------------------------------------------------------------------
  joinGame(roomId: string, playerName: string) {
    if (!roomId || roomId.length > 4) {
      throw Error(`Invalid Room Code (${roomId})`);
    }
    if (!playerName || playerName.length > 16) {
      throw Error(`Invalid Player name: (${playerName})`);
    }

    const personalId = generatePersonalId();
    const personalSecret = generatePersonalSecret();

    const room = this.joinPersonToRoom(playerName, personalId, personalSecret, roomId);
    const presenterId = room.presenterId;
    const gameName = room.game;
    this.popularity.recordJoin(gameName);

    const properties: GameInstanceProperties = {
      gameName,
      roomId,
      personalId,
      presenterId,
      personalSecret,
      role: "client",
    };
    return properties;
  }

  //------------------------------------------------------------------------------------------
  //
  //------------------------------------------------------------------------------------------
  reuseRoom(
    gameName: string,
    existingRoom: { id: string; presenterId: string; presenterSecret: string },
  ) {
    const room = this.rooms.get(existingRoom.id);
    if (!room || !room.validatePresenter(existingRoom.presenterId, existingRoom.presenterSecret)) {
      return false;
    }

    room.game = gameName;
    room.idle = false;
    return true;
  }

  //------------------------------------------------------------------------------------------
  // Create a room and add it to the list
  //------------------------------------------------------------------------------------------
  createRoom(id: string, game: string, presenterId: string, presenterSecret: string) {
    if (!this.rooms.has(id)) {
      this.rooms.set(id, new Room(id, this, game, presenterId, presenterSecret, this.logger));
    } else {
      this.logEvent(ClusterFunEventType.GeneralError, undefined, "Room Exists");
      throw new Error("Room already exists");
    }
  }

  //------------------------------------------------------------------------------------------
  // Indicate game is done for this room
  //------------------------------------------------------------------------------------------
  clearRoom(roomId: string, presenterSecret: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("removeRoom: Could not find room with id " + roomId);
    const foundEndpoint = Array.from(room.endpoints.values()).find(
      (e) => e.secret === presenterSecret,
    );
    if (!foundEndpoint)
      throw new Error(`removeRoom: Secret ${presenterSecret} not found in roomId ${roomId} `);
    if (room.presenterId != foundEndpoint.id)
      throw new Error("removeRoom: presenterSecret does not belong to the presenter!");
    room.clear();
  }

  //------------------------------------------------------------------------------------------
  // return true if roomid exists
  //------------------------------------------------------------------------------------------
  hasRoom(id: string) {
    return this.rooms.has(id);
  }

  //------------------------------------------------------------------------------------------
  // joinPersonToRoom
  //------------------------------------------------------------------------------------------
  joinPersonToRoom(name: string, playerId: string, playerSecret: string, roomId: string) {
    this.logger.logLine(`Join: Room: ${roomId}, Player: ${playerId}, Name: ${name}`);

    // A code that is simply not open is the single most common join failure -
    // a typo, or a room that was purged after an hour idle.  It used to throw a
    // plain Error, which safeCall turns into a 500 "server error, reference
    // timecode": indistinguishable from a real crash, and the reason was only
    // visible in this server's log.  As a UserError it comes back as a 400 with
    // a message the player can act on.
    const room = this.rooms.get(roomId);
    if (!room) {
      this.logEvent(ClusterFunEventType.BadJoin, undefined, `Join: no open room ${roomId}`);
      throw new UserError(
        `Room ${roomId} is not open. Check the code on the big screen - and note that a room closes after an hour of quiet.`,
      );
    }

    room.addEndpoint(playerId, playerSecret, name);

    return room;
  }

  //------------------------------------------------------------------------------------------
  // getRoom
  //------------------------------------------------------------------------------------------
  getRoom(roomId: string) {
    return this.rooms.get(roomId);
  }

  //------------------------------------------------------------------------------------------
  // purgeInactiveRooms
  //------------------------------------------------------------------------------------------
  purgeInactiveRooms() {
    this.logger.logLine("Purging rooms...");
    const purgeMe = Array.from(this.rooms.values()).filter((r) => !r.isActive);
    for (const room of purgeMe) {
      this.logger.logLine("Purging inactive room " + room.id);
      this.rooms.delete(room.id);
    }
  }
}
