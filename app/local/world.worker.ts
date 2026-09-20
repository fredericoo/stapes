/// <reference lib="webworker" />
import { GameSocket } from "../../server/sockets";
import { PROTOCOL_VERSION, CLOSE_OUTDATED_CLIENT } from "../net/protocol";
import { LocalWorld } from "./LocalWorld";
import type { FromWorld, ToWorld } from "./workerProtocol";

/**
 * The server, as a thread.
 *
 * This file is the whole of what `server/index.ts` is for a world in a tab:
 * something owns a world, accepts connections, and hands raw frames between
 * them. It is a worker rather than a corner of the page because the alternative
 * is a simulation sharing a thread with a renderer that wants every millisecond
 * of it — a tick that arrives late because a frame was being drawn is a
 * different world from the one the server runs, and the point of `/admin/play`
 * is that it is not a different world.
 *
 * One world per worker and one worker per tab, so two tabs are two worlds
 * rather than one shared between them. The `SharedWorker` that would make them
 * one is a real option and a later one — nothing above this file assumes
 * either, because the world already accepts any number of connections.
 */

/** Opened on the first connection rather than on load: a worker nobody connects to costs nothing. */
let world: Promise<LocalWorld> | null = null;

/**
 * One connection, and the flag that says it is over.
 *
 * The flag is what `GameSocket` reads before every send, and it has to be set
 * by *both* ways a connection ends — the world closing it, and the page saying
 * the page is gone. Without the second, a tick between the page's close and the
 * world finishing with the socket posts frames at a connection nobody is
 * listening to.
 */
type Connection = { socket: GameSocket; end(): void };
const sockets = new Map<number, Connection>();

/**
 * Everything the world is asked to do, in order.
 *
 * The world is one thing and its operations are asynchronous, so without this a
 * frame could be handled before the join that seats the actor it belongs to.
 * The server has the same property for the same reason — one world, one
 * sequence — it just gets it from a socket delivering in order.
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

async function open(
  id: number,
  actorId: string,
  protocolVersion: number,
): Promise<void> {
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

  // A stale page is told so and closed rather than refused silently, exactly as
  // the server does it. It cannot happen while the page and the world are the
  // same bundle — which is the point of checking: the day this world is served
  // from somewhere else, the handshake already exists.
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
    // Dropped so the next attempt builds one rather than awaiting the rejection
    // this one left behind — the same trap `GameServer.ensureLoaded` clears.
    world = null;
    sockets.delete(id);
    // 1011 is what a server says when it failed rather than when it went away,
    // and the page treats it as every other unexpected close: reconnect.
    socket.close(1011, "could not open the world");
  }
}
