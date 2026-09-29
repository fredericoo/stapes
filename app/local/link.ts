import type { WorldLink } from "../net/link";
import { PROTOCOL_VERSION } from "../net/protocol";
import { LocalSocket } from "./LocalSocket";
import type { FromWorld, ToWorld } from "./workerProtocol";

export const localLink: WorldLink = (() => {
  let worker: Worker | null = null;
  let opened = 0;
  const connections = new Map<number, LocalSocket>();

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    worker = new Worker(new URL("./world.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent) => {
      const message = event.data as FromWorld;
      const socket = connections.get(message.id);
      if (!socket) return;
      if (message.kind === "frame") return socket.deliver(message.data);
      connections.delete(message.id);
      socket.ended(message.code, message.reason);
    });
    return worker;
  };

  return {
    id: "local",

    open() {
      const id = ++opened;
      const port = ensureWorker();
      const socket = new LocalSocket((message) => port.postMessage(message), id);
      connections.set(id, socket);
      port.postMessage({
        kind: "open",
        id,
        actorId: actorId(),
        protocolVersion: PROTOCOL_VERSION,
      } satisfies ToWorld);
      return socket;
    },

    reset() {
      ensureWorker().postMessage({ kind: "reset" } satisfies ToWorld);
      return Promise.resolve();
    },
  };
})();

const ACTOR_STORAGE_KEY = "stapes:local-actor";

function actorId(): string {
  try {
    const existing = localStorage.getItem(ACTOR_STORAGE_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    localStorage.setItem(ACTOR_STORAGE_KEY, minted);
    return minted;
  } catch {
    return crypto.randomUUID();
  }
}
