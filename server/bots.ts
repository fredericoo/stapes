import type { Config } from "./config";

export const BOT_NAMES = [
  "Wanderer",
  "Rover",
  "Lumen",
  "Bramble",
  "Tamsin",
  "Corvin",
  "Wren",
  "Hollis",
];

export const BOT_RESTART_MS = 10_000;

const BOT_ENTRY = new URL("../bots/index.ts", import.meta.url).pathname;

export type RunningBots = { stop(): void };

/**
 * Starts `config.BOTS` bot processes that reach the server on localhost but
 * sign in with `PUBLIC_ORIGIN`, the only origin a deployed server accepts.
 * Each is passed only what it reads, never `ADMIN_SECRET`, and runs `--smol`
 * to share a preview's memory limit with the server.
 */
export function startBots(config: Config, port: number): RunningBots {
  const names = BOT_NAMES.slice(0, config.BOTS);
  const running = new Map<string, ReturnType<typeof Bun.spawn>>();
  let stopped = false;

  const start = (name: string) => {
    if (stopped) return;
    const child = Bun.spawn([process.execPath, "--smol", BOT_ENTRY], {
      env: {
        STAPES_URL: `http://127.0.0.1:${port}`,
        STAPES_ORIGIN: config.PUBLIC_ORIGIN,
        BOT_USERNAME: `${name.toLowerCase()}bot`,
        BOT_PASSWORD: config.BOT_PASSWORD,
        BOT_CHARACTER: name,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    running.set(name, child);
    void child.exited.then((code) => {
      running.delete(name);
      if (stopped) return;
      console.error(`[bots] ${name} exited with ${code}; restarting in ${BOT_RESTART_MS}ms`);
      setTimeout(() => start(name), BOT_RESTART_MS);
    });
  };

  if (names.length) console.log(`[bots] starting ${names.join(", ")}`);
  for (const name of names) start(name);

  return {
    stop() {
      stopped = true;
      for (const child of running.values()) child.kill();
    },
  };
}
