import { Request, Response, NextFunction } from "express";

// ==========================================================================================
// trafficMeter - counts the bytes of every HTTP exchange.
//
// Without this the health page only ever saw the WebSocket relay, where the server forwards
// each message exactly once - so bytes in and bytes out were identical by construction and
// the pair told you nothing.  They are also wildly understated: this process serves the
// React bundle and every music track, which dwarf the relay and go one way only.
//
// The response is measured by watching what is actually written, rather than trusting a
// Content-Length header, because static files and streamed responses do not always set one.
// ==========================================================================================

/** Roughly what a request costs on the wire: its line plus its headers plus its body. */
export function requestBytes(req: Request): number {
  let total = Buffer.byteLength(`${req.method} ${req.originalUrl ?? req.url} HTTP/1.1\r\n`);
  for (const [name, value] of Object.entries(req.headers)) {
    const text = Array.isArray(value) ? value.join(", ") : (value ?? "");
    total += Buffer.byteLength(`${name}: ${text}\r\n`);
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  return total + 2 + (isFinite(declared) ? declared : 0);
}

/**
 * Express middleware that reports each exchange once the response is done.  Mount it first,
 * before anything that can answer a request, or it will miss whatever answers earlier.
 */
export function trafficMeter(report: (received: number, sent: number) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    let sent = 0;
    const write = res.write.bind(res);
    const end = res.end.bind(res);

    const measure = (chunk: any, encoding?: any) => {
      if (!chunk) return;
      if (typeof chunk === "string") {
        const enc: BufferEncoding =
          typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8";
        sent += Buffer.byteLength(chunk, enc);
      } else {
        sent += chunk.length ?? 0;
      }
    };

    res.write = ((chunk: any, encoding?: any, cb?: any) => {
      measure(chunk, encoding);
      return write(chunk, encoding, cb);
    }) as typeof res.write;

    res.end = ((chunk?: any, encoding?: any, cb?: any) => {
      // end() can be called with just a callback, in which case there is no body
      if (typeof chunk !== "function") measure(chunk, encoding);
      return end(chunk, encoding, cb);
    }) as typeof res.end;

    res.on("finish", () => {
      // Headers count too - on a 304 they are the entire response.
      let headerBytes = Buffer.byteLength(`HTTP/1.1 ${res.statusCode}\r\n`);
      for (const [name, value] of Object.entries(res.getHeaders())) {
        headerBytes += Buffer.byteLength(`${name}: ${String(value ?? "")}\r\n`);
      }
      report(requestBytes(req), sent + headerBytes + 2);
    });

    next();
  };
}
