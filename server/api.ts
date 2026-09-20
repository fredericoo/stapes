import { Elysia, t } from "elysia";
import { parseMap, serializeMap } from "../app/lib/mapData";
import { readPngSize } from "../app/lib/png";
import { untar } from "./untar";
import { PROTOCOL_VERSION } from "../app/net/protocol";
import { viewerOf, type Viewer } from "./auth";
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

  /**
   * Who is asking, or null for a browser with no session.
   *
   * Null rather than a throw, because the three callers below want three
   * different things from that answer: `/me` says so in a 200, `/characters`
   * answers 401, and the authoring routes answer 404.
   */
  const signedIn = (request: Request): Promise<Viewer | null> =>
    viewerOf(world.auth, request.headers);

  /**
   * The guard on everything that authors the world.
   *
   * **This is what `/admin` being behind a login actually means.** The pages
   * under that path are static files in a bundle anybody can fetch — there is
   * no server rendering here, so a route guard in the client is a courtesy to
   * whoever mistyped a URL and nothing more. What stops somebody who is not an
   * administrator from replacing the map is that this refuses to write it.
   *
   * 404 rather than 403, on the terms the bearer-token endpoints below already
   * answer: an installation somebody has no business in should not confirm
   * what it has.
   */
  const admin = async (request: Request): Promise<boolean> =>
    (await signedIn(request))?.role === "ADMIN";

  return (
    new Elysia({ prefix: "/api" })
      // ---- accounts --------------------------------------------------------
      /**
       * Better Auth's own routes, whole.
       *
       * Sign-in, sign-out, the session lookup and the password change are all
       * its endpoints under here, used by the client as they come — see
       * `../app/lib/auth.ts`. Sign-*up* is the one exception and has a handler
       * of its own below; the reason is there.
       *
       * `parse: "none"` because Better Auth reads the body off the `Request`
       * itself: letting Elysia parse it first would hand the handler a stream
       * that has already been consumed.
       */
      .all("/auth/*", ({ request }) => world.auth.handler(request), {
        parse: "none",
      })
      /**
       * Make an account.
       *
       * Its own route rather than Better Auth's `/sign-up/email`, for one
       * reason that is left: Better Auth's `name` is a *display* name, and this
       * game has no use for one — what is drawn over a head is the
       * *character's* name, typed later. Deciding here that it mirrors the
       * username keeps a field out of the form that would only ever confuse
       * somebody about which of the two names people see.
       *
       * The reply is Better Auth's own `Response`, passed through untouched —
       * which is what carries the `Set-Cookie` that signs the new account in.
       * Rebuilding the body here would mean dropping it.
       */
      .post(
        "/account",
        async ({ body, request, status }) => {
          try {
            return await world.auth.api.signUpEmail({
              body: {
                // Typed by the person signing up, and stored. Nothing sends to
                // it and nothing verifies it — see `./auth` — but it is theirs
                // rather than something this server made up.
                email: body.email,
                password: body.password,
                name: body.username,
                username: body.username,
              },
              headers: request.headers,
              asResponse: true,
            });
          } catch (error) {
            // **Caught rather than left to Elysia**, because a refusal that
            // escapes here arrives at the browser as a 200 with a sentence in
            // it. Better Auth throws an `APIError` whose `status` is a name
            // rather than a number — `UNPROCESSABLE_ENTITY` — and Elysia's
            // error path cannot read a code out of that, so "Username is
            // already taken" was reaching the sign-up form as a *success* and
            // leaving somebody looking at a door that had just told them they
            // were through it.
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
      /**
       * Who this browser is, and what it may play.
       *
       * One request rather than two, on the terms `/bootstrap` is one: the
       * page cannot decide what to draw without both, and asking separately
       * would be two sequential waits in front of the sign-in screen.
       *
       * `user: null` rather than a 401 for a signed-out browser. Not being
       * signed in is the ordinary state of somebody arriving at the game, and
       * an error status would put it through the client's failure path.
       */
      .get("/me", async ({ request }) => {
        const viewer = await signedIn(request);
        if (!viewer) return { user: null, characters: [] };
        return {
          user: viewer,
          characters: await world.characters.listFor(viewer.id),
        };
      })
      /**
       * Make a character.
       *
       * Every refusal is a 400 with a sentence in it, because every refusal
       * here is something the person typing is entitled to read — the name is
       * not a name, somebody already has it, or this account is full. @see
       * `./characters`
       */
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

      // ---- authored content, read ----------------------------------------
      .get("/tiles", async () => ({ tiles: await store.readTiles() }))
      .get("/statuses", async () => ({ statuses: await store.readStatuses() }))
      .get("/tilesets", async () => ({ tilesets: await store.readTilesets() }))
      /**
       * The map as text, for the editor and nothing else.
       *
       * Behind the administrator check while its neighbours are not, and the
       * difference is who wants them: the tile, tileset and status catalogues
       * are what every client needs before it can draw a frame, and the map is
       * what the *editor* opens. Everybody playing gets their map over the
       * socket, in the chunks their view reaches. @see `../app/net/interest`
       */
      .get("/map", async ({ request, status }) => {
        if (!(await admin(request))) return status(404, "Not found");
        return { map: serializeMap(await store.readMap()) };
      })
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
        async ({ body, request, status }) => {
          if (!(await admin(request))) return status(404, "Not found");
          await store.writeTiles(body.tiles as never);
          // Written *before* the world is told, on the terms the map save above
          // is: a catalogue that failed to store must not become the one the
          // world reloads against, or a reload would pick up the old files and
          // an author would be told their save worked.
          //
          // And the world *is* told, which it used to not be. Reading the
          // catalogue is guarded on there being no session, so before this an
          // edit changed what the next world would be built from and nothing
          // about the one the author was standing in — see
          // `GameServer.reloadContent`, which is where that argument lives.
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
          // Beside the tiles and for the same reason: the running world compiled
          // its status catalogue at load, so a re-authored burn reached the file
          // and nobody who was already on fire.
          await world.server.reloadContent();
          return { ok: true as const };
        },
        { body: t.Object({ statuses: t.Array(t.Unknown()) }) },
      )
      .post(
        "/map",
        async ({ body, request, status }) => {
          if (!(await admin(request))) return status(404, "Not found");
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
        async ({ params, body, request, status }) => {
          if (!(await admin(request))) return status(404, "Not found");
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
        /**
         * What this server speaks, for the deploy that has to prove the served
         * client agrees with it.
         *
         * **Health is not the question; agreement is.** A client and a server a
         * version apart produce a world that answers `ok` here, serves its
         * page, and then closes every socket with 4001 — which is exactly what
         * two previews shipped green before `.github/workflows/preview.yml`
         * started asking. It used to ask `GET /api/session`, which existed to
         * mint the anonymous actor cookie and went away with it.
         *
         * On the health endpoint rather than a route of its own because this is
         * already the unauthenticated "what is this server" call, and the
         * workflow fetches it two steps later anyway.
         */
        protocolVersion: PROTOCOL_VERSION,
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
       * Overwrite the authored content with this image's `data/` and restart
       * the world on it. The deploy pipeline calls this after every merge to
       * main, so what is live is what is in the repo. Unlike `/reset`, players
       * keep their positions, kit, tags and masteries — only the world around
       * them is replaced.
       */
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
 * The sentence to hand back for a refused sign-up.
 *
 * Better Auth's `APIError` carries the readable half in `body.message`, which
 * is what the form shows — "Username is already taken", "Password too short".
 * Anything that is not one of its errors gets a generic line rather than
 * whatever a stack trace happens to say: the person typing is entitled to the
 * reason, and to nothing about the server.
 */
function refusalFrom(error: unknown): string {
  const body = (error as { body?: { message?: unknown } } | null)?.body;
  if (typeof body?.message === "string" && body.message) return body.message;
  return "That did not work. Try again.";
}

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
