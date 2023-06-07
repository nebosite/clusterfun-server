
import { GameRole } from "./GameRole.js";

export interface GameInstanceProperties {
    gameName: string;
    role: GameRole;
    roomId: string;
    presenterId: string;
    personalId: string;
    personalSecret: string;
}