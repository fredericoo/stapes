/// <reference lib="webworker" />
import { GameSocket } from "../../server/sockets";
import { PROTOCOL_VERSION, CLOSE_OUTDATED_CLIENT } from "../net/protocol";
import { LocalWorld } from "./LocalWorld";
import type { FromWorld, ToWorld } from "./workerProtocol";

let world: Promise<LocalWorld> | null = null;

/**
 * `end` is what `GameSocket` reads before every send, and it has to be set
 * by both ways a connection ends — the world closing it, and the page
 * saying the page is gone. Without the second, a tick between the page's
 * close and the world finishing with the socket posts frames at a
 * connection nobody is listening to.
 */
type Connection = { socket: GameSocket; end(): void };
const sockets = new Map<number, Connection>();

/**
 * The world is one thing and its operations are asynchronous, so without
 * this a frame could be handled before the join that seats the actor it
 * belongs to.
 */
let queue: Promise<unknown> = Promise.resolve();
function inOrder(work: () => Promise<void>): void {
  queue = queue.then(work).catch((error: unknown) => {
    console.error("[local] world failed", error);
  });
}

function post(message: FromWorld) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as ToWorld;
  switch (message.kind) {
    case "open":
      return inOrder(() => open(message.id, message.actorId, message.protocolVersion));
    case "frame":
      return inOrder(async () => {
        const connection = sockets.get(message.id);
        if (!connection || !world) return;
        await (await world).message(connection.socket, message.data);
      });
    case "close":
      return inOrder(async () => {
        const connection = sockets.get(message.id);
        if (!connection || !world) return;
        sockets.delete(message.id);
        connection.end();
        await (await world).leave(connection.socket);
      });
    case "reset":
      return inOrder(async () => {
        if (!world) return;
        await (await world).reset();
      });
  }
});

async function open(id: number, actorId: string, protocolVersion: number): Promise<void> {
  let closed = false;
  const socket = new GameSocket({
    send: (data) => post({ kind: "frame", id, data }),
    close: (code, reason) => {
      closed = true;
      post({ kind: "closed", id, code: code ?? 1000, reason: reason ?? "" });
    },
    get closed() {
      return closed;
    },
  });
  const connection: Connection = {
    socket,
    end: () => {
      closed = true;
    },
  };

  if (protocolVersion !== PROTOCOL_VERSION) {
    socket.send(JSON.stringify({ type: "outdated", serverVersion: PROTOCOL_VERSION }));
    socket.close(CLOSE_OUTDATED_CLIENT, "protocol version");
    return;
  }

  sockets.set(id, connection);
  try {
    world ??= LocalWorld.open();
    await (await world).join(socket, actorId);
  } catch (error) {
    console.error("[local] the world would not open", error);
    /** Dropped so the next attempt builds one rather than awaiting the rejection this one left behind. */
    world = null;
    sockets.delete(id);
    socket.close(1011, "could not open the world");
  }
}
