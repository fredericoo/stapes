import { BotBody } from "./body";
import { readBotConfig } from "./config";
import { BotRunner, DEFAULT_BOT_LIMITS } from "./runner";
import { botAdapter, TanStackBotModel } from "./tanstackModel";
import { HttpBotTransport, type BotTransport } from "./transport";

/**
 * The bot runner: a second Bun process beside the world, joining it as clients.
 *
 * A separate process rather than actors inside `server/index.ts`, and the reason
 * is the one this whole feature is built on: a bot that reaches the world only
 * through a socket can do exactly what a person can, by construction rather than
 * by convention. It also never opens the database — the exclusive lock is the
 * world's, and there is nothing here that would want it.
 *
 * Deployed in the same container as the world, so `PROTOCOL_VERSION` can never
 * skew between them.
 *
 * **It does nothing without a key.** See `./config`: an unset `BOT_API_KEY`
 * exits cleanly, so preview deployments and CI need no secret and get no bots.
 */
async function main() {
  const config = readBotConfig();
  if (!config.enabled) {
    console.log(
      `[bots] nothing to do (BOT_API_KEY ${config.BOT_API_KEY ? "set" : "unset"}, BOT_COUNT ${config.BOT_COUNT})`,
    );
    return;
  }

  const transport: BotTransport = new HttpBotTransport(config.BOT_ORIGIN);
  const { tiles } = await transport.bootstrap();
  const model = new TanStackBotModel(botAdapter(config));
  const limits = {
    ...DEFAULT_BOT_LIMITS,
    maxDecisionsPerMinute: config.BOT_DECISIONS_PER_MINUTE,
    failureLimit: config.BOT_FAILURE_LIMIT,
  };

  const runners: BotRunner[] = [];
  for (let i = 0; i < config.BOT_COUNT; i++) {
    const body = new BotBody(await transport.connect(), tiles);
    runners.push(new BotRunner({ body, model, limits }));
  }
  console.log(
    `[bots] ${runners.length} on ${config.BOT_ORIGIN} via ${config.BOT_PROVIDER}`,
  );

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.log(`[bots] ${signal} — stopping`);
      for (const runner of runners) runner.stop();
    });
  }

  await Promise.all(runners.map((runner) => runner.run()));
}

await main();
