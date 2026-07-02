import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ServerModel } from "./ServerModel.js";

// ServerModel owns the room registry and all room-lifecycle rules: creating,
// reusing, joining, terminating, and purging rooms.

const silentLogger = { logLine() { /* noop */ }, logError() { /* noop */ } } as any;

function makeModel() {
    return new ServerModel(silentLogger);
}

describe("ServerModel", () => {

    describe("startGame", () => {
        it("creates a room and returns presenter properties", () => {
            const model = makeModel();
            const props = model.startGame("Testato", undefined as any);

            assert.equal(props.gameName, "Testato");
            assert.equal(props.role, "presenter");
            assert.match(props.roomId, /^[0-9A-Z]{4}$/);
            assert.equal(props.presenterId, props.personalId);
            assert.ok(typeof props.personalSecret === "string" && props.personalSecret.length > 0);
            assert.equal(model.hasRoom(props.roomId), true);
            assert.equal(model.getRoom(props.roomId)!.game, "Testato");
        });

        it("throws when no game name is given", () => {
            const model = makeModel();
            assert.throws(() => model.startGame("", undefined as any));
        });

        it("reuses the same room when a valid existingRoom is supplied", () => {
            const model = makeModel();
            const first = model.startGame("Testato", undefined as any);

            const second = model.startGame("Lexible", {
                id: first.roomId,
                presenterId: first.presenterId,
                presenterSecret: first.personalSecret,
            } as any);

            assert.equal(second.roomId, first.roomId);
            assert.equal(model.getRoom(first.roomId)!.game, "Lexible");
            assert.equal(model.getRoom(first.roomId)!.idle, false);
        });

        it("creates a fresh room when the existingRoom secret is wrong", () => {
            const model = makeModel();
            const first = model.startGame("Testato", undefined as any);

            const second = model.startGame("Lexible", {
                id: first.roomId,
                presenterId: first.presenterId,
                presenterSecret: "not-the-real-secret",
            } as any);

            assert.notEqual(second.roomId, first.roomId);
            assert.equal(model.hasRoom(second.roomId), true);
        });
    });

    describe("joinGame", () => {
        it("adds a client endpoint and returns client properties", () => {
            const model = makeModel();
            const host = model.startGame("Testato", undefined as any);

            const join = model.joinGame(host.roomId, "Alice");

            assert.equal(join.role, "client");
            assert.equal(join.gameName, "Testato");
            assert.equal(join.presenterId, host.presenterId);
            assert.notEqual(join.personalId, host.personalId);
            assert.equal(model.getRoom(host.roomId)!.endpoints.has(join.personalId), true);
        });

        it("rejects an over-long room code", () => {
            const model = makeModel();
            assert.throws(() => model.joinGame("TOOLONG", "Alice"));
        });

        it("rejects an over-long player name before touching the room", () => {
            const model = makeModel();
            assert.throws(() => model.joinGame("ABCD", "x".repeat(17)));
        });

        it("rejects joining a room that does not exist", () => {
            const model = makeModel();
            assert.throws(() => model.joinGame("ZZZZ", "Alice"));
        });
    });

    describe("clearRoom", () => {
        it("marks the room idle when the presenter secret is correct", () => {
            const model = makeModel();
            const host = model.startGame("Testato", undefined as any);
            model.joinGame(host.roomId, "Alice");

            model.clearRoom(host.roomId, host.personalSecret);

            assert.equal(model.getRoom(host.roomId)!.idle, true);
        });

        it("throws for a wrong presenter secret", () => {
            const model = makeModel();
            const host = model.startGame("Testato", undefined as any);
            assert.throws(() => model.clearRoom(host.roomId, "wrong-secret"));
        });

        it("throws for a non-existent room", () => {
            const model = makeModel();
            assert.throws(() => model.clearRoom("ZZZZ", "whatever"));
        });

        it("throws when the secret belongs to a non-presenter player", () => {
            const model = makeModel();
            const host = model.startGame("Testato", undefined as any);
            const join = model.joinGame(host.roomId, "Alice");
            // A regular player's secret must not be able to tear down the room
            assert.throws(() => model.clearRoom(host.roomId, join.personalSecret));
        });
    });

    describe("purgeInactiveRooms", () => {
        it("removes rooms whose last message is over an hour old", () => {
            const model = makeModel();
            const host = model.startGame("Testato", undefined as any);
            const room = model.getRoom(host.roomId)!;
            (room as any).lastMessageTime = Date.now() - (3600 * 1000 + 5000);

            model.purgeInactiveRooms();

            assert.equal(model.hasRoom(host.roomId), false);
        });

        it("keeps rooms that are still active", () => {
            const model = makeModel();
            const host = model.startGame("Testato", undefined as any);

            model.purgeInactiveRooms();

            assert.equal(model.hasRoom(host.roomId), true);
        });
    });
});
