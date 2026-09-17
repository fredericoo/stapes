/**
 * The sockets `GameServer` talks to.
 *
 * `GameServer` reaches them through `this.ctx.getWebSockets()` and stores an
 * actor id on each with `serializeAttachment`, which is an ordinary way to
 * hang an id off a connection.
 */

/** What a socket can be asked to do. */
export interface Transport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
}

/**
 * One connection, carrying whatever the world attached to it.
 *
 * `send` swallows failures rather than throwing. A broadcast walks every socket
 * and one that died between the loop starting and reaching it is ordinary — the
 * close handler is already on its way, and letting the throw escape would take
 * down the tick for everybody else.
 */
export class GameSocket {
  private attachment: unknown = null;

  constructor(private readonly transport: Transport) {}

  send(data: string): void {
    if (this.transport.closed) return;
    try {
      this.transport.send(data);
    } catch {
      // See above: a dead socket is not an error worth a tick.
    }
  }

  close(code?: number, reason?: string): void {
    try {
      this.transport.close(code, reason);
    } catch {
      // Already gone, which is the outcome asked for.
    }
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

/**
 * Every open connection to the world.
 *
 * Insertion-ordered, which matters more than it looks: `playerCount` and every
 * flush walk this set, and a stable order means a patch's recipients are in the
 * same order each tick rather than reshuffling under a hash.
 */
export class SocketHub {
  private readonly sockets = new Set<GameSocket>();

  accept(socket: GameSocket): void {
    this.sockets.add(socket);
  }

  drop(socket: GameSocket): void {
    this.sockets.delete(socket);
  }

  /**
   * A snapshot, not the live set.
   *
   * `dropSocket` runs while `GameServer` is iterating in several places, and a
   * `Set` mutated mid-iteration is how a broadcast silently skips somebody.
   */
  all(): GameSocket[] {
    return [...this.sockets];
  }

  get size(): number {
    return this.sockets.size;
  }
}

/**
 * The context object `GameServer` is constructed with. `storage` is the
 * {@link WorldStore}.
 */
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
