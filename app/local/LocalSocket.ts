import { SOCKET_OPEN, type ClientSocket } from "../net/socket";
import type { ToWorld } from "./workerProtocol";

/**
 * The page's end of a connection to the world in the worker.
 *
 * Shaped like a `WebSocket` because that is what the client reads — see
 * `../net/socket`. Not an `EventTarget`: the two events a session and a page
 * listen for are known here, and a pair of sets is smaller than constructing
 * `MessageEvent`s to be taken apart again a line later.
 */
export class LocalSocket implements ClientSocket {
  private state = SOCKET_OPEN;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly closeListeners = new Set<CloseListener>();

  constructor(
    private readonly post: (message: ToWorld) => void,
    private readonly id: number,
  ) {}

  get readyState(): number {
    return this.state;
  }

  send(data: string): void {
    if (this.state !== SOCKET_OPEN) return;
    this.post({ kind: "frame", id: this.id, data });
  }

  close(): void {
    if (this.state !== SOCKET_OPEN) return;
    this.post({ kind: "close", id: this.id });
    // Ended in its own turn rather than inline, because a `WebSocket` does the
    // same: `close()` returns, and the close event arrives afterwards. A page
    // that tore itself down inside its own `close()` call would be running its
    // cleanup twice over.
    queueMicrotask(() => this.ended(1000, "closed by the page"));
  }

  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "close", listener: CloseListener): void;
  addEventListener(
    type: "message" | "close",
    listener: MessageListener | CloseListener,
  ): void {
    if (type === "message") this.messageListeners.add(listener as MessageListener);
    else this.closeListeners.add(listener as CloseListener);
  }

  removeEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "close", listener: CloseListener): void;
  removeEventListener(
    type: "message" | "close",
    listener: MessageListener | CloseListener,
  ): void {
    if (type === "message") this.messageListeners.delete(listener as MessageListener);
    else this.closeListeners.delete(listener as CloseListener);
  }

  /** A frame from the world. */
  deliver(data: string): void {
    if (this.state !== SOCKET_OPEN) return;
    for (const listener of this.messageListeners) listener({ data });
  }

  /**
   * The world closed this connection.
   *
   * Announced even when the page is the one that closed it, because that is
   * what a socket does: `close()` on a `WebSocket` still ends in a close event,
   * and the page's reconnect is hung off that event.
   */
  ended(code: number, reason: string): void {
    // A connection ends once. The page closing it and the world closing it can
    // both arrive, and a second close event would start a second reconnect.
    if (this.announced) return;
    this.announced = true;
    this.state = SOCKET_CLOSED;
    for (const listener of this.closeListeners) listener({ code, reason });
  }

  private announced = false;
}

/** `WebSocket.CLOSED`. @see ../net/socket */
const SOCKET_CLOSED = 3;

type MessageListener = (event: { data: unknown }) => void;
type CloseListener = (event: { code: number; reason: string }) => void;
