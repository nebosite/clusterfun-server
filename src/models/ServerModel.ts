import { Room } from "./Room.js";
import { Logger } from "../helpers/consoleHelpers.js";
import { version as VERSION } from "../version.js";
import { generateRoomCode, generatePersonalId, generatePersonalSecret } from "../helpers/id-codes.js";
import { GameInstanceProperties } from "../libs/config/GameInstanceProperties.js";
import os from 'os';
import { GameRole } from "../libs/config/GameRole.js";

const cores = os.cpus();

interface ExistingRoomInfo {
    id: string
    presenterId: string
    presenterSecret: string  
}

export enum ClusterFunEventType {
    BadJoin = 0,
    BadRoomCreation,
    GeneralError,
    MessageSend,
    MessageReceive,
    GetRequest,
    EVENT_COUNT
}

const eventNames = [
    "BadJoin",
    "BadRoomCreation",
    "GeneralError",
    "MessageSend",
    "MessageReceive",
    "GetRequest",
]
interface EventRecord {
    event: ClusterFunEventType
    time: number
    value?: number
    info?: string
}

//------------------------------------------------------------------------------------------
// The state of the server overall
//------------------------------------------------------------------------------------------
export class ServerModel {
    private rooms: Map<string, Room> = new Map<string, Room>();
    logger: Logger

    startTime = Date.now();

    events = [] as EventRecord[];
    maxEventCount = 1000000 // 1M events
    summarySegment = new Map<string,{count: number, sum: number}>();
    get activeRoomCount() {return this.rooms.size}

    private _trackedUsage = {user: 0, system:0}

    //------------------------------------------------------------------------------------------
    // ctor
    //------------------------------------------------------------------------------------------
    constructor(logger: Logger)
    {
        this.logger = logger;

        let lastUsage = process.cpuUsage()
        const secondsPerInterval = 2;
        const divisor = (secondsPerInterval * 1000000.0 * cores.length)
        setInterval(() => {
            let currentUsage = process.cpuUsage()
            const deltaUsage = {
                user: currentUsage.user - lastUsage.user, 
                system: currentUsage.system - lastUsage.system}
            const newUser = deltaUsage.user/divisor;
            const newSystem = deltaUsage.system/divisor;
            this._trackedUsage.user = this._trackedUsage.user * .3 + newUser * .7;
            this._trackedUsage.system = this._trackedUsage.system * .3 + newSystem * .7;
            lastUsage = currentUsage;
        },secondsPerInterval * 1000)

    }

    //--------------------------------------------------------------------------------------
    // logEvent
    //--------------------------------------------------------------------------------------
    logEvent(
        event: ClusterFunEventType, 
        value: number | undefined = undefined, 
        info: string | undefined = undefined) {

        const newRecord: EventRecord = {event, time: Date.now(), value, info}
        this.events.push(newRecord)
        this.addToSegment(this.summarySegment, newRecord);


        // If we go over max events, dump the oldest ones
        if(this.events.length > this.maxEventCount) {
            this.events = this.events.slice(Math.floor(this.events.length * .2))
        }


    }

    //------------------------------------------------------------------------------------------
    // 
    //------------------------------------------------------------------------------------------
    reportSentMessage(message: string) {
        this.logEvent(ClusterFunEventType.MessageSend, message.length)
    }

    //------------------------------------------------------------------------------------------
    // 
    //------------------------------------------------------------------------------------------
    reportRecievedMessage(message: string) {
        this.logEvent(ClusterFunEventType.MessageReceive, message.length)
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    reportError(errorType: string) {
        this.logEvent(ClusterFunEventType.GeneralError, undefined, errorType)
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    addToSegment = (segment: Map<string,{count: number, sum: number}>, ev: EventRecord) => {
        let segmentKey = eventNames[ev.event];
        if(ev.event === ClusterFunEventType.GeneralError
            || ev.event === ClusterFunEventType.GetRequest) segmentKey += `_${ev.info}`
        if(!segment?.has(segmentKey)) segment?.set(segmentKey, {count: 0, sum: 0})
        const datum = segment.get(segmentKey)!;
        datum.count++;
        if(ev.value) datum.sum+= ev.value;
    }

    //------------------------------------------------------------------------------------------
    // 
    //------------------------------------------------------------------------------------------
    getHealthData(earliestTime: number, span: number, latestTime: number | undefined = undefined)
    {
        if(!latestTime) latestTime = Date.now()
        if(span < 1000) span = 1000 // prevent DOS by asking for really short spans
        if(latestTime < earliestTime) latestTime = earliestTime; // ensure times are in order

        // prevent dos by picking a time that is too early
        const dosTimeBoundary = latestTime - span * 200;  // Max 200 data points
        if(earliestTime < dosTimeBoundary) earliestTime = dosTimeBoundary;

        let upTime = Date.now() - this.startTime;
        const msPerDay = 1000 * 3600 * 24;
        const days = Math.floor(upTime / msPerDay);
        upTime %= msPerDay;
        const msPerHour = 1000 * 3600;
        const hours = Math.floor(upTime/ msPerHour);
        upTime %= msPerHour;
        const minutes = Math.floor(upTime / 60000);
        upTime %= 60000;
        const seconds = Math.floor(upTime / 1000);
       
        const allRooms = Array.from(this.rooms.values());
        const currentRoomSummary = {
            roomCount: this.rooms.size,
            activeRooms: allRooms.reduce((total, room) => total + (room.isActive ? 1 : 0), 0),
            activeUsers: allRooms.reduce((total, room) => total += (room.isActive ? room.userCount : 0),0),
        }

        const reportSegments = new Map<number, Map<string,{count: number, sum: number}>>()
    
        const key = (dateValue: number, span: number )=> Math.floor(dateValue / span) * span;

        for(let i = this.events.length-1; i >= 0 ; i--)
        {
            const ev = this.events[i];
            if(ev.time < earliestTime) break;
            if(ev.time <= latestTime) {
                const shortKey = key(ev.time, span)
                if(!reportSegments.has(shortKey)) reportSegments.set(shortKey, new Map<string,{count: number, sum: number}>())
                const segment = reportSegments.get(shortKey)!;
                this.addToSegment(segment, ev); 
            }
        }

        const series = Array.from(reportSegments.keys())
                    .map(date => {
                        return {date, segments:  reportSegments.get(date)!}
                    })
                    .map(s => {
                        return {
                            date: s.date, 
                            columns: Array.from(s.segments.keys()).map(sk => ({label: sk, data: s.segments.get(sk)!})) 
                        }
                    })  
                    .sort((a,b) => a.date - b.date) 

        return {
            version: VERSION,
            uptime: `${days} ${hours.toString().padStart(2,"0")}:${minutes.toString().padStart(2,"0")}:${seconds.toString().padStart(2,"0")}`,
            rooms: currentRoomSummary,
            summary: Array.from(this.summarySegment.keys()).map(sk => ({label: sk, data: this.summarySegment.get(sk)!})),
            series,
            cpuUsage: this._trackedUsage,
            memoryUsage: process.memoryUsage()
        };
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    startGame(gameName: string, existingRoom: ExistingRoomInfo) {
        if(!gameName)
        {
            throw Error("Game name not specified");
        }

        let roomId = generateRoomCode();
        let personalId = generatePersonalId();
        let personalSecret = generatePersonalSecret();

        if(existingRoom && this.reuseRoom(gameName, existingRoom)) {
            this.logger.logLine(`Reusing room id: ${existingRoom.id} for ${gameName}`)
            roomId = existingRoom.id;
            personalId = existingRoom.presenterId;
            personalSecret = existingRoom.presenterSecret;
        }
        else {
            while(this.hasRoom(roomId))
            {
                roomId = generateRoomCode();
            }
            this.createRoom(roomId, gameName as string, personalId, personalSecret);
            this.logger.logLine(`Created a new room id: ${roomId} for ${gameName}`)
        }

        const presenterId = personalId;

        const properties: GameInstanceProperties = {
            gameName,
            roomId,
            personalId,
            presenterId,
            personalSecret,
            role: GameRole.Presenter
        };

        return properties
    }

    //--------------------------------------------------------------------------------------
    // 
    //--------------------------------------------------------------------------------------
    joinGame(roomId: string, playerName: string) {
        if (!roomId || roomId.length > 4)  {
            throw Error(`Invalid Room Code (${roomId})`)
        }
        if (!playerName || playerName.length > 16) {
            throw Error(`Invalid Player name: (${playerName})`)
        }

        const personalId = generatePersonalId();
        const personalSecret = generatePersonalSecret();

        const room = this.joinPersonToRoom(playerName, personalId, personalSecret, roomId)
        const presenterId = room.presenterId;
        const gameName = room.game;

        const properties: GameInstanceProperties = {
            gameName,
            roomId,
            personalId,
            presenterId,
            personalSecret,
            role: GameRole.Client
        };
        return properties;
    }

    //------------------------------------------------------------------------------------------
    // 
    //------------------------------------------------------------------------------------------
    reuseRoom(gameName: string, existingRoom: {id: string, presenterId: string, presenterSecret: string})
    {
        const room = this.rooms.get(existingRoom.id);
        if(!room || !room.validatePresenter(existingRoom.presenterId, existingRoom.presenterSecret)) {
            return false;
        }

        room.game = gameName;
        room.idle = false;
        return true;
    }

    //------------------------------------------------------------------------------------------
    // Create a room and add it to the list
    //------------------------------------------------------------------------------------------
    createRoom(id: string, game: string, presenterId: string, presenterSecret: string)
    {
        if (!this.rooms.has(id)) {
            this.rooms.set(id, new Room(id, this, game, presenterId, presenterSecret, this.logger));
        }
        else {
            this.logEvent(ClusterFunEventType.GeneralError, undefined, "Room Exists")
            throw new Error("Room already exists");
        }
    }

    //------------------------------------------------------------------------------------------
    // Indicate game is done for this room
    //------------------------------------------------------------------------------------------
    clearRoom(roomId: string, presenterSecret: string) {
        const room = this.rooms.get(roomId);
        if(!room) throw new Error("removeRoom: Could not find room with id " + roomId);
        const foundEndpoint = Array.from(room.endpoints.values()).find(e => e.secret === presenterSecret);
        if(!foundEndpoint) throw new Error(`removeRoom: Secret ${presenterSecret} not found in roomId ${roomId} `);
        if(room.presenterId != foundEndpoint.id) throw new Error("removeRoom: presenterSecret does not belong to the presenter!");
        room.clear();
    }

    //------------------------------------------------------------------------------------------
    // return true if roomid exists
    //------------------------------------------------------------------------------------------
    hasRoom(id: string)
    {
        return this.rooms.has(id);
    }

    //------------------------------------------------------------------------------------------
    // joinPersonToRoom
    //------------------------------------------------------------------------------------------
    joinPersonToRoom(name: string, playerId: string, playerSecret: string, roomId: string) 
    {
        this.logger.logLine(`Join: Room: ${roomId}, Player: ${playerId}, Name: ${name}`)
        
        if(!this.rooms.has(roomId))
        {
            this.logEvent(ClusterFunEventType.GeneralError, undefined, "Join invalid room id")
            throw new Error("Join invalid room id");
        }

        const room = this.rooms.get(roomId);
        if(!room) {
            this.logEvent(ClusterFunEventType.GeneralError, undefined, "Join missing game")
            throw new Error("Join missing game");
        }

        room.addEndpoint(playerId, playerSecret, name);        

        return room;
    }

    //------------------------------------------------------------------------------------------
    // getRoom
    //------------------------------------------------------------------------------------------
    getRoom(roomId: string) 
    {
        return this.rooms.get(roomId);
    }

    //------------------------------------------------------------------------------------------
    // purgeInactiveRooms
    //------------------------------------------------------------------------------------------
    purgeInactiveRooms() 
    {
        this.logger.logLine("Purging rooms...")
        const purgeMe = Array.from (this.rooms.values()).filter(r => !r.isActive);
        for(const room of purgeMe)
        {
            this.logger.logLine("Purging inactive room " + room.id);
            this.rooms.delete(room.id);
        }
    }
}