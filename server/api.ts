import { Elysia, t } from "elysia";
import { parseMap, serializeMap } from "../app/lib/mapData";
import { readPngSize } from "../app/lib/png";
import { untar } from "./untar";
import type { World } from "./world";
import type { ClientBundle } from "./clientBundle";
import type { Config } from "./config";

/**
 * Everything the pages used to get from a loader.
 *
 * The client is a static bundle now, so the eight things `DataStore` exposed
 * have become eight endpoints. That translation is mechanical rather than a
 * redesign, and deliberately so: every route in the app already went through
 * `dataStore(context)` and nothing else, which is the only reason splitting the
 * client off is a day's work instead of a rewrite.
 *
 * Typed end-to-end through Eden Treaty — the client imports `typeof api` and
 * gets the return types of these handlers with no codegen and no duplicated
 * schema. That is what pays back the typed loader data that `ssr: false` costs.
 */
export function createApi(world: World, bundle: ClientBundle, config: Config) {
  const store = world.blobs;

  return (
    new Elysia({ prefix: "/api" })
      // ---- authored content, read ----------------------------------------
      .get("/tiles", async () => ({ tiles: await store.readTiles() }))
      .get("/statuses", async () => ({ statuses: await store.readStatuses() }))
      .get("/tilesets", async () => ({ tilesets: await store.readTilesets() }))
      .get("/map", async () => ({ map: serializeMap(await store.readMap()) }))
      .get("/bootstrap", async () => ({
        // The three things every page needs before it can draw anything, in one
        // round trip. Three separate `clientLoader` fetches would be three
        // sequential waits on a cold load, and they are always wanted together.
        tiles: await store.readTiles(),
        tilesets: await store.readTilesets(),
        statuses: await store.readStatuses(),
      }))
      .get(
        "/tilesets/:file",
        async ({ params, status }) => {
          const bytes = await store.readTilesetPng(params.file);
          if (!bytes) return status(404, "Not found");
          return new Response(bytes as unknown as BodyInit, {
            headers: {
              "Content-Type": "image/png",
              // Authored art changes under a fixed name, so it cannot be
              // immutable — but it changes rarely, and the editor reloads it
              // itself after a save.
              "Cache-Control": "public, max-age=60",
            },
          });
        },
        { params: t.Object({ file: t.String() }) },
      )

      // ---- authored content, write ---------------------------------------
      .post(
        "/tiles",
        async ({ body }) => {
          await store.writeTiles(body.tiles as never);
          return { ok: true as const };
        },
        { body: t.Object({ tiles: t.Array(t.Unknown()) }) },
      )
      .post(
        "/tilesets",
        async ({ body }) => {
          await store.writeTilesets(body.tilesets as never);
          return { ok: true as const };
        },
        { body: t.Object({ tilesets: t.Array(t.Unknown()) }) },
      )
      .post(
        "/statuses",
        async ({ body }) => {
          await store.writeStatuses(body.statuses);
          return { ok: true as const };
        },
        { body: t.Object({ statuses: t.Array(t.Unknown()) }) },
      )
      .post(
        "/map",
        async ({ body }) => {
          // Parsed before it is written, and written before the world is told:
          // a save that cannot be parsed must not become the map, and a world
          // restarted onto a map that failed to store would be a world nobody
          // can get back. `serializeMap` round-trips byte for byte, so saving an
          // unmodified map still leaves `git status` clean in development.
          const map = parseMap(body.map);
          await store.writeMap(map);
          await world.server.replaceWorld(
            JSON.parse(body.map) as Parameters<typeof world.server.replaceWorld>[0],
          );
          return { ok: true as const };
        },
        { body: t.Object({ map: t.String() }) },
      )
      .post(
        "/tilesets/:file",
        async ({ params, body, status }) => {
          const bytes = new Uint8Array(
            await (body.file as File).arrayBuffer(),
          ) as Uint8Array<ArrayBuffer>;
          try {
            // Rejected here rather than on first draw: a file that is not a PNG
            // becomes a tileset that renders as nothing, with no error anywhere
            // near the upload that caused it.
            readPngSize(bytes);
          } catch {
            return status(400, "Not a PNG");
          }
          await store.writeTilesetPng(params.file, bytes);
          return { ok: true as const };
        },
        {
          params: t.Object({ file: t.String() }),
          body: t.Object({ file: t.File() }),
        },
      )

      // ---- operations ------------------------------------------------------
      .get("/health", () => ({
        // 503 while draining is what takes this container out of rotation
        // before its sockets are closed — see `World.drain`.
        status: world.accepting ? ("ok" as const) : ("draining" as const),
        players: world.playerCount,
        build: bundle.active,
      }))
      .guard({ headers: t.Object({ authorization: t.Optional(t.String()) }) })
      .post(
        "/reset",
        async ({ headers, status }) => {
          if (!(await authorized(headers.authorization, config))) {
            return status(404, "Not found");
          }
          await world.server.resetWorld();
          return { ok: true as const };
        },
        { detail: { summary: "Destroy every position, kit, reward and mastery" } },
      )
      /**
       * Take a built client from continuous integration.
       *
       * A tar archive rather than a file per request: a build is a few hundred
       * files, and a request each would be a deploy that can half-finish. This
       * either stores the whole thing or throws, and the build does not become
       * the live page until it is activated separately.
       */
      .post(
        "/backup",
        async ({ headers, status }) => {
          if (!(await authorized(headers.authorization, config))) {
            return status(404, "Not found");
          }
          // Taken from inside this process because nothing outside it can open
          // the database — see `World.snapshot`.
          const path = await world.snapshot(config.BACKUP_DIR);
          return { ok: true as const, path };
        },
      )
      .post(
        "/client/upload",
        async ({ headers, body, status }) => {
          if (!(await authorized(headers.authorization, config))) {
            return status(404, "Not found");
          }
          const archive = new Uint8Array(await (body.archive as File).arrayBuffer());
          const files = untar(archive);
          if (files.size === 0) return status(400, "Empty archive");
          await bundle.store(body.buildId, files);
          return { ok: true as const, files: files.size };
        },
        {
          body: t.Object({ buildId: t.String(), archive: t.File() }),
        },
      )
      .post(
        "/client/activate",
        async ({ headers, body, status }) => {
          if (!(await authorized(headers.authorization, config))) {
            return status(404, "Not found");
          }
          await bundle.activate(body.buildId);
          return { ok: true as const, active: bundle.active };
        },
        { body: t.Object({ buildId: t.String() }) },
      )
  );
}

export type Api = ReturnType<typeof createApi>;

/**
 * Check the bearer token without leaking how far it matched.
 *
 * Digested first, then compared byte by byte with no early exit. Comparing the
 * strings directly leaks twice over — `===` stops at the first difference, and
 * the lengths differ before that — where two SHA-256 digests are always the
 * same size and a digest match is a match.
 *
 * No secret configured is not "let anybody in", it is a deployment that was
 * never meant to have these endpoints. The callers answer 404 rather than 403
 * for the same reason: an environment with no reset should not advertise one.
 */
async function authorized(
  header: string | undefined,
  config: Config,
): Promise<boolean> {
  const expected = config.ADMIN_SECRET;
  if (!expected) return false;
  if (!header?.startsWith("Bearer ")) return false;

  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}
