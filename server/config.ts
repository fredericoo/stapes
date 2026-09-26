import * as v from "valibot";

const schema = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.number()), "3000"),

  DATA_DIR: v.optional(v.string(), "./.dev"),

  SEED_DIR: v.optional(v.string(), "./data"),

  CLIENT_BUILD_ID: v.optional(v.string()),

  ADMIN_SECRET: v.optional(v.string()),

  AUTH_SECRET: v.optional(v.string()),

  BACKUP_DIR: v.optional(v.string(), "./.dev/backups"),

  PUBLIC_ORIGIN: v.optional(v.string(), "http://localhost:3000"),

  CHECKPOINT_INTERVAL_MS: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(100)),
    "2000",
  ),
});

export type Config = v.InferOutput<typeof schema> & {
  databasePath: string;
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
