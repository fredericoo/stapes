export const PER_MESSAGE_DEFLATE = false;

export interface Transport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
}

export class GameSocket {
  private attachment: unknown = null;

  constructor(private readonly transport: Transport) {}

  send(data: string): void {
    if (this.transport.closed) return;
    try {
      this.transport.send(data);
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
