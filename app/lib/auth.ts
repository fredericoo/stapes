import { redirect } from "react-router";
import type { Character } from "../../server/characters";
import type { Role } from "../../server/auth";
import type { MaintenanceState } from "../../server/maintenance";

export type Me = {
  user: { id: string; username: string; role: Role } | null;
  characters: Character[];
  maintenance: MaintenanceState | null;
};

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
    return { ok: false, error: "Could not reach the world. Try again." };
  }
  if (!response.ok) return { ok: false, error: await reasonFrom(response) };
  return { ok: true, value: (await response.json().catch(() => null)) as T };
}

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

export async function fetchMe(): Promise<Me> {
  try {
    const response = await fetch("/api/me", { credentials: "same-origin" });
    if (!response.ok) return { user: null, characters: [], maintenance: null };
    return (await response.json()) as Me;
  } catch {
    return { user: null, characters: [], maintenance: null };
  }
}

export function signUp(
  username: string,
  email: string,
  password: string,
): Promise<Attempt<unknown>> {
  return post("/api/account", { username, email, password });
}

export function signIn(username: string, password: string): Promise<Attempt<unknown>> {
  return post("/api/auth/sign-in/username", { username, password });
}

export function signOut(): Promise<Attempt<unknown>> {
  return post("/api/auth/sign-out", {});
}

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

export async function createCharacter(name: string): Promise<Attempt<Character>> {
  const made = await post<{ character: Character }>("/api/characters", {
    name,
  });
  return made.ok ? { ok: true, value: made.value.character } : made;
}

export const ADMIN_SIGN_IN_PATH = "/admin/sign-in";

/**
 * Only a courtesy redirect. These pages are static files anybody can fetch;
 * what actually blocks a write is the server refusing it for a
 * non-administrator session.
 */
export async function requireAdmin(): Promise<Me> {
  const me = await fetchMe();
  if (me.user?.role !== "ADMIN") throw redirect(ADMIN_SIGN_IN_PATH);
  return me;
}
