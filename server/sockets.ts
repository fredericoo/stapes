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
 * How the game socket compresses: the server's frames one message at a time,
 * and each client's frames with a decompressor of that connection's own.
 *
 * **Safari compresses against everything it sent before, whatever the
 * handshake says.** With `perMessageDeflate: true`, Bun answers every offer
 * with `client_no_context_takeover` and reads client frames with one
 * decompressor shared by every socket and reset between messages. Safari 27
 * compresses each message against the ones before it anyway, so its second
 * message — the second step of a walk — refers back to bytes the server has
 * already thrown away. Bun fails to inflate it and drops the connection
 * without a close frame, which Safari reports as "The network connection was
 * lost", and the page reconnects into the same thing. Chrome resets as it is
 * asked to, which is why only Safari looped.
 *
 * A dedicated decompressor keeps each connection's window, so Bun stops asking
 * for `client_no_context_takeover` and reads a client that resets and one that
 * does not alike. It costs about 16KB a connection, 16MB at a thousand. Bun
 * 1.3.8's dedicated decompressor dropped the same messages and 1.4.2's reads
 * them; `server/sockets.test.ts` holds it to that. The server's own frames stay
 * on the shared compressor, which keeps no state between messages and says so
 * with `server_no_context_takeover`.
 */
export const PER_MESSAGE_DEFLATE = { compress: "shared", decompress: "dedicated" } as const;

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
