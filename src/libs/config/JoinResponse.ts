import { GameRole } from "./GameRole.js";

export interface JoinResponse {
    gameName: string;
    role: GameRole;
    roomId: string;
    presenterId: string;
    personalId: string;
    personalSecret: string;
    isVip: boolean;
}