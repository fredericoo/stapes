/**
 * Run both halves of the app, on ports nothing else is using.
 *
 * Several worktrees of this repository run `bun dev` at once. That used to be
 * free — each had its own `.wrangler` state directory, so the world and its
 * storage were isolated by construction. It stays free for *state*, since the
 * database is a file inside the worktree, but ports are shared: Vite would pick
 * the next one up from 5173 while the server sat on a fixed 3000, and the
 * second worktree's client would quietly proxy to the first worktree's world.
 *
 * That failure looks exactly like a state bug and is not one, so this asks the
 * operating system for two free ports and tells each half about the other.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/** Ask the OS for a port nobody holds, then let go of it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("Could not read back a port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

const serverPort = await freePort();
const clientPort = await freePort();
const serverOrigin = `http://localhost:${serverPort}`;

const children: ChildProcess[] = [];

function run(name: string, command: string[], env: Record<string, string>) {
  const child = spawn(command[0]!, command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("exit", (code) => {
    // One half dying should take the other with it. A client proxying to a
    // server that is gone reports every request as a network error, which reads
    // like a bug in the app rather than a process that is not running.
    if (code !== 0 && code !== null) console.error(`[dev] ${name} exited ${code}`);
    stop();
  });
  children.push(child);
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  // SIGTERM rather than SIGKILL: the server's drain runs on it, which is what
  // makes stopping a dev session leave a checkpoint behind rather than losing
  // the last couple of seconds of whatever was being tried.
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 2000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, stop);
}

run("server", ["bun", "--watch", "server/index.ts"], {
  PORT: String(serverPort),
  PUBLIC_ORIGIN: `http://localhost:${clientPort}`,
});

run("client", ["bunx", "--bun", "vite", "dev", "--host"], {
  PORT: String(clientPort),
  STAPES_SERVER_ORIGIN: serverOrigin,
});

console.log(
  `\n  stapes  →  http://localhost:${clientPort}` +
    `\n  server  →  ${serverOrigin}\n`,
);
