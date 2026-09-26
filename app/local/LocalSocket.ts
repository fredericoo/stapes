import { SOCKET_OPEN, type ClientSocket } from "../net/socket";
import type { ToWorld } from "./workerProtocol";

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
    queueMicrotask(() => this.ended(1000, "closed by the page"));
  }

  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "close", listener: CloseListener): void;
  addEventListener(type: "message" | "close", listener: MessageListener | CloseListener): void {
    if (type === "message") this.messageListeners.add(listener as MessageListener);
    else this.closeListeners.add(listener as CloseListener);
  }

  removeEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "close", listener: CloseListener): void;
  removeEventListener(type: "message" | "close", listener: MessageListener | CloseListener): void {
    if (type === "message") this.messageListeners.delete(listener as MessageListener);
    else this.closeListeners.delete(listener as CloseListener);
  }

  deliver(data: string): void {
    if (this.state !== SOCKET_OPEN) return;
    for (const listener of this.messageListeners) listener({ data });
  }

  ended(code: number, reason: string): void {
    if (this.announced) return;
    this.announced = true;
    this.state = SOCKET_CLOSED;
    for (const listener of this.closeListeners) listener({ code, reason });
  }

  private announced = false;
}

const SOCKET_CLOSED = 3;

type MessageListener = (event: { data: unknown }) => void;
type CloseListener = (event: { code: number; reason: string }) => void;
