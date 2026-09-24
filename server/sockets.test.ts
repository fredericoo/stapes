import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { constants, createDeflateRaw, type DeflateRaw } from "node:zlib";
import { PER_MESSAGE_DEFLATE } from "./sockets";

/**
 * The game socket's compression, against a client that compresses the way
 * Safari does.
 *
 * **The client is written out by hand, and has to be.** Every WebSocket client
 * to hand does as the handshake tells it, and what is being guarded is a
 * browser that does not: Safari compresses each message against the ones it
 * sent before, even when the server has asked it not to. So the test speaks
 * the protocol itself — an upgrade, then masked frames compressed by one
 * deflate stream kept for the whole connection. @see PER_MESSAGE_DEFLATE
 */

/** Open a raw connection and upgrade it, answering with the extensions agreed. */
function upgrade(port: number): Promise<{ socket: Socket; extensions: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let head = "";
    socket.on("error", reject);
    socket.on("data", function onData(chunk: Buffer) {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const extensions = /^sec-websocket-extensions: (.*)$/im.exec(head.slice(0, end))?.[1] ?? "";
      resolve({ socket, extensions: extensions.trim() });
    });
    socket.write(
      [
        "GET / HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        // What Safari offers, word for word.
        "Sec-WebSocket-Extensions: permessage-deflate",
        "",
        "",
      ].join("\r\n"),
    );
  });
}

/**
 * The next message out of a deflate stream that is never reset, as RFC 7692
 * frames it: sync-flushed, with the flush's `00 00 ff ff` taken off the end.
 */
function deflateMessage(stream: DeflateRaw, text: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => chunks.push(chunk);
    stream.on("data", onData);
    stream.write(text);
    stream.flush(constants.Z_SYNC_FLUSH, () => {
      stream.off("data", onData);
      resolve(Buffer.concat(chunks).subarray(0, -4));
    });
  });
}

/** A compressed text frame from a client: FIN, RSV1 and masked, as clients must. */
function compressedFrame(payload: Buffer): Buffer {
  if (payload.length >= 126) throw new Error("the messages here are short on purpose");
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= mask[i % 4]!;
  return Buffer.concat([Buffer.from([0xc1, 0x80 | masked.length]), mask, masked]);
}

describe("the game socket's compression", () => {
  it("reads a client that keeps its compression context across messages", async () => {
    const received: string[] = [];
    let closed: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(request, srv) {
        return srv.upgrade(request) ? undefined : new Response(null, { status: 400 });
      },
      websocket: {
        perMessageDeflate: PER_MESSAGE_DEFLATE,
        message(_ws, message) {
          received.push(String(message));
        },
        close(_ws, code, reason) {
          closed = `${code} ${reason}`;
        },
      },
    });

    try {
      const { socket, extensions } = await upgrade(server.port!);
      // Asked for, Safari ignores it — and the server that asked resets its
      // decompressor between messages on the strength of it.
      expect(extensions).toStartWith("permessage-deflate");
      expect(extensions).not.toContain("client_no_context_takeover");

      // Steps, which repeat each other: every one after the first is mostly
      // back-references into the ones before.
      const steps = ["n", "n", "e", "n", "w", "w"].map((direction, seq) =>
        JSON.stringify({ type: "step", direction, seq }),
      );
      const stream = createDeflateRaw();
      for (const step of steps) socket.write(compressedFrame(await deflateMessage(stream, step)));

      const deadline = Date.now() + 5_000;
      while (received.length < steps.length && closed === null && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(closed).toBeNull();
      expect(received).toEqual(steps);
      socket.destroy();
    } finally {
      await server.stop(true);
    }
  });
});
