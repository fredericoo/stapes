import * as v from "valibot";
import { WEATHER_KINDS } from "../app/lib/weather";

const schema = v.object({
  PORT: v.optional(v.pipe(v.string(), v.transform(Number), v.number()), "3000"),

  DATA_DIR: v.optional(v.string(), "./.dev"),

  SEED_DIR: v.optional(v.string(), "./data"),

  SEED_MAP: v.optional(v.string(), "map.json"),

  CLIENT_BUILD_ID: v.optional(v.string()),

  ADMIN_SECRET: v.optional(v.string()),

  AUTH_SECRET: v.optional(v.string()),

  BACKUP_DIR: v.optional(v.string(), "./.dev/backups"),

  PUBLIC_ORIGIN: v.optional(v.string(), "http://localhost:3000"),

  BOTS: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
    "0",
  ),

  BOT_PASSWORD: v.optional(v.string(), "wanderer-bot-password"),

  WEATHER: v.optional(v.picklist(WEATHER_KINDS)),

  OPENAI_API_KEY: v.optional(v.string()),

  CHECKPOINT_INTERVAL_MS: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(100)),
    "2000",
  ),

  RESTART_NOTICE_MS: v.optional(v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(0))),
});

const DEPLOYED_RESTART_NOTICE_MS = 5_000;

export type Config = v.InferOutput<typeof schema> & {
  databasePath: string;
  deployed: boolean;
  restartNoticeMs: number;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = v.parse(schema, env);
  const deployed = env.NODE_ENV === "production";
  return {
    ...parsed,
    databasePath: `${parsed.DATA_DIR.replace(/\/+$/, "")}/stapes.db`,
    deployed,
    restartNoticeMs: parsed.RESTART_NOTICE_MS ?? (deployed ? DEPLOYED_RESTART_NOTICE_MS : 0),
  };
}
