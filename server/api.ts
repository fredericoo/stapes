import { Elysia, t } from "elysia";
import { flattenMap, parseMap, serializeMap } from "../app/lib/mapData";
import { readPngSize } from "../app/lib/png";
import { untar } from "./untar";
import { PROTOCOL_VERSION } from "../app/net/protocol";
import { viewerOf, type Viewer } from "./auth";
import type { World } from "./world";
import type { ClientBundle } from "./clientBundle";
import type { Config } from "./config";
import { MAINTENANCE_MESSAGE_MAX_LENGTH } from "./maintenance";

export function createApi(world: World, bundle: ClientBundle, config: Config) {
  const store = world.blobs;

  const signedIn = (request: Request): Promise<Viewer | null> =>
    viewerOf(world.auth, request.headers);

  const admin = async (request: Request): Promise<boolean> =>
    (await signedIn(request))?.role === "ADMIN";

  return new Elysia({ prefix: "/api" })
    .all("/auth/*", ({ request }) => world.auth.handler(request), {
      /** Better Auth reads the body off the `Request` itself, so Elysia must not consume it first. */
      parse: "none",
    })
    .post(
      "/account",
      async ({ body, request, status }) => {
        try {
          return await world.auth.api.signUpEmail({
            body: {
              email: body.email,
              password: body.password,
              name: body.username,
              username: body.username,
            },
            headers: request.headers,
            asResponse: true,
          });
        } catch (error) {
          return status(400, refusalFrom(error));
        }
      },
      {
        body: t.Object({
          username: t.String(),
          email: t.String(),
          password: t.String(),
        }),
      },
    )
    .get("/me", async ({ request }) => {
      const viewer = await signedIn(request);
      const maintenance = world.maintenance.state;
      if (!viewer) return { user: null, characters: [], maintenance };
      return {
        user: viewer,
        characters: await world.characters.listFor(viewer.id),
        maintenance,
      };
    })
    .post(
      "/characters",
      async ({ body, request, status }) => {
        const viewer = await signedIn(request);
        if (!viewer) return status(401, "Sign in first");
        const made = await world.characters.create(viewer.id, body.name);
        if ("error" in made) return status(400, made.error);
        return { character: made.character };
      },
      { body: t.Object({ name: t.String() }) },
    )

    .get("/tiles", async () => ({ tiles: await store.readTiles() }))
    .get("/statuses", async () => ({ statuses: await store.readStatuses() }))
    .get("/tilesets", async () => ({ tilesets: await store.readTilesets() }))
    .get("/map", async ({ request, status }) => {
      if (!(await admin(request))) return status(404, "Not found");
      return { map: serializeMap(await store.readMap()) };
    })
    .get("/bootstrap", async () => ({
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
            "Cache-Control": "public, max-age=60",
          },
        });
      },
      { params: t.Object({ file: t.String() }) },
    )

    .post(
      "/tiles",
      async ({ body, request, status }) => {
        if (!(await admin(request))) return status(404, "Not found");
        await store.writeTiles(body.tiles as never);
        await world.server.reloadContent();
        return { ok: true as const };
      },
      { body: t.Object({ tiles: t.Array(t.Unknown()) }) },
    )
    .post(
      "/tilesets",
      async ({ body, request, status }) => {
        if (!(await admin(request))) return status(404, "Not found");
        await store.writeTilesets(body.tilesets as never);
        return { ok: true as const };
      },
      { body: t.Object({ tilesets: t.Array(t.Unknown()) }) },
    )
    .post(
      "/statuses",
      async ({ body, request, status }) => {
        if (!(await admin(request))) return status(404, "Not found");
        await store.writeStatuses(body.statuses);
        await world.server.reloadContent();
        return { ok: true as const };
      },
      { body: t.Object({ statuses: t.Array(t.Unknown()) }) },
    )
    .post(
      "/map",
      async ({ body, request, status }) => {
        if (!(await admin(request))) return status(404, "Not found");
        await world.server.replaceWorld(flattenMap(parseMap(body.map)));
        return { ok: true as const };
      },
      { body: t.Object({ map: t.String() }) },
    )
    .post(
      "/tilesets/:file",
      async ({ params, body, request, status }) => {
        if (!(await admin(request))) return status(404, "Not found");
        const bytes = new Uint8Array(
          await (body.file as File).arrayBuffer(),
        ) as Uint8Array<ArrayBuffer>;
        try {
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

    .get("/health", async ({ request }) => ({
      status: world.accepting ? ("ok" as const) : ("draining" as const),
      ...((await admin(request)) ? { players: world.playerCount } : {}),
      build: bundle.active,
      protocolVersion: PROTOCOL_VERSION,
      maintenance: world.maintenance.state !== null,
    }))
    .get("/maintenance", () => ({ maintenance: world.maintenance.state }))
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
    .post(
      "/seed",
      async ({ headers, status }) => {
        if (!(await authorized(headers.authorization, config))) {
          return status(404, "Not found");
        }
        await world.reseed();
        return { ok: true as const };
      },
      { detail: { summary: "Replace the authored content with the image's" } },
    )
    .post(
      "/maintenance",
      async ({ headers, body, request, status }) => {
        const allowed = (await authorized(headers.authorization, config)) || (await admin(request));
        if (!allowed) return status(404, "Not found");
        if (!body.on) {
          await world.endMaintenance();
          return { maintenance: null };
        }
        return { maintenance: await world.beginMaintenance(body.message ?? null) };
      },
      {
        body: t.Object({
          on: t.Boolean(),
          message: t.Optional(t.Nullable(t.String({ maxLength: MAINTENANCE_MESSAGE_MAX_LENGTH }))),
        }),
        detail: { summary: "Close the world to everybody but administrators, or reopen it" },
      },
    )
    .post("/backup", async ({ headers, status }) => {
      if (!(await authorized(headers.authorization, config))) {
        return status(404, "Not found");
      }
      const path = await world.snapshot(config.BACKUP_DIR);
      return { ok: true as const, path };
    })
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
    );
}

export type Api = ReturnType<typeof createApi>;

function refusalFrom(error: unknown): string {
  const body = (error as { body?: { message?: unknown } } | null)?.body;
  if (typeof body?.message === "string" && body.message) return body.message;
  return "That did not work. Try again.";
}

async function authorized(header: string | undefined, config: Config): Promise<boolean> {
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
