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
   * Which client build to fall back to if nothing has been activated yet.
   *
   * Almost never needed. The server writes down what it is serving and comes
   * back up on it, so this only matters for the very first deploy — see
   * `ClientBundle.restore`. Builds themselves live on the volume under
   * `clients/`, put there by `POST /api/client/upload`; there is no bucket.
   */
  CLIENT_BUILD_ID: v.optional(v.string()),

  /** Bearer token for the admin endpoints. Unset makes them 404 rather than open. */
  ADMIN_SECRET: v.optional(v.string()),

  /**
   * Where `POST /api/backup` writes snapshots.
   *
   * A separate mount from `DATA_DIR` in production, because a backup sitting on
   * the volume it is protecting is not a backup.
   */
  BACKUP_DIR: v.optional(v.string(), "./.dev/backups"),

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
  /**
   * Whether authored content lives in the database rather than in `data/`.
   *
   * Development reads the repository directory so an edited tileset is live on
   * the next request and an editor Save lands in `git diff`. A deployment has
   * no repository, so it reads the blob table and seeds it from the image.
   */
  deployed: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = v.parse(schema, env);
  return {
    ...parsed,
    databasePath: `${parsed.DATA_DIR.replace(/\/+$/, "")}/stapes.db`,
    deployed: env.NODE_ENV === "production",
  };
}
