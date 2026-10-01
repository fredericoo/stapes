import type { Config } from "./config";

export const BOT_RESTART_MS = 10_000;

const BOT_ENTRY = new URL("../bots/index.ts", import.meta.url).pathname;

export type RunningBots = { stop(): void };

/**
 * Starts one process playing `config.BOTS` bots, which reaches the server on
 * localhost but signs in with `PUBLIC_ORIGIN`, the only origin a deployed
 * server accepts. It is passed only what it reads, never `ADMIN_SECRET`, and
 * runs `--smol`, since it shares the container's memory limit with the server.
 */
export function startBots(config: Config, port: number): RunningBots {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;

  const start = () => {
    if (stopped) return;
    child = Bun.spawn([process.execPath, "--smol", BOT_ENTRY], {
      env: {
        STAPES_URL: `http://127.0.0.1:${port}`,
        STAPES_ORIGIN: config.PUBLIC_ORIGIN,
        BOT_PASSWORD: config.BOT_PASSWORD,
        BOTS: String(config.BOTS),
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    void child.exited.then((code) => {
      child = null;
      if (stopped) return;
      console.error(`[bots] exited with ${code}; restarting in ${BOT_RESTART_MS}ms`);
      setTimeout(start, BOT_RESTART_MS);
    });
  };

  if (config.BOTS > 0) {
    console.log(`[bots] starting ${config.BOTS}`);
    start();
  }

  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}
