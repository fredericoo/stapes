/**
 * Where the dev server exposes the repo's `data/` directory for read and write.
 *
 * Shared by the Vite middleware that serves it (vite.config.ts, running in Node
 * with filesystem access) and the Worker-side store that consumes it
 * (storage.server.ts, running in workerd with none).
 */
export const DEV_DATA_PREFIX = "/__data";

/**
 * Keys are relative paths under `data/` — `map.json`, `tilesets/walls.png`.
 * No leading slash, no `..`, nothing outside that tree.
 */
export const SAFE_DATA_KEY = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/;

export function isSafeDataKey(key: string): boolean {
  return SAFE_DATA_KEY.test(key) && !key.split("/").includes("..");
}
