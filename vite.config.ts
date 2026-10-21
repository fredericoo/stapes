import { execFileSync } from "node:child_process";
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

/**
 * `changeset git-tag` tags the commit that released each version, so that commit's date is the
 * day it shipped. A checkout without the tags gets no dates, and the changelog shows versions only.
 */
function releaseDates(): Record<string, string> {
  try {
    const tags = execFileSync(
      "git",
      ["for-each-ref", "refs/tags/v*", "--format=%(refname:short) %(creatordate:short)"],
      { encoding: "utf8" },
    );
    return Object.fromEntries(
      tags
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [tag, date] = line.split(" ");
          return [tag.slice("v".length), date];
        }),
    );
  } catch {
    return {};
  }
}

export default defineConfig({
  define: {
    "import.meta.env.RELEASE_DATES": JSON.stringify(JSON.stringify(releaseDates())),
  },
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
