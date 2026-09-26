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

  async destroy(): Promise<void> {}
}

class TursoConnection implements DatabaseConnection {
  constructor(private readonly db: Database) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const statement = await this.db.prepare(compiled.sql);
    const parameters = [...compiled.parameters];
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

  // oxlint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("The auth dialect does not stream — see TursoDialect");
  }
}

class TursoIntrospector implements DatabaseIntrospector {
  constructor(private readonly db: Database) {}

  async getSchemas(): Promise<SchemaMetadata[]> {
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
