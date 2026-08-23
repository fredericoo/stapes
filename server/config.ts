import * as v from "valibot";

/**
 * Everything the process needs from its environment, parsed once at boot.
 *
 * Validated rather than read ad hoc, because the failure mode otherwise is a
 * server that starts, serves, and only discovers at the first editor save that
 * `BUCKET_NAME` was a typo. A missing or malformed variable should stop the
 * process at second zero, on the deploy that introduced it.
 *
 * Every value has a development default except the secrets, which deliberately
 * have none: an unset `RESET_SECRET` disables `/api/reset` entirely rather than
 * defaulting to something guessable. See `resetSecret` below.
 */
const schema = v.object({
  /** Where the server listens. `0` asks the OS for a free port — see `scripts/dev.ts`. */
  PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.number()), "3000"),

  /**
   * Directory holding `stapes.db` and its WAL sidecars.
   *
   * A directory rather than a file path, and it matters in two places: WAL
   * means `stapes.db-wal` and `stapes.db-shm` sit beside the database and have
   * to travel with it, and Coolify's persistent storage errors when pointed at
   * an individual file (coolify#5337). Mount this directory.
   */
  DATA_DIR: v.optional(v.string(), "./.dev"),

  /**
   * The repo's `data/` directory, read when the database is empty.
   *
   * Authored content is checked in, so a fresh deployment builds its own world
   * from the image rather than needing a seed step. See `server/seed.ts`.
   */
  SEED_DIR: v.optional(v.string(), "./data"),

  /**
   * Where the built client lives, as `s3://bucket/prefix`-style parts.
   *
   * Absent in development, where Vite serves the client and this server only
   * answers `/api` and the socket. Present in every deployed environment.
   */
  CLIENT_BUCKET: v.optional(v.string()),
  CLIENT_BUCKET_ENDPOINT: v.optional(v.string()),
  CLIENT_BUCKET_REGION: v.optional(v.string(), "auto"),
  CLIENT_BUCKET_ACCESS_KEY_ID: v.optional(v.string()),
  CLIENT_BUCKET_SECRET_ACCESS_KEY: v.optional(v.string()),

  /**
   * Build to serve, as the prefix written by CI: `builds/<sha>`.
   *
   * Set at deploy time so a fresh container comes up on a known build without
   * having to be told. `POST /api/client/activate` changes it at runtime, which
   * is what makes a client deploy free of a restart.
   */
  CLIENT_BUILD_ID: v.optional(v.string()),

  /** Bearer token for `/api/reset` and `/api/client/activate`. Unset disables both. */
  ADMIN_SECRET: v.optional(v.string()),

  /**
   * Public origin, for logs and for the health payload.
   *
   * Not used to build links the client follows — those are all relative, which
   * is what single-origin deployment buys.
   */
  PUBLIC_ORIGIN: v.optional(v.string(), "http://localhost:3000"),

  /** Milliseconds between checkpoint flushes. See `WorldStore.flush`. */
  CHECKPOINT_INTERVAL_MS: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(100)),
    "2000",
  ),
});

export type Config = v.InferOutput<typeof schema> & {
  /** `DATA_DIR` joined to the database filename. */
  databasePath: string;
  /** Whether a client bundle should be fetched and served. */
  servesClient: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = v.parse(schema, env);
  return {
    ...parsed,
    databasePath: `${parsed.DATA_DIR.replace(/\/+$/, "")}/stapes.db`,
    servesClient: Boolean(parsed.CLIENT_BUCKET),
  };
}
