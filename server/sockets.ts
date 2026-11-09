/**
 * Negotiated so a `hello` can be compressed, and only a `hello` is: Bun sends
 * a message that compresses small as a complete deflate stream, and Safari
 * drops the connection at the next frame of any kind after one. A padded
 * `hello` always goes out as the open stream Safari reads. See "A frame is
 * compressed only when `send` is told to" in `docs/notes.md`.
 */
export const PER_MESSAGE_DEFLATE = true;

/**
 * Bun seals a message whose compressed form is under about 4KB, a tiny or very
 * uniform world's `hello` included, and Safari then drops the connection at
 * the next frame of any kind. This much random text never compresses below
 * that, so a `hello` carrying it always goes out as an open stream.
 */
const HELLO_PADDING_BYTES = 6 * 1024;

export const HELLO_PADDING = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(HELLO_PADDING_BYTES))),
);

export interface Transport {
  send(data: string, compress?: boolean): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
}

export class GameSocket {
  private attachment: unknown = null;

  constructor(private readonly transport: Transport) {}

  send(data: string, compress = false): void {
    if (this.transport.closed) return;
    try {
      this.transport.send(data, compress);
    } catch {}
  }

  close(code?: number, reason?: string): void {
    try {
      this.transport.close(code, reason);
    } catch {}
  }

  get closed(): boolean {
    return this.transport.closed;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

export class SocketHub {
  private readonly sockets = new Set<GameSocket>();

  accept(socket: GameSocket): void {
    this.sockets.add(socket);
  }

  drop(socket: GameSocket): void {
    this.sockets.delete(socket);
  }

  all(): GameSocket[] {
    return [...this.sockets];
  }

  get size(): number {
    return this.sockets.size;
  }
}

export interface WorldContext {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
    put(key: string, value: unknown, options?: unknown): Promise<void>;
    put(entries: Record<string, unknown>, options?: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    delete(keys: string[]): Promise<number>;
    deleteAll(): Promise<void>;
    setAlarm(atMs: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    readonly sql: { exec(query: string, ...bindings: unknown[]): void };
  };
  getWebSockets(): GameSocket[];
  acceptWebSocket(socket: GameSocket): void;
}
