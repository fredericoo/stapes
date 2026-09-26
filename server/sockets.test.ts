import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { constants, createInflateRaw, inflateRawSync, type InflateRaw } from "node:zlib";
import { PER_MESSAGE_DEFLATE } from "./sockets";

type Frame = { compressed: boolean; payload: Buffer };

function framesFrom(port: number, count: number): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const frames: Frame[] = [];
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      while (buffer.length >= 2) {
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        frames.push({
          compressed: (buffer[0]! & 0x40) !== 0,
          payload: buffer.subarray(offset, offset + length),
        });
        buffer = buffer.subarray(offset + length);
      }
      if (frames.length >= count) {
        socket.destroy();
        resolve(frames);
      }
    });
    socket.write(
      [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Extensions: permessage-deflate",
        "",
        "",
      ].join("\r\n"),
    );
  });
}

/**
 * The next message out of one decompressor kept for the whole connection, as
 * a browser keeps it: fed the payload and the `00 00 ff ff` RFC 7692 takes off
 * the end, and flushed.
 */
function inflateNext(inflater: InflateRaw, payload: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => chunks.push(chunk);
    inflater.on("data", onData);
    inflater.once("error", reject);
    inflater.write(Buffer.concat([payload, Buffer.from([0, 0, 0xff, 0xff])]));
    inflater.flush(constants.Z_SYNC_FLUSH, () => {
      inflater.off("data", onData);
      inflater.off("error", reject);
      resolve(Buffer.concat(chunks).toString());
    });
  });
}

function sealed(payload: Buffer): boolean {
  try {
    inflateRawSync(payload, { finishFlush: constants.Z_FINISH });
    return true;
  } catch {
    return false;
  }
}

describe("the game socket's frames", () => {
  it("never sends a compressed frame sealed with a final block", async () => {
    const cell = JSON.stringify({ x: 21, y: -101, z: 0, stack: [{ tileId: "grass-2" }] });
    const messages = [
      JSON.stringify({ type: "patch", cells: Array(8).fill(JSON.parse(cell)) }),
      JSON.stringify({ type: "patch", cells: Array(60).fill(JSON.parse(cell)) }),
      JSON.stringify({ type: "patch", cells: Array(600).fill(JSON.parse(cell)) }),
      JSON.stringify({ type: "hello", pad: randomBytes(300_000).toString("base64") }),
    ];
    const server = Bun.serve({
      port: 0,
      fetch(request, srv) {
        return srv.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        perMessageDeflate: PER_MESSAGE_DEFLATE,
        open(ws) {
          for (const message of messages) ws.send(message, true);
        },
        message() {},
      },
    });

    try {
      const frames = await framesFrom(server.port!, messages.length);
      expect(frames.filter((frame) => frame.compressed && sealed(frame.payload))).toEqual([]);
      const inflater = createInflateRaw();
      const texts: string[] = [];
      for (const { compressed, payload } of frames) {
        texts.push(compressed ? await inflateNext(inflater, payload) : payload.toString());
      }
      inflater.close();
      expect(texts).toEqual(messages);
    } finally {
      await server.stop(true);
    }
  });
});
