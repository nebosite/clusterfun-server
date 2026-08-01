import { test, describe } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import { trafficMeter, requestBytes } from "./trafficMeter.js";
import { Request, Response } from "express";

// The point of this middleware is that the health page stops claiming the server sends
// exactly what it receives.  It only does that if a response body is actually measured -
// including the big one-way ones, a music track and the client bundle.

function fakeRequest(over: Partial<Request> = {}): Request {
  return {
    method: "GET",
    url: "/music/track.m4a",
    originalUrl: "/music/track.m4a",
    headers: { host: "clusterfun.tv" },
    ...over,
  } as unknown as Request;
}

function fakeResponse() {
  const res = new EventEmitter() as unknown as Response & { finish(): void };
  const written: any[] = [];
  (res as any).statusCode = 200;
  (res as any).getHeaders = () => ({ "content-type": "audio/mp4" });
  (res as any).write = (chunk: any) => {
    written.push(chunk);
    return true;
  };
  (res as any).end = (chunk?: any) => {
    if (chunk) written.push(chunk);
    return res;
  };
  (res as any).finish = () => (res as unknown as EventEmitter).emit("finish");
  return { res: res as unknown as Response, written };
}

function run(req: Request, body: (res: Response) => void) {
  const seen: { received: number; sent: number }[] = [];
  const { res } = fakeResponse();
  trafficMeter((received, sent) => seen.push({ received, sent }))(req, res, () => {});
  body(res);
  (res as any).finish();
  return seen;
}

describe("trafficMeter", () => {
  test("measures a big one-way response, which is the whole point", () => {
    // A music track: a few bytes of request, megabytes of response.  This asymmetry is
    // invisible if only the WebSocket relay is counted, which is what it used to do.
    const megabyte = Buffer.alloc(1_000_000);
    const seen = run(fakeRequest(), (res) => res.end(megabyte));

    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0].sent >= 1_000_000, "the body was counted");
    assert.ok(seen[0].received < 1000, "the request was small");
    assert.ok(seen[0].sent > seen[0].received * 100, "sent dwarfs received");
  });

  test("adds up a streamed body written in pieces", () => {
    const seen = run(fakeRequest(), (res) => {
      res.write("12345");
      res.write(Buffer.alloc(10));
      res.end("678");
    });
    // 5 + 10 + 3 of body, plus headers
    assert.ok(seen[0].sent >= 18);
  });

  test("counts a response with no body at all", () => {
    // A 304 is all headers, and they are real bytes on the wire.
    const seen = run(fakeRequest(), (res) => res.end());
    assert.ok(seen[0].sent > 0);
  });

  test("reports exactly once per exchange", () => {
    const seen = run(fakeRequest(), (res) => res.end("hi"));
    assert.strictEqual(seen.length, 1);
  });

  test("counts what a request costs, body included", () => {
    const withBody = requestBytes(
      fakeRequest({
        method: "POST",
        headers: { host: "clusterfun.tv", "content-length": "500" },
      } as Partial<Request>),
    );
    const withoutBody = requestBytes(fakeRequest());
    assert.ok(withBody > withoutBody + 400, "the declared body is included");
  });

  test("survives a nonsense content-length rather than reporting NaN", () => {
    const bytes = requestBytes(
      fakeRequest({ headers: { "content-length": "banana" } } as Partial<Request>),
    );
    assert.ok(isFinite(bytes) && bytes > 0);
  });
});
