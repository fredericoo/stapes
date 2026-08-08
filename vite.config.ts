import { promises as fs } from "node:fs";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { DEV_DATA_PREFIX, isSafeDataKey } from "./app/lib/devData";

const DATA_DIR = path.resolve(import.meta.dirname, "data");

/**
 * Serve the repo's `data/` directory to the dev Worker, read and write.
 *
 * The Worker runs in workerd and has no filesystem, so in production it reads
 * authored content from R2. That would make art iteration a re-upload away:
 * edit a tileset in Aseprite, run `pnpm seed`, reload. This middleware keeps
 * `data/` the single source of truth while developing, so a saved PNG is live
 * on the next request and the map editor's Save lands in `data/map.json` as a
 * reviewable diff — the same loop the app had before it moved to Workers.
 *
 * Dev only (`apply: "serve"`): it is an unauthenticated write endpoint, and has
 * no business existing in a build.
 */
function devDataDirectory(): Plugin {
  return {
    name: "stapes:dev-data-directory",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(DEV_DATA_PREFIX, async (req, res) => {
        const key = decodeURIComponent((req.url ?? "").replace(/^\//, ""));
        if (!isSafeDataKey(key)) {
          res.statusCode = 400;
          res.end("Bad key");
          return;
        }

        const file = path.join(DATA_DIR, key);
        try {
          if (req.method === "GET") {
            res.statusCode = 200;
            // Art is edited in a loop; a cached sprite sheet defeats the point.
            res.setHeader("Cache-Control", "no-store");
            res.end(await fs.readFile(file));
            return;
          }

          if (req.method === "PUT") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, Buffer.concat(chunks));
            res.statusCode = 204;
            res.end();
            return;
          }

          res.statusCode = 405;
          res.end("Method not allowed");
        } catch (err) {
          const missing =
            (err as NodeJS.ErrnoException).code === "ENOENT" &&
            req.method === "GET";
          res.statusCode = missing ? 404 : 500;
          res.end(missing ? "Not found" : String(err));
        }
      });
    },
  };
}

export default defineConfig({
  // The Cloudflare plugin runs server code in workerd during dev, so a loader
  // reaching for a Node API fails here rather than on deploy.
  plugins: [
    tailwindcss(),
    devDataDirectory(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    reactRouter(),
  ],
});
