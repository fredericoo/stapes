import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
} from "kysely";
import type { Database } from "./db";

/**
 * Kysely, speaking to the connection the world already holds.
 *
 * Better Auth reaches its tables through Kysely, and Kysely reaches a database
 * through a dialect. Every dialect it ships opens a connection of its own,
 * which is the one thing this process may not do: `server/lock.ts` takes the
 * database with `PRAGMA locking_mode = EXCLUSIVE`, so a second handle on the
 * file — even from inside this process — fails on its first write. Hence a
 * dialect over the handle in hand rather than a second database for accounts.
 *
 * It is about sixty lines because Turso's driver is already the shape Kysely
 * wants: prepare, then `all` or `run`. What is left is telling Kysely which of
 * the two a statement is, and that is what `reader` answers.
 *
 * **Transactions are deliberately not wired up.** `beginTransaction` throws,
 * and Better Auth is configured with `transaction: false` so it never asks.
 * A `BEGIN` issued here would not own the connection — `WorldStore.flush`
 * commits the tick's board writes through `db.batch(…, "IMMEDIATE")` on the
 * same handle — so a checkpoint landing mid-signup would be committed by the
 * signup's `COMMIT`, or rolled back with its failure. Sign-ups are single
 * statements; a checkpoint is the whole board.
 */
export class TursoDialect implements Dialect {
  constructor(private readonly db: Database) {}

  createDriver(): Driver {
    return new TursoDriver(this.db);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class TursoDriver implements Driver {
  private readonly connection: DatabaseConnection;

  constructor(db: Database) {
    this.connection = new TursoConnection(db);
  }

  async init(): Promise<void> {}

  /**
   * One connection, handed to everybody.
   *
   * There is no pool to acquire from: the process has exactly one handle on
   * the database by design, and Turso serializes statements on it internally.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(): Promise<never> {
    throw new Error("The auth dialect does not open transactions — see TursoDialect");
  }

  async commitTransaction(): Promise<never> {
    throw new Error("The auth dialect does not open transactions — see TursoDialect");
  }

  async rollbackTransaction(): Promise<never> {
    throw new Error("The auth dialect does not open transactions — see TursoDialect");
  }

  async releaseConnection(): Promise<void> {}

  /**
   * Nothing to destroy. The database outlives Kysely — the world is still
   * using it — so closing it here would take the world down with the auth
   * layer. `World.drain` is what closes it.
   */
  async destroy(): Promise<void> {}
}

class TursoConnection implements DatabaseConnection {
  constructor(private readonly db: Database) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const statement = await this.db.prepare(compiled.sql);
    const parameters = [...compiled.parameters];
    // `reader` is the driver's own answer to "does this statement return
    // rows", taken from the prepared statement rather than guessed from the
    // SQL. Guessing would have to cope with `INSERT … RETURNING`, which Better
    // Auth uses on every create.
    if (statement.reader) {
      return { rows: (await statement.all(parameters)) as R[] };
    }
    const info = await statement.run(parameters);
    return {
      rows: [],
      numAffectedRows: BigInt(info.changes),
      insertId: BigInt(info.lastInsertRowid),
    };
  }

  /**
   * Streaming is refused rather than faked by buffering.
   *
   * Nothing in Better Auth streams, and a `streamQuery` that quietly read the
   * whole result into memory would be a table scan wearing a cursor's clothes
   * the first time something did.
   */
  // oxlint-disable-next-line require-yield -- it exists to refuse, see above
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("The auth dialect does not stream — see TursoDialect");
  }
}
