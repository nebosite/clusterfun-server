import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Room } from "./Room.js";

// Room is the heart of the relay: it validates who may attach a socket, and it
// forwards raw messages from a sender to exactly one receiver based on the
// message header - without ever understanding the payload.

const silentLogger = {
  logLine() {
    /* noop */
  },
  logError() {
    /* noop */
  },
} as any;

// Room only ever calls serverModel.reportSentMessage on the path we exercise.
function fakeServerModel() {
  const sent: string[] = [];
  return { model: { reportSentMessage: (m: string) => sent.push(m) } as any, sent };
}

function fakeSocket() {
  const sent: string[] = [];
  let closedCount = 0;
  const socket = {
    send: (m: string) => {
      sent.push(m);
    },
    close: () => {
      closedCount++;
    },
  } as any;
  return { socket, sent, closed: () => closedCount };
}

// Build a message string in the relay wire format: {header}^{payload}
function message(sender: string, receiver: string, payload = "PAYLOAD") {
  const header = JSON.stringify({ t: "test", r: receiver, s: sender, id: "1" });
  return `${header}^${payload}`;
}

const P_SECRET = "presenter0"; // 10 chars; secrets must match by length for timingSafeEqual
const A_SECRET = "aaaaaaaaaa";
const B_SECRET = "bbbbbbbbbb";

function makeRoom() {
  const sm = fakeServerModel();
  const room = new Room("ROOM", sm.model, "Testato", "P0", P_SECRET, silentLogger);
  return { room, sm };
}

describe("Room", () => {
  describe("construction", () => {
    it("registers the presenter as an endpoint named 'presenter'", () => {
      const { room } = makeRoom();
      assert.equal(room.presenterId, "P0");
      assert.equal(room.endpoints.get("P0")?.name, "presenter");
    });

    it("is active when freshly created", () => {
      const { room } = makeRoom();
      assert.equal(room.isActive, true);
    });
  });

  describe("setSocket (secret validation)", () => {
    it("attaches the socket when the secret is correct", () => {
      const { room } = makeRoom();
      room.addEndpoint("P1", A_SECRET, "Alice");
      const { socket } = fakeSocket();
      room.setSocket("P1", A_SECRET, socket);
      assert.equal(room.endpoints.get("P1")?.socket, socket);
    });

    it("throws for a wrong (but same-length) secret", () => {
      const { room } = makeRoom();
      room.addEndpoint("P1", A_SECRET, "Alice");
      const { socket } = fakeSocket();
      assert.throws(() => room.setSocket("P1", B_SECRET, socket));
      assert.equal(room.endpoints.get("P1")?.socket, undefined);
    });

    it("throws for an unknown endpoint id", () => {
      const { room } = makeRoom();
      const { socket } = fakeSocket();
      assert.throws(() => room.setSocket("NOPE", A_SECRET, socket));
    });
  });

  describe("receiveMessage (routing)", () => {
    it("forwards the raw message only to the receiver's socket", () => {
      const { room, sm } = makeRoom();
      room.addEndpoint("P1", A_SECRET, "Alice");
      room.addEndpoint("P2", B_SECRET, "Bob");
      const a = fakeSocket();
      const b = fakeSocket();
      room.setSocket("P1", A_SECRET, a.socket);
      room.setSocket("P2", B_SECRET, b.socket);

      const msg = message("P1", "P2");
      room.receiveMessage("P1", msg);

      assert.deepEqual(b.sent, [msg]);
      assert.equal(a.sent.length, 0);
      assert.deepEqual(sm.sent, [msg]);
    });

    it("throws when the socket owner does not match the header's sender", () => {
      const { room } = makeRoom();
      room.addEndpoint("P1", A_SECRET, "Alice");
      room.addEndpoint("P2", B_SECRET, "Bob");
      // Header claims the sender is P2, but the socket belongs to P1
      assert.throws(() => room.receiveMessage("P1", message("P2", "P1")));
    });

    it("throws on a message with no valid header", () => {
      const { room } = makeRoom();
      assert.throws(() => room.receiveMessage("P1", "not-a-valid-message"));
    });

    it("does not throw when the receiver has no socket", () => {
      const { room } = makeRoom();
      room.addEndpoint("P1", A_SECRET, "Alice");
      room.addEndpoint("P2", B_SECRET, "Bob"); // no socket attached
      const a = fakeSocket();
      room.setSocket("P1", A_SECRET, a.socket);
      assert.doesNotThrow(() => room.receiveMessage("P1", message("P1", "P2")));
    });

    it("does not throw when the receiver is unknown", () => {
      const { room } = makeRoom();
      room.addEndpoint("P1", A_SECRET, "Alice");
      const a = fakeSocket();
      room.setSocket("P1", A_SECRET, a.socket);
      assert.doesNotThrow(() => room.receiveMessage("P1", message("P1", "GHOST")));
    });
  });

  describe("userCount", () => {
    it("counts connected non-presenter endpoints", () => {
      const { room } = makeRoom();
      room.addEndpoint("P1", A_SECRET, "Alice");
      room.addEndpoint("P2", B_SECRET, "Bob");
      assert.equal(room.userCount, 0); // no sockets yet
      room.setSocket("P1", A_SECRET, fakeSocket().socket);
      room.setSocket("P2", B_SECRET, fakeSocket().socket);
      assert.equal(room.userCount, 2);
    });
  });

  describe("validatePresenter", () => {
    it("accepts the correct presenter id + secret and rejects everything else", () => {
      const { room } = makeRoom();
      // validatePresenter returns a truthy value only for a valid presenter;
      // a wrong secret is false and an unknown id short-circuits to undefined.
      assert.equal(room.validatePresenter("P0", P_SECRET), true);
      assert.ok(!room.validatePresenter("P0", "wrongsecre"));
      assert.ok(!room.validatePresenter("P9", P_SECRET));
    });
  });

  describe("clear", () => {
    it("drops and closes every endpoint except the presenter and goes idle", () => {
      const { room } = makeRoom();
      room.addEndpoint("P1", A_SECRET, "Alice");
      room.addEndpoint("P2", B_SECRET, "Bob");
      const a = fakeSocket();
      const b = fakeSocket();
      room.setSocket("P1", A_SECRET, a.socket);
      room.setSocket("P2", B_SECRET, b.socket);

      room.clear();

      assert.deepEqual(Array.from(room.endpoints.keys()), ["P0"]);
      assert.equal(a.closed(), 1);
      assert.equal(b.closed(), 1);
      assert.equal(room.idle, true);
    });
  });

  describe("isActive", () => {
    it("becomes inactive once the last message is older than an hour", () => {
      const { room } = makeRoom();
      (room as any).lastMessageTime = Date.now() - (3600 * 1000 + 5000);
      assert.equal(room.isActive, false);
    });
  });
});
