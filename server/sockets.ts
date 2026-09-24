/**
 * The socket side of the Durable Object's context, reimplemented.
 *
 * `GameServer` reaches sockets through `this.ctx.getWebSockets()` and stores an
 * actor id on each with `serializeAttachment`. That API exists on Cloudflare
 * because a hibernating object may be evicted while its connections stay open,
 * so the id has to survive in the platform's hands rather than in a `Map` the
 * object no longer has. Nothing hibernates here — but keeping the shape keeps
 * `GameServer` and its tests unchanged, and an attachment is a perfectly
 * ordinary way to hang an id off a connection.
 */

/**
 * Whether the game socket compresses: it does not, because Safari cannot read
 * what Bun compresses.
 *
 * **Bun seals most of the frames it compresses.** A message that compresses
 * small — every ordinary patch, and larger ones that compress well — goes out
 * as a complete deflate stream, final block and all, followed by a stray zero
 * byte. Only messages that stay large compressed, like a `hello`, go out as the
 * open, sync-flushed stream RFC 7692 describes. Chrome reads both. Safari reads
 * a `hello` and the first sealed patch after it, and loses the connection at
 * the next one: "The network connection was lost", a moment after joining and
 * at once when walking, since a walk is what sends patches. The page
 * reconnects into the same thing, over and over. One decompressor kept for a
 * whole connection, which is how Safari appears to read, behaves the same way:
 * nothing after the first sealed message decodes.
 *
 * **It broke when compression started, not when it was agreed.** Bun agreed to
 * `permessage-deflate` from the day it was switched on, but compressed nothing
 * until `send` was told to (#279), and Safari stopped staying connected that
 * day. Safari's own compressed messages were read fine throughout.
 *
 * A compressor per socket (`compress: "dedicated"`) sends only open streams,
 * which such a decompressor reads, but holds about 147KB a socket (147MB at a
 * thousand) and is the slowest of the three on the thread that runs the tick:
 * a patch-sized frame took about 15µs to send through it, 11µs through the
 * shared compressor and 2µs raw. Off, then, until a setting is proven against
 * a real Safari, and `server/sockets.test.ts` says what that setting must
 * never send.
 */
export const PER_MESSAGE_DEFLATE = false;

/** What a socket can be asked to do, once the transport is abstracted away. */
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

  /**
   * Whether the far end has gone.
   *
   * Read by `server/index.ts` between the two lookups that check a socket's
   * account and its character: a tab shut in that window must not be seated,
   * because nothing would take the body off the board until the next load
   * reaped it.
   */
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
   * The Durable Object's `getWebSockets()` returns an array for the same
   * reason.
   */
  all(): GameSocket[] {
    return [...this.sockets];
  }

  get size(): number {
    return this.sockets.size;
  }
}

/**
 * The context object `GameServer` is constructed with.
 *
 * Named for what it replaces so the several hundred `this.ctx.*` call sites in
 * that file did not have to be touched. `storage` is the {@link WorldStore}.
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
