import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * The dev server for the client alone.
 *
 * `/api` and the game socket are proxied through to the Bun server beside it,
 * so development is single-origin exactly like production: the `HttpOnly` actor
 * cookie is first-party, and there is no CORS anywhere in the project.
 *
 * The topology is inverted from production — Vite fronts the server here, and
 * the server fronts the files there — but since both are one origin, no line of
 * application code can tell. The alternative, proxying Vite's own HMR socket
 * through Elysia to match production exactly, is custom code in the hot path of
 * the daily loop to fix something nothing can observe.
 */
const SERVER_ORIGIN =
  process.env.STAPES_SERVER_ORIGIN ?? "http://localhost:3000";

/**
 * The directory `node_modules` is actually in, walking up from here.
 *
 * A git worktree has no dependencies of its own — everything resolves to the
 * main checkout's `node_modules`, which is *above* the worktree root. Vite
 * serves nothing outside its own root by default, and the file that trips over
 * that is not one of ours: this app has no `entry.client.tsx`, so React Router
 * hands Vite the default one out of its own package, and a worktree loads a
 * blank page with a 403 behind it. The main checkout never sees it, because
 * there the two roots are the same directory.
 *
 * Found rather than written down, because the answer is different in a worktree
 * and in the checkout, and a relative hop up would be a count of directories
 * that only holds for wherever worktrees happen to live today.
 */
function dependencyRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "node_modules/vite"))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

export default defineConfig({
  server: {
    // Whoever launched us says where to listen. `scripts/dev.ts` picks free
    // ports for both halves, so several worktrees can run at once — which they
    // do, and which used to be free because each had its own `.wrangler`.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: false },
      "/online/ws": { target: SERVER_ORIGIN, ws: true, changeOrigin: false },
    },
    // Both roots, so a worktree serves what the checkout serves. See
    // {@link dependencyRoot} — in the checkout these are one directory and this
    // line does nothing at all.
    fs: { allow: [process.cwd(), dependencyRoot(process.cwd())] },
  },
  plugins: [tailwindcss(), reactRouter()],
});
