import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ABANDONED_ROOM_MS, ServerModel } from "./ServerModel.js";
import { UserError } from "../helpers/errors.js";

// ServerModel owns the room registry and all room-lifecycle rules: creating,
// reusing, joining, terminating, and purging rooms.

const silentLogger = {
  logLine() {
    /* noop */
  },
  logError() {
    /* noop */
  },
} as any;

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

    it("keeps a room somebody just opened", () => {
      const model = makeModel();
      const host = model.startGame("Testato", undefined as any);

      model.purgeInactiveRooms();

      assert.equal(model.hasRoom(host.roomId), true);
    });

    it("drops a room nobody has been connected to for a few minutes", () => {
      // Waiting a full hour meant every game anybody opened all evening still counted as
      // a room, which is how a single local test came to report seven of them.
      const model = makeModel();
      const host = model.startGame("Testato", undefined as any);
      const room = model.getRoom(host.roomId)!;
      (room as any).lastConnectedTime = Date.now() - (ABANDONED_ROOM_MS + 1000);

      model.purgeInactiveRooms();

      assert.equal(model.hasRoom(host.roomId), false);
    });

    it("does not drop a room during the grace period, so a refresh cannot lose a game", () => {
      const model = makeModel();
      const host = model.startGame("Testato", undefined as any);
      const room = model.getRoom(host.roomId)!;
      (room as any).lastConnectedTime = Date.now() - 30_000; // half a minute with no socket

      model.purgeInactiveRooms();

      assert.equal(model.hasRoom(host.roomId), true);
    });
  });
});

describe("ServerModel - counting what gets played", () => {
  it("counts a play when a room is opened, and a player for each join", () => {
    const model = makeModel();
    const game = model.startGame("Eittris", undefined as any);
    model.joinGame(game.roomId, "Ann");
    model.joinGame(game.roomId, "Bob");

    const report = model.popularity.report();
    assert.equal(report["Eittris"].plays, 1);
    assert.equal(report["Eittris"].players, 2);
    assert.ok(report["Eittris"].lastPlayed > 0);
  });

  it("keeps games apart", () => {
    const model = makeModel();
    model.startGame("Eittris", undefined as any);
    model.startGame("Lexible", undefined as any);
    model.startGame("Lexible", undefined as any);

    const report = model.popularity.report();
    assert.equal(report["Eittris"].plays, 1);
    assert.equal(report["Lexible"].plays, 2);
  });

  it("does not write anything to disk unless it was given somewhere to write", () => {
    // Guards the default: merely constructing a ServerModel (which every test
    // does) must never touch the developer's home directory.
    const model = makeModel();
    assert.equal(model.popularity.isPersistent, false);
  });
});

describe("ServerModel - joining a room that is not open", () => {
  it("reports it as a user error, not a server crash", () => {
    // This is the most common join failure in the wild: a typo, or a room that
    // was purged after an hour idle.  As a plain Error it came back as a 500
    // "reference timecode" and the real reason only existed in the server log.
    const model = makeModel();
    assert.throws(
      () => model.joinGame("ZZZZ", "Ann"),
      (err: any) => err instanceof UserError && /ZZZZ/.test(err.message),
    );
  });

  it("says so in a way that mentions the code and the idle timeout", () => {
    const model = makeModel();
    try {
      model.joinGame("ABCD", "Ann");
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.match(err.message, /ABCD/);
      assert.match(err.message, /hour/i);
    }
  });

  it("still rejects a malformed code before looking for a room", () => {
    const model = makeModel();
    assert.throws(() => model.joinGame("TOOLONG", "Ann"), /Invalid Room Code/);
  });

  it("lets a real code through", () => {
    const model = makeModel();
    const game = model.startGame("Eittris", undefined as any);
    const joined = model.joinGame(game.roomId, "Ann");
    assert.equal(joined.gameName, "Eittris");
    assert.equal(joined.role, "client");
  });
});
