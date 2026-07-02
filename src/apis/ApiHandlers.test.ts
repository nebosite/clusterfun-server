import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiHandler, UserError } from "./ApiHandlers.js";

// ApiHandler wraps every HTTP call in safeCall (which maps errors to status
// codes) and guards the relay socket handshake. Both are worth pinning down:
// safeCall is the error contract with the client, and handleSocket is the only
// gate protecting a room from unauthorized sockets.

const silentLogger = { logLine() { /* noop */ }, logError() { /* noop */ } } as any;
const CLOSECODE_POLICY_VIOLATION = 1008;

function fakeRes() {
    const res: any = { statusCode: 200, headers: {}, body: undefined as string | undefined };
    res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.end = (body?: string) => { res.body = body; return res; };
    return res;
}

function fakeWs() {
    const closes: number[] = [];
    const ws: any = { close: (code: number) => closes.push(code), on: () => { /* noop */ } };
    return { ws, closes };
}

describe("ApiHandler", () => {

    describe("safeCall", () => {
        it("serializes the result as JSON with a 200 by default", async () => {
            const api = new ApiHandler({} as any, silentLogger);
            const res = fakeRes();
            await api.safeCall({} as any, res, "ok", async () => ({ hello: "world" }));

            assert.equal(res.statusCode, 200);
            assert.equal(res.headers["Content-Type"], "application/json");
            assert.deepEqual(JSON.parse(res.body!), { hello: "world" });
        });

        it("maps a UserError to a 400 with the user's message", async () => {
            const api = new ApiHandler({} as any, silentLogger);
            const res = fakeRes();
            await api.safeCall({} as any, res, "bad", async () => { throw new UserError("nope"); });

            assert.equal(res.statusCode, 400);
            assert.equal(JSON.parse(res.body!).errorMessage, "nope");
        });

        it("maps an unexpected error to a 500 that hides internals", async () => {
            const api = new ApiHandler({} as any, silentLogger);
            const res = fakeRes();
            await api.safeCall({} as any, res, "boom", async () => { throw new Error("secret stack detail"); });

            assert.equal(res.statusCode, 500);
            assert.ok(JSON.parse(res.body!).errorMessage.includes("server error"));
            assert.ok(!res.body!.includes("secret stack detail"));
        });
    });

    describe("handleSocket (handshake guard)", () => {
        it("closes the socket when no protocol header is present", () => {
            const api = new ApiHandler({ reportError() { /* noop */ } } as any, silentLogger);
            const { ws, closes } = fakeWs();
            api.handleSocket(ws, { headers: {}, params: { roomId: "ROOM", personalId: "P1" } } as any);
            assert.deepEqual(closes, [CLOSECODE_POLICY_VIOLATION]);
        });

        it("closes the socket when the first protocol is not a Secret", () => {
            const api = new ApiHandler({ reportError() { /* noop */ } } as any, silentLogger);
            const { ws, closes } = fakeWs();
            api.handleSocket(ws, {
                headers: { "sec-websocket-protocol": "NotASecretValue" },
                params: { roomId: "ROOM", personalId: "P1" },
            } as any);
            assert.deepEqual(closes, [CLOSECODE_POLICY_VIOLATION]);
        });

        it("closes the socket when the room does not exist", () => {
            const serverModel = { getRoom: () => undefined, reportError() { /* noop */ } } as any;
            const api = new ApiHandler(serverModel, silentLogger);
            const { ws, closes } = fakeWs();
            api.handleSocket(ws, {
                headers: { "sec-websocket-protocol": "Secretabc123" },
                params: { roomId: "GONE", personalId: "P1" },
            } as any);
            assert.deepEqual(closes, [CLOSECODE_POLICY_VIOLATION]);
        });
    });
});
