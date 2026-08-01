import type { Route } from "./+types/tilesets.$file";
import { readTilesetPng } from "../lib/fs.server";

export async function loader({ params }: Route.LoaderArgs) {
  const file = params.file;
  if (!file) {
    return new Response("Not found", { status: 404 });
  }
  const buf = await readTilesetPng(file);
  if (!buf) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=60",
    },
  });
}
