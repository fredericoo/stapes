import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { DEV_DATA_PREFIX } from "./app/lib/devData";
import { handleDataRequest } from "./scripts/dataFiles";

/**
 * Serve the repo's `data/` directory to the dev Worker.
 *
 * The Worker runs in workerd and has no filesystem, so in production it reads
 * authored content from R2. That would make art iteration a re-upload away:
 * edit a tileset in Aseprite, run `pnpm seed`, reload. This keeps `data/` the
 * single source of truth while developing, so a saved PNG is live on the next
 * request and the map editor's Save lands in `data/map.json` as a reviewable
 * diff — the same loop the app had before it moved to Workers.
 *
 * The handler is shared with `pnpm dev:worker`, which hosts it standalone
 * because there is no Vite in front of workerd there.
 *
 * Dev only (`apply: "serve"`): it is an unauthenticated write endpoint, and has
 * no business existing in a build.
 */
function devDataDirectory(): Plugin {
  return {
    name: "stapes:dev-data-directory",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(DEV_DATA_PREFIX, (req, res) => {
        void handleDataRequest(req, res, req.url ?? "/");
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
