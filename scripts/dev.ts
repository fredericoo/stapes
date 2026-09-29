import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

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

async function portFor(variable: string): Promise<number> {
  const pinned = process.env[variable];
  if (pinned === undefined) return await freePort();
  const port = Number(pinned);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variable} is "${pinned}", which is not a port`);
  }
  return port;
}

const serverPort = await portFor("STAPES_SERVER_PORT");
const clientPort = await portFor("STAPES_CLIENT_PORT");
const serverOrigin = `http://localhost:${serverPort}`;

const children: ChildProcess[] = [];

function run(name: string, command: string[], env: Record<string, string>) {
  const child = spawn(command[0]!, command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });

  child.on("error", (error) => {
    console.error(`[dev] ${name} could not start:`, error.message);
    stop();
  });

  child.on("exit", (code, signal) => {
    if (!stopping) {
      const how = signal ? `killed by ${signal}` : `exited ${code}`;
      if (signal || code !== 0) console.error(`\n[dev] ${name} ${how}`);
    }
    stop();
  });

  children.push(child);
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
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

/**
 * Vite runs on Node, not Bun. With `--bun` it aborts a few seconds after start,
 * because Vite 8 drives rolldown through native bindings that do not load under Bun.
 */
run("client", ["bunx", "vite", "dev", "--host"], {
  PORT: String(clientPort),
  STAPES_SERVER_ORIGIN: serverOrigin,
});

console.log(`\n  stapes  →  http://localhost:${clientPort}` + `\n  server  →  ${serverOrigin}\n`);
