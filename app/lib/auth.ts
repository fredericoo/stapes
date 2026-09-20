import { redirect } from "react-router";
import type { Character } from "../../server/characters";
import type { Role } from "../../server/auth";

/**
 * The account, from the browser's side.
 *
 * Plain `fetch` against Better Auth's own routes rather than its client
 * package, and the reason is the same one `./api.ts` gives for hand-rolling
 * over Eden: everything here is same-origin, so the session cookie rides along
 * without ceremony, and what the client package would add — a store, a
 * framework binding, a second copy of the endpoint list — is weight in a bundle
 * that already draws a 3D world.
 *
 * Six calls, and every one of them either succeeds or returns a sentence
 * somebody can read. There is no thrown-error path: every failure here is
 * something a person typed, and a form that shows "Request failed" instead of
 * "that name is taken" has thrown away the only useful part of the answer.
 */

/** Who is signed in, and what they may play. */
export type Me = {
  user: { id: string; username: string; role: Role } | null;
  characters: Character[];
};

/**
 * What a call that could be refused answers with.
 *
 * A discriminated union rather than a nullable error, so a caller that forgets
 * to check does not silently read `undefined` out of a refusal.
 */
export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

async function post<T>(path: string, body: unknown): Promise<Attempt<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // The one failure here that is not about what somebody typed.
    return { ok: false, error: "Could not reach the world. Try again." };
  }
  if (!response.ok) return { ok: false, error: await reasonFrom(response) };
  return { ok: true, value: (await response.json().catch(() => null)) as T };
}

/**
 * The sentence to show for a refusal.
 *
 * Better Auth answers with `{ message, code }` and our own handlers answer with
 * a bare sentence, so both shapes are read here rather than at four call sites.
 * A body that is neither gets a generic line — better than showing somebody the
 * raw JSON of a server they did not know existed.
 */
async function reasonFrom(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { message?: string };
    if (typeof parsed.message === "string" && parsed.message) {
      return parsed.message;
    }
  } catch {
    if (text.trim()) return text.trim();
  }
  return "That did not work. Try again.";
}

/**
 * Who this browser is.
 *
 * Never a refusal: not being signed in is the ordinary state of somebody who
 * has just arrived, so the server answers `user: null` with a 200 and this
 * hands it straight back. A network failure is reported as signed out for the
 * same reason the sign-in screen is the safe default — there is nothing to show
 * somebody whose server is unreachable except the door.
 */
export async function fetchMe(): Promise<Me> {
  try {
    const response = await fetch("/api/me", { credentials: "same-origin" });
    if (!response.ok) return { user: null, characters: [] };
    return (await response.json()) as Me;
  } catch {
    return { user: null, characters: [] };
  }
}

export function signUp(
  username: string,
  password: string,
): Promise<Attempt<unknown>> {
  return post("/api/account", { username, password });
}

export function signIn(
  username: string,
  password: string,
): Promise<Attempt<unknown>> {
  return post("/api/auth/sign-in/username", { username, password });
}

export function signOut(): Promise<Attempt<unknown>> {
  return post("/api/auth/sign-out", {});
}

/**
 * Change the password, and keep this browser signed in.
 *
 * `revokeOtherSessions` because there is no recovery in this game: a password
 * is changed either because somebody chose a better one or because they think
 * it got out, and the second case is the one worth designing for.
 */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<Attempt<unknown>> {
  return post("/api/auth/change-password", {
    currentPassword,
    newPassword,
    revokeOtherSessions: true,
  });
}

export async function createCharacter(
  name: string,
): Promise<Attempt<Character>> {
  const made = await post<{ character: Character }>("/api/characters", {
    name,
  });
  return made.ok ? { ok: true, value: made.value.character } : made;
}

/**
 * Where somebody who is not an administrator is sent.
 *
 * Under `/admin` rather than at the game's door, because it is a different
 * door: the game asks which character, and this asks for the one account that
 * can author the world.
 */
export const ADMIN_SIGN_IN_PATH = "/admin/sign-in";

/**
 * Refuse this page to anybody who is not an administrator.
 *
 * Called at the top of every `clientLoader` under `/admin`, and it is the
 * courtesy rather than the control: these pages are static files in a bundle
 * anybody can fetch, so what actually stops somebody replacing the map is the
 * server refusing to write it — see `server/api.ts`. What this buys is that
 * somebody who is signed out gets a sign-in form instead of a page whose every
 * request 404s.
 *
 * A throw rather than a return, because that is how a `clientLoader` redirects
 * and because it means a caller cannot forget to act on the answer.
 */
export async function requireAdmin(): Promise<Me> {
  const me = await fetchMe();
  if (me.user?.role !== "ADMIN") throw redirect(ADMIN_SIGN_IN_PATH);
  return me;
}
