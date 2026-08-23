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
const SERVER_ORIGIN = process.env.STAPES_SERVER_ORIGIN ?? "http://localhost:3000";

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
  },
  plugins: [tailwindcss(), reactRouter()],
});
