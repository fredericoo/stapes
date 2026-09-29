import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const SERVER_ORIGIN = process.env.STAPES_SERVER_ORIGIN ?? "http://localhost:3000";

function dependencyRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "node_modules/vite"))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: false },
      "/online/ws": { target: SERVER_ORIGIN, ws: true, changeOrigin: false },
    },
    fs: { allow: [process.cwd(), dependencyRoot(process.cwd())] },
  },
  plugins: [tailwindcss(), reactRouter()],
});
