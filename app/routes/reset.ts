/**
 * Wipe the running world and start it again from the authored files.
 *
 * **Why this exists as an endpoint at all.** Three things hold state and
 * nothing reconciles them: `data/` in the repo, the R2 bucket in production,
 * and the Durable Object holding the world that is actually being played. The
 * first two are a `pnpm seed` apart. The third is reachable from nowhere — the
 * object prefers its own checkpoint to the bucket, and the editor's save
 * carries every player's kit, tags and masteries across on purpose, so no
 * sequence of seeds, saves and reloads clears what it remembers about
 * somebody. This is the way in, and the only one.
 *
 * See `GameServer.resetWorld` for what it costs: every position, kit, reward
 * and mastery in the world.
 */
import type { Route } from "./+types/reset";
import { cloudflareContext } from "../context";
import { gameServer } from "../net/gameServer.server";

/** Header the caller proves itself with, as `Bearer <secret>`. */
const AUTH_HEADER = "Authorization";
const BEARER = "Bearer ";

/**
 * Compare two secrets without leaking how far they matched.
 *
 * Digested first, then compared byte by byte with no early exit. Comparing the
 * strings directly would leak twice over — `===` stops at the first difference,
 * and the lengths differ before that — where two SHA-256 digests are always the
 * same size and a digest match is a match.
 *
 * The loop rather than `crypto.subtle.timingSafeEqual`, which is a Workers
 * extension that the DOM `SubtleCrypto` in this project's `lib` does not
 * declare: reaching it means casting away the type, and a cast in the one
 * function here that decides whether to destroy the world is a poor trade for
 * six lines.
 */
async function secretMatches(offered: string, expected: string) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(offered)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= left[i]! ^ right[i]!;
  }
  return difference === 0;
}

/**
 * Nothing to look at.
 *
 * Without this a GET is React Router's "you did not provide a `loader`" error,
 * which is a 400 and a stack trace saying the route exists. 404 is both tidier
 * and the same answer an unconfigured deployment gives to a POST — see below
 * for why that matters.
 */
export function loader() {
  return new Response("Not found", { status: 404 });
}

export async function action({ context, request }: Route.ActionArgs) {
  const env = context.get(cloudflareContext).env;

  // No secret configured is not "let anybody in" — it is a deployment that was
  // never meant to have this. 404 rather than 403 for the same reason: an
  // environment with no reset should not advertise that it has one.
  const expected = env.RESET_SECRET;
  if (!expected) return new Response("Not found", { status: 404 });

  const offered = request.headers.get(AUTH_HEADER) ?? "";
  if (
    !offered.startsWith(BEARER) ||
    !(await secretMatches(offered.slice(BEARER.length), expected))
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  // The origin travels for the same reason it does on a map save: the Durable
  // Object has no request of its own, and in dev that is the only way it can
  // find the `data/` middleware — see `GameServer`'s `store`.
  await gameServer(env).resetWorld(new URL(request.url).origin);
  return Response.json({ ok: true });
}
