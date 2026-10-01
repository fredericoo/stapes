import type { StatusDef } from "../app/lib/status";
import { statusesById } from "../app/lib/status";
import { normalizeTileDef, type TileDef } from "../app/lib/types";
import {
  CHARACTER_PARAM,
  GAME_SOCKET_PATH,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
} from "../app/net/protocol";

export type BotAccount = {
  readonly username: string;
  readonly password: string;
  readonly character: string;
};

export type Seat = {
  readonly cookie: string;
  readonly characterId: string;
  readonly socketUrl: string;
  readonly tiles: TileDef[];
  readonly statusDefs: Record<string, StatusDef>;
};

/**
 * Better Auth checks `Origin` on its own routes against the server's public
 * origin, which for a script is nothing unless it says so.
 */
function request(origin: string, cookie: string | null, body?: unknown): RequestInit {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function cookieFrom(response: Response): string | null {
  const pairs = response.headers.getSetCookie().map((line) => line.split(";")[0]!);
  return pairs.length ? pairs.join("; ") : null;
}

async function signIn(base: string, origin: string, account: BotAccount): Promise<string> {
  const credentials = { username: account.username, password: account.password };
  const signedIn = await fetch(
    `${base}/api/auth/sign-in/username`,
    request(origin, null, credentials),
  );
  if (signedIn.ok) return cookieFrom(signedIn) ?? fail("signing in set no cookie");

  const signedUp = await fetch(
    `${base}/api/account`,
    request(origin, null, { ...credentials, email: `${account.username}@bots.invalid` }),
  );
  if (!signedUp.ok) {
    fail(`could not sign in or sign up as ${account.username}: ${await signedUp.text()}`);
  }
  return cookieFrom(signedUp) ?? fail("signing up set no cookie");
}

async function characterOf(
  base: string,
  origin: string,
  cookie: string,
  name: string,
): Promise<string> {
  const me = (await (await fetch(`${base}/api/me`, request(origin, cookie))).json()) as {
    characters: Array<{ id: string; name: string }>;
  };
  const existing = me.characters.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;

  const made = await fetch(`${base}/api/characters`, request(origin, cookie, { name }));
  if (!made.ok) fail(`could not create ${name}: ${await made.text()}`);
  return ((await made.json()) as { character: { id: string } }).character.id;
}

/**
 * Signs in to the bot's account, creating it and its character the first
 * time, and fetches the catalogue a client needs to read the world. `base` is
 * where the requests go and `origin` is what they claim to come from, which
 * differ for a bot beside the server: it reaches it on localhost, and a
 * deployed server accepts sign-ins only from its public origin.
 */
export async function takeSeat(base: string, origin: string, account: BotAccount): Promise<Seat> {
  const cookie = await signIn(base, origin, account);
  const characterId = await characterOf(base, origin, cookie, account.character);
  const bootstrap = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
    tiles: TileDef[];
    statuses: unknown[];
  };

  const socketUrl = new URL(GAME_SOCKET_PATH, base);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));
  socketUrl.searchParams.set(CHARACTER_PARAM, characterId);

  return {
    cookie,
    characterId,
    socketUrl: socketUrl.toString(),
    tiles: bootstrap.tiles.map(normalizeTileDef),
    statusDefs: statusesById(bootstrap.statuses),
  };
}

function fail(message: string): never {
  throw new Error(message);
}
