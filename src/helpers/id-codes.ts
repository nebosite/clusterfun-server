import * as crypto from 'crypto';

export function generateRoomCode(): string {
    // Generate a random, 4-character room code,
    // ensuring it's all caps and avoiding vowels
    // Forbidden characters: 0, 1, 
    const randBuffer = new Uint32Array(1);
    crypto.randomFillSync(randBuffer);
    const scaled = Math.floor(randBuffer[0] / (2 ** 32) * (31 ** 4));
    return scaled.toString(31)
        .padStart(4, "0")
        .replace("a", "v")
        .replace("e", "w")
        .replace("i", "x")
        .replace("o", "y")
        .replace("u", "z")
        .replace("0", "k")
        .replace("1", "m")
        .replace("l", "q")
        .replace("u", "z")
        .toUpperCase();
}

function generateUniqueId(length: number) : string {
    // Generate a random ID
    const randBuffer = new Uint32Array(Math.ceil(length / 6));
    crypto.randomFillSync(randBuffer);
    return Array.from(randBuffer, (raw) => {
        return Math.floor(raw / (2 ** 32) * (36 ** 6)).toString(36).padStart(6, "0");
    }).reduce((left, right) => left + right, "")
    .substr(0, length);
}

export function generatePersonalId(): string {
    return generateUniqueId(12);
}

export function generatePersonalSecret(): string {
    return generateUniqueId(36);
}