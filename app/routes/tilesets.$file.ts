import type { Route } from "./+types/tilesets.$file";
import { dataStore } from "../lib/storage.server";

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
      "Cache-Control": "public, max-age=60",
    },
  });
}
