/**
 * Serve the repo's `data/` directory over HTTP, read and write.
 *
 * The Worker has no filesystem in either dev runtime, so this is how `data/`
 * stays the source of truth while developing. Two hosts, one handler:
 *
 * - `pnpm dev` mounts {@link handleDataRequest} as Vite middleware, so the
 *   Worker fetches its own origin.
 * - `pnpm dev:worker` runs {@link startDataServer} beside wrangler and points
 *   the Worker at it with `DATA_ORIGIN`.
 *
 * Never part of a build. It is an unauthenticated write endpoint over a
 * directory, which is fine on a developer's loopback and nowhere else.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEV_DATA_PREFIX, isSafeDataKey } from "../app/lib/devData";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");

/**
 * Handle one request whose URL is already relative to {@link DEV_DATA_PREFIX}.
 * Returns false when the path is not ours, so a caller mounted at the site root
 * can fall through.
 */
export async function handleDataRequest(
  req: IncomingMessage,
  res: ServerResponse,
  relativeUrl: string,
): Promise<boolean> {
  const key = decodeURIComponent(relativeUrl.replace(/^\//, ""));
  if (!isSafeDataKey(key)) {
    res.statusCode = 400;
    res.end("Bad key");
    return true;
  }

  const file = path.join(DATA_DIR, key);
  try {
    if (req.method === "GET") {
      res.statusCode = 200;
      // Art is edited in a loop; a cached sprite sheet defeats the point.
      res.setHeader("Cache-Control", "no-store");
      res.end(await fs.readFile(file));
      return true;
    }

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.concat(chunks));
      res.statusCode = 204;
      res.end();
      return true;
    }

    res.statusCode = 405;
    res.end("Method not allowed");
  } catch (err) {
    const missing =
      (err as NodeJS.ErrnoException).code === "ENOENT" && req.method === "GET";
    res.statusCode = missing ? 404 : 500;
    res.end(missing ? "Not found" : String(err));
  }
  return true;
}

/** Stand-alone host for the same handler, for runtimes with no Vite in front. */
export function startDataServer(port: number) {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (!url.startsWith(DEV_DATA_PREFIX)) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    void handleDataRequest(req, res, url.slice(DEV_DATA_PREFIX.length));
  });
  // Loopback only. Nothing here should be reachable off the machine.
  server.listen(port, "127.0.0.1");
  return server;
}
