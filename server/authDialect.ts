import {
  SqliteAdapter,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type DatabaseMetadataOptions,
  type Dialect,
  type Driver,
  type QueryCompiler,
  type QueryResult,
  type SchemaMetadata,
  type TableMetadata,
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

  createIntrospector(): DatabaseIntrospector {
    return new TursoIntrospector(this.db);
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

/**
 * Kysely's `SqliteIntrospector`, without the one query Turso cannot survive.
 *
 * **Kysely's reads every table's columns through `pragma_table_info(name)`, the
 * table-valued function, and on Turso 0.7 that loses every autocommit write
 * made on the connection afterwards.** They are visible in the process that
 * made them and are gone when the file is next opened. Writes inside an
 * explicit transaction still land, which is why the world's checkpoints —
 * `WorldStore.flush` commits a batch — came back after a restart while
 * accounts, sessions and characters did not. Better Auth introspects the
 * schema on its first query, which is `seedAdmin` at boot, so every account
 * made after that was lost at the next restart; the visible sign was the
 * administrator being seeded again on every boot. The `PRAGMA table_info(…)`
 * statement reads the same columns without this, so this asks one table at a
 * time.
 *
 * Otherwise a transcription of Kysely 0.29's: the same tables, the same
 * exclusions and the same guess at which column autoincrements.
 */
class TursoIntrospector implements DatabaseIntrospector {
  constructor(private readonly db: Database) {}

  async getSchemas(): Promise<SchemaMetadata[]> {
    // SQLite has no schemas.
    return [];
  }

  async getTables(
    options: DatabaseMetadataOptions = { withInternalKyselyTables: false },
  ): Promise<TableMetadata[]> {
    const listing = await this.db.prepare(
      "SELECT name, sql, type FROM sqlite_master " +
        "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const tables = (await listing.all([])) as { name: string; sql: string | null; type: string }[];
    // Kysely's own migration tables, which it leaves out unless asked.
    const internal = new Set(["kysely_migration", "kysely_migration_lock"]);

    const result: TableMetadata[] = [];
    for (const { name, sql, type } of tables) {
      if (!options.withInternalKyselyTables && internal.has(name)) continue;
      const info = await this.db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`);
      const columns = (await info.all([])) as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }[];

      // The column named beside AUTOINCREMENT in the table's own SQL, or else
      // a lone INTEGER PRIMARY KEY, which is a rowid alias. @see
      // https://www.sqlite.org/autoinc.html
      let autoIncrementing = sql
        ?.split(/[(),]/)
        .find((part) => part.toLowerCase().includes("autoincrement"))
        ?.trimStart()
        .split(/\s+/)[0]
        ?.replace(/["`]/g, "");
      if (!autoIncrementing) {
        const keys = columns.filter((column) => column.pk > 0);
        if (keys.length === 1 && keys[0]!.type.toLowerCase() === "integer") {
          autoIncrementing = keys[0]!.name;
        }
      }

      result.push({
        name,
        isView: type === "view",
        isForeign: false,
        columns: columns.map((column) => ({
          name: column.name,
          dataType: column.type,
          isNullable: !column.notnull,
          isAutoIncrementing: column.name === autoIncrementing,
          hasDefaultValue: column.dflt_value != null,
          comment: undefined,
        })),
      });
    }
    return result;
  }
}
