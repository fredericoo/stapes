import { describe, expect, it, vi } from "vitest";
import { SOCKET_OPEN } from "../net/socket";
import { LocalSocket } from "./LocalSocket";
import type { ToWorld } from "./workerProtocol";

/**
 * The page's end of a connection to the world in the worker.
 *
 * What is being asserted is that it behaves like the `WebSocket` it stands in
 * for, because `RemoteSession` and `WorldPage` were written against one and
 * neither was changed: a connection that ends once, a `readyState` that says so,
 * and frames that stop when it has. Each of these is a real bug on the other
 * side of it — a second close event starts a second reconnect, and a frame
 * delivered after the close reaches a session the page has already disposed.
 */

function socketWithSent() {
  const sent: ToWorld[] = [];
  const socket = new LocalSocket((message) => sent.push(message), 7);
  return { socket, sent };
}

describe("LocalSocket", () => {
  it("carries a frame to the world under its own connection id", () => {
    const { socket, sent } = socketWithSent();

    socket.send('{"type":"step"}');

    expect(sent).toEqual([{ kind: "frame", id: 7, data: '{"type":"step"}' }]);
  });

  it("hands a frame from the world to whoever is listening", () => {
    const { socket } = socketWithSent();
    const heard: unknown[] = [];
    socket.addEventListener("message", (event) => heard.push(event.data));

    socket.deliver('{"type":"hello"}');

    expect(heard).toEqual(['{"type":"hello"}']);
  });

  it("stops listening when asked", () => {
    const { socket } = socketWithSent();
    const listener = vi.fn();
    socket.addEventListener("message", listener);
    socket.removeEventListener("message", listener);

    socket.deliver('{"type":"hello"}');

    expect(listener).not.toHaveBeenCalled();
  });

  it("is open until the world closes it", () => {
    const { socket } = socketWithSent();
    expect(socket.readyState).toBe(SOCKET_OPEN);

    socket.ended(4002, "replaced");

    expect(socket.readyState).not.toBe(SOCKET_OPEN);
  });

  it("reports the close once, however it ended", async () => {
    const { socket } = socketWithSent();
    const closes: number[] = [];
    socket.addEventListener("close", (event) => closes.push(event.code));

    socket.close();
    // The page's own close reaches the world, which answers with a close of its
    // own. Two endings, one connection.
    socket.ended(1000, "left");
    await Promise.resolve();

    expect(closes).toEqual([1000]);
  });

  it("tells the page about its own close, as a socket does", async () => {
    const { socket, sent } = socketWithSent();
    const closes: { code: number }[] = [];
    socket.addEventListener("close", (event) => closes.push(event));

    socket.close();
    // Not inline: `close()` returns first, exactly as `WebSocket.close` does,
    // so a page tearing itself down in its close handler is not doing it inside
    // its own call.
    expect(closes).toEqual([]);
    await Promise.resolve();

    expect(closes).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ kind: "close", id: 7 });
  });

  it("delivers nothing after the connection has ended", () => {
    const { socket } = socketWithSent();
    const heard: unknown[] = [];
    socket.addEventListener("message", (event) => heard.push(event.data));

    socket.ended(1006, "gone");
    socket.deliver('{"type":"patch"}');

    expect(heard).toEqual([]);
  });

  it("sends nothing after the connection has ended", () => {
    const { socket, sent } = socketWithSent();

    socket.ended(1006, "gone");
    socket.send('{"type":"step"}');

    expect(sent).toEqual([]);
  });
});
