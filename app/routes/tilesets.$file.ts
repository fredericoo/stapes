import type { Route } from "./+types/tilesets.$file";
import { dataStore } from "../context";

export async function loader({ context, params }: Route.LoaderArgs) {
  const file = params.file;
  if (!file) {
    return new Response("Not found", { status: 404 });
  }
  const bytes = await dataStore(context).readTilesetPng(file);
  if (!bytes) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      // Never cached in dev: tilesets are edited in a tight loop, and a minute
      // of staleness is a minute of wondering whether the change took.
      "Cache-Control": import.meta.env.DEV
        ? "no-store"
        : "public, max-age=60",
    },
  });
}
