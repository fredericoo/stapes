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
   * What session cookies are signed with.
   *
   * No default, and unlike `ADMIN_SECRET` an unset one is fatal in production
   * rather than merely closing a door: Better Auth falls back to a constant it
   * ships with, and a session signed with a published secret is a session
   * anybody can mint. Development gets a fixed string — see `authSecret`.
   */
  AUTH_SECRET: v.optional(v.string()),

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
  /** What Better Auth signs sessions with. @see AUTH_SECRET */
  authSecret: string;
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
  const deployed = env.NODE_ENV === "production";
  return {
    ...parsed,
    databasePath: `${parsed.DATA_DIR.replace(/\/+$/, "")}/stapes.db`,
    authSecret: authSecret(parsed.AUTH_SECRET, deployed),
    deployed,
  };
}

/**
 * The session signing key, or a refusal to start.
 *
 * **A deployment with no `AUTH_SECRET` stops here**, which is the one place in
 * this file that throws for a missing value. Every other secret being unset
 * disables a feature; this one being unset would leave Better Auth signing with
 * the constant it ships as a fallback, so every session cookie in the world
 * could be forged by anybody who has read its source. Failing at second zero is
 * the only honest answer.
 *
 * Development gets a fixed string rather than a random one per boot, so that
 * `bun dev` does not sign everybody out every time the server restarts — which,
 * under `--watch`, is every time anybody edits a file in `server/`.
 */
function authSecret(configured: string | undefined, deployed: boolean): string {
  if (configured) return configured;
  if (deployed) {
    throw new Error(
      "AUTH_SECRET is unset. Set it to a long random string — without one, " +
        "session cookies are signed with a published constant.",
    );
  }
  return "stapes-development-auth-secret-not-for-deployment";
}
