import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import type { FleetConfig } from "./fleet";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    qty: { type: "string" },
    url: { type: "string" },
  },
});

const env = process.env;

/** `thelaststones.com` is read as `https://thelaststones.com`. */
function withScheme(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

const base = withScheme(values.url ?? env.STAPES_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const fleet: FleetConfig = {
  base,
  origin: env.STAPES_ORIGIN ?? base,
  password: env.BOT_PASSWORD ?? "wanderer-bot-password",
};
const count = Math.max(1, Number(values.qty ?? env.BOTS ?? 1) || 1);

/**
 * Each bot keeps a whole client — the socket's stream parsed and applied, and
 * a map of everything it has seen — on one thread, so bots are spread over
 * worker threads, one fewer than the machine has cores.
 */
const threads = Math.max(1, Math.min(count, availableParallelism() - 1));
const shares = Array.from({ length: threads }, (_, t) =>
  Array.from({ length: count }, (_, i) => i).filter((i) => i % threads === t),
);

console.log(`[bots] ${count} on ${base}, over ${threads} threads`);
const entry = new URL("./worker.ts", import.meta.url).href;
await Promise.all(
  shares.map(
    (indices) =>
      new Promise<void>((resolve) => {
        const worker = new Worker(entry, { workerData: { fleet, indices } });
        worker.on("error", (error) => console.error("[bots]", error));
        worker.on("exit", () => resolve());
      }),
  ),
);
