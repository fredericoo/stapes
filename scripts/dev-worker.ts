/**
 * Run the app on the real Workers runtime, with `data/` still the source of
 * truth.
 *
 * `pnpm dev` cannot serve `/online`: Vite's dev server does not pass WebSocket
 * upgrades through to the Worker. This runs workerd instead, which does — at
 * the cost of no HMR, since it serves a build.
 *
 * Two processes: a file server over `data/`, and wrangler pointed at it with
 * `DATA_ORIGIN`. Without that the Worker would fall back to R2 and quietly stop
 * seeing edits, which is the whole thing this is here to avoid.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { startDataServer } from "./dataFiles";

const REPO = path.resolve(import.meta.dirname, "..");
const DATA_PORT = Number(process.env.STAPES_DATA_PORT ?? 5181);
const WORKER_PORT = process.env.PORT ?? "5180";

const dataServer = startDataServer(DATA_PORT);
console.log(`data/ served on http://127.0.0.1:${DATA_PORT}`);

const wrangler = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "-c",
    "build/server/wrangler.json",
    "--port",
    WORKER_PORT,
    // Both loopback names, so two browser tabs can hold two cookies and act as
    // two players. Same-origin tabs share one and are the same actor.
    "--ip",
    "0.0.0.0",
    // Absolute: with `-c build/server/wrangler.json` the default state
    // directory resolves next to that config, silently creating an empty
    // bucket, and every read misses.
    "--persist-to",
    path.join(REPO, ".wrangler/state"),
    "--var",
    `DATA_ORIGIN:http://127.0.0.1:${DATA_PORT}`,
  ],
  { cwd: REPO, stdio: "inherit" },
);

function shutdown(code: number) {
  dataServer.close();
  process.exit(code);
}

wrangler.on("exit", (code) => shutdown(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    wrangler.kill(signal);
    shutdown(0);
  });
}
