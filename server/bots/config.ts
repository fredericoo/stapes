import * as v from "valibot";

/**
 * Everything the bot runner needs from its environment, parsed once at boot.
 *
 * The same arrangement `server/config.ts` is under, and for the same reason: a
 * malformed variable should stop the process at second zero rather than surface
 * as a bot that joins and never thinks.
 *
 * **An absent `BOT_API_KEY` disables bots entirely**, on exactly the terms an
 * absent `ADMIN_SECRET` disables the admin routes. There is no default key and
 * no default provider credential, so a preview deployment and a CI run need no
 * configuration and no secret — they simply have no bots. That is the property
 * worth protecting: nobody should be able to make this spend money by forgetting
 * to set something.
 */
const schema = v.object({
  /**
   * How many bots to run. Zero, unless somebody says otherwise.
   *
   * Ignored without a key: the key is what decides whether the feature exists at
   * all, and a count without one would be a process that starts, joins the
   * world, and asks nobody anything.
   */
  BOT_COUNT: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(0)),
    "0",
  ),

  /** The provider credential. Unset disables bots. See above. */
  BOT_API_KEY: v.optional(v.string()),

  /**
   * Which provider to ask.
   *
   * Every adapter is installed and none is the default by accident — which of
   * the fast, cheap models this game is played by has not been settled, and
   * this is where it gets settled when it is. Adding another is a case in
   * `./tanstackModel` and a dependency, and nothing else.
   */
  BOT_PROVIDER: v.optional(
    v.picklist(["gemini", "grok", "openai"]),
    "gemini",
  ),

  /** Which model of that provider. Left to the provider's own default if unset. */
  BOT_MODEL: v.optional(v.string()),

  /** The world to join. The same origin a browser would open. */
  BOT_ORIGIN: v.optional(v.string(), "http://localhost:3000"),

  /** The spend ceiling, per bot. See `./runner`'s `DecisionGuard`. */
  BOT_DECISIONS_PER_MINUTE: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1)),
    "30",
  ),

  /** Consecutive provider failures before a bot parks. */
  BOT_FAILURE_LIMIT: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1)),
    "5",
  ),
});

export type BotConfig = v.InferOutput<typeof schema> & {
  /**
   * Whether to run any bots at all.
   *
   * Both halves, and the key is the half that cannot be defaulted: a count
   * without a key is a misconfiguration and a key without a count is somebody
   * who has not turned them on yet. Neither is an error worth stopping for.
   */
  enabled: boolean;
};

export function readBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = v.parse(schema, env);
  return {
    ...parsed,
    enabled: Boolean(parsed.BOT_API_KEY) && parsed.BOT_COUNT > 0,
  };
}
