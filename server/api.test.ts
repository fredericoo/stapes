import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import traitsJson from "../data/traits.json";
import { emptyMap, getStack, replaceStack, serializeMap } from "../app/lib/mapData";
import type { MapFile } from "../app/lib/types";
import { PLAYER_TILE_ID } from "../app/game/constants";
import { emptyEquipment } from "../app/game/equipment";
import { createApi } from "./api";
import type { Blame } from "../app/game/blame";
import type { DeathRecord } from "./deaths";
import { FEEDBACK_PER_WINDOW } from "./feedback";
import { SEEDED_ADMIN_USERNAME } from "./auth";
import { ClientBundle } from "./clientBundle";
import { GameSocket } from "./sockets";
import { readConfig } from "./config";
import { World, type PlayerEntry } from "./world";
import type { CharacterSheet } from "./GameServer";

const SEEDED_ADMIN_PASSWORD = "salem123";

let directory: string;
let world: World;
let api: ReturnType<typeof createApi>;
let cookie: string;

function startableMap(): MapFile {
  let map = emptyMap();
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: PLAYER_TILE_ID }]);
  return replaceStack(map, 1, 0, 0, [{ tileId: "grass" }]);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-api-"));
  const seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  await copyFile("data/tilesets.json", join(seed, "tilesets.json"));
  await copyFile("data/tiles.json", join(seed, "tiles.json"));
  await copyFile("data/statuses.json", join(seed, "statuses.json"));
  await copyFile("data/traits.json", join(seed, "traits.json"));
  await writeFile(join(seed, "map.json"), serializeMap(startableMap()));

  const config = readConfig({ DATA_DIR: join(directory, "data"), SEED_DIR: seed } as never);
  world = await World.open(config);
  api = createApi(world, new ClientBundle(config), config);

  const signedIn = await world.auth.api.signInUsername({
    body: { username: SEEDED_ADMIN_USERNAME, password: SEEDED_ADMIN_PASSWORD },
    asResponse: true,
  });
  cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
});

afterEach(async () => {
  await world.drain();
  await rm(directory, { recursive: true, force: true });
});

function saveMap(map: MapFile): Promise<Response> {
  return api.handle(
    new Request("http://localhost/api/map", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ map: serializeMap(map) }),
    }),
  );
}

async function storedMap(): Promise<string> {
  return serializeMap(await world.blobs.readMap());
}

describe("saving the map", () => {
  it("refuses a map that cannot start a world, and leaves the stored map as it was", async () => {
    const before = await storedMap();
    const markerless = replaceStack(emptyMap(), 0, 0, 0, [{ tileId: "grass" }]);

    const response = await saveMap(markerless);

    expect(response.ok).toBe(false);
    expect(await storedMap()).toBe(before);
  });

  it("removes a placement that does not fit before writing, and names it in the response", async () => {
    let map = replaceStack(startableMap(), 1, 0, 0, [
      { tileId: "grass" },
      { tileId: "barrel" },
      { tileId: "barrel" },
    ]);
    map = replaceStack(map, 1, 0, 1, [{ tileId: "grass" }]);

    const response = await saveMap(map);

    expect(await response.json()).toMatchObject({
      ok: true,
      removed: [{ x: 1, y: 0, z: 0, tileId: "barrel" }],
    });
    expect(getStack(await world.blobs.readMap(), 1, 0, 0)).toEqual([
      { tileId: "grass" },
      { tileId: "barrel" },
    ]);
  });
});

function call(path: string, body: unknown, from?: string): Promise<Response> {
  return api.handle(
    new Request(`http://localhost/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(from ? { cookie: from } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

function sessionOf(response: Response): string {
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function me(from: string) {
  const response = await api.handle(
    new Request("http://localhost/api/me", { headers: { cookie: from } }),
  );
  return (await response.json()) as {
    user: { id: string; username: string; guest: boolean } | null;
    characters: { id: string; name: string }[];
  };
}

async function startGuest(name: string): Promise<string> {
  const response = await call("/guest", { name });
  expect(response.status).toBe(200);
  return sessionOf(response);
}

describe("playing as a guest", () => {
  it("signs the browser in to a guest holding one character of the name it typed", async () => {
    const guest = await startGuest("maren  ormstead");

    const seen = await me(guest);
    expect(seen.user?.guest).toBe(true);
    expect(seen.characters.map((one) => one.name)).toEqual(["Maren Ormstead"]);
  });

  it("refuses a name somebody has, in any casing, and signs nobody in", async () => {
    await startGuest("Maren Ormstead");

    const response = await call("/guest", { name: "MAREN ormstead" });

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("cannot be started without a character", async () => {
    const response = await call("/auth/sign-in/anonymous", {});
    expect(response.status).toBe(404);
  });

  it("cannot make a second character", async () => {
    const guest = await startGuest("Maren Ormstead");

    const response = await call("/characters", { name: "Other" }, guest);

    expect(response.status).toBe(403);
    expect((await me(guest)).characters).toHaveLength(1);
  });

  it("keeps its character when the same browser signs in to another account", async () => {
    const guest = await startGuest("Maren Ormstead");

    const response = await call(
      "/auth/sign-in/username",
      { username: SEEDED_ADMIN_USERNAME, password: SEEDED_ADMIN_PASSWORD },
      guest,
    );

    expect(response.status).toBe(200);
    expect(await world.characters.nameTaken("Maren Ormstead")).toBe(true);
  });
});

describe("saving a guest to an account", () => {
  const claim = { username: "maren", email: "maren@example.test", password: "long-enough-pw" };

  it("keeps the same account and character, and signs in with what was chosen", async () => {
    const guest = await startGuest("Maren Ormstead");
    const before = await me(guest);

    expect((await call("/account/claim", claim, guest)).status).toBe(200);

    const after = await me(guest);
    expect(after.user).toMatchObject({ id: before.user!.id, username: "maren", guest: false });
    expect(after.characters).toEqual(before.characters);

    const signedIn = await call("/auth/sign-in/username", {
      username: claim.username,
      password: claim.password,
    });
    expect(signedIn.status).toBe(200);
    expect((await me(sessionOf(signedIn))).characters).toEqual(before.characters);
  });

  it("refuses a username somebody has, and stays a guest", async () => {
    const guest = await startGuest("Maren Ormstead");

    const response = await call(
      "/account/claim",
      { ...claim, username: SEEDED_ADMIN_USERNAME },
      guest,
    );

    expect(response.status).toBe(400);
    expect((await me(guest)).user?.guest).toBe(true);
  });

  it("refuses an account that is already saved", async () => {
    const response = await call("/account/claim", claim, cookie);
    expect(response.status).toBe(400);
  });
});

async function feedbackList(from: string): Promise<Response> {
  return api.handle(new Request("http://localhost/api/feedback", { headers: { cookie: from } }));
}

describe("feedback", () => {
  it("reaches an administrator with who sent it, from which character, and what their browser said", async () => {
    const guest = await startGuest("Maren Ormstead");
    const [character] = (await me(guest)).characters;

    const sent = await call(
      "/feedback",
      {
        message: "  I got stuck behind the well  ",
        characterId: character!.id,
        context: { position: { x: 3, y: 4, z: 0 }, viewport: "390x844" },
      },
      guest,
    );
    expect(sent.status).toBe(200);

    const { entries } = (await (await feedbackList(cookie)).json()) as {
      entries: Record<string, unknown>[];
    };
    expect(entries).toEqual([
      expect.objectContaining({
        message: "I got stuck behind the well",
        guest: true,
        username: null,
        characterName: "Maren Ormstead",
        context: expect.objectContaining({
          position: { x: 3, y: 4, z: 0 },
          viewport: "390x844",
        }),
      }),
    ]);
  });

  it("names no character that is not the sender's own", async () => {
    const theirs = await startGuest("Maren Ormstead");
    const [character] = (await me(theirs)).characters;
    const mine = await startGuest("Garan Normore");

    await call("/feedback", { message: "hello", characterId: character!.id }, mine);

    const { entries } = (await (await feedbackList(cookie)).json()) as {
      entries: { characterName: string | null }[];
    };
    expect(entries[0]!.characterName).toBeNull();
  });

  it("is listed for administrators only", async () => {
    const guest = await startGuest("Maren Ormstead");
    expect((await feedbackList(guest)).status).toBe(404);
  });

  it("refuses a browser that is not signed in, and a message with nothing in it", async () => {
    expect((await call("/feedback", { message: "hello" })).status).toBe(401);
    expect((await call("/feedback", { message: "   " }, cookie)).status).toBe(400);
  });

  it("stops one account sending more than a few in a minute", async () => {
    const statuses: number[] = [];
    for (let sent = 0; sent <= FEEDBACK_PER_WINDOW; sent++) {
      statuses.push((await call("/feedback", { message: `note ${sent}` }, cookie)).status);
    }
    expect(statuses).toEqual([...Array<number>(FEEDBACK_PER_WINDOW).fill(200), 429]);
  });
});

async function players(from: string): Promise<PlayerEntry[]> {
  const response = await api.handle(
    new Request("http://localhost/api/players", { headers: { cookie: from } }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { players: PlayerEntry[] }).players;
}

function openSocket(): GameSocket {
  let closed = false;
  return new GameSocket({
    send: () => {},
    close: () => {
      closed = true;
    },
    get closed() {
      return closed;
    },
  });
}

describe("players", () => {
  it("lists each character with its account, whether it is online, and when it was last seen", async () => {
    const guest = await startGuest("Maren Ormstead");
    const [character] = (await me(guest)).characters;
    const maren = async () =>
      (await players(cookie)).find((entry) => entry.character?.id === character!.id)!;

    expect(await maren()).toMatchObject({
      guest: true,
      online: false,
      character: { name: "Maren Ormstead", lastSeenAt: null },
    });

    const socket = openSocket();
    const joinedAfter = Date.now();
    await world.join(socket, character!.id, { admin: false });
    const playing = await maren();
    expect(playing.online).toBe(true);
    expect(playing.rating).toBeGreaterThanOrEqual(1);
    expect(playing.character!.lastSeenAt).toBeGreaterThanOrEqual(joinedAfter);

    const leftAfter = Date.now();
    await world.leave(socket);
    const left = await maren();
    expect(left.online).toBe(false);
    expect(left.character!.lastSeenAt).toBeGreaterThanOrEqual(leftAfter);
  });

  it("shows one character's saved state, and its live state while it is in the world", async () => {
    const guest = await startGuest("Maren Ormstead");
    const [character] = (await me(guest)).characters;
    const sheet = async () => {
      const response = await api.handle(
        new Request(`http://localhost/api/players/${character!.id}`, { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { player: PlayerEntry; sheet: CharacterSheet };
    };

    const unplayed = await sheet();
    expect(unplayed.player.character!.name).toBe("Maren Ormstead");
    expect(unplayed.sheet).toMatchObject({ live: false, position: null, masteryXp: {} });

    const socket = openSocket();
    await world.join(socket, character!.id, { admin: false });
    const playing = await sheet();
    expect(playing.player.online).toBe(true);
    expect(playing.sheet.live).toBe(true);
    expect(playing.sheet.position).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(playing.sheet.spawn).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(playing.sheet.equipment).not.toBeNull();

    await world.leave(socket);
    await world.store.flush();
    const left = await sheet();
    expect(left.sheet.live).toBe(false);
    expect(left.sheet.position).toEqual(playing.sheet.position);
  });

  it("shows what is inside a saved bag", async () => {
    const guest = await startGuest("Maren Ormstead");
    const [character] = (await me(guest)).characters;
    const bag = {
      id: "itm_bag",
      tileId: "basic-bag",
      contents: [
        { id: "itm_sword", tileId: "rusty-sword" },
        { id: "itm_apples", tileId: "apple", count: 5 },
      ],
    };
    await world.store.put(`equip:${character!.id}`, {
      equipment: { ...emptyEquipment(), bag },
      savedAt: Date.now(),
    });

    const response = await api.handle(
      new Request(`http://localhost/api/players/${character!.id}`, { headers: { cookie } }),
    );
    const { sheet } = (await response.json()) as { sheet: CharacterSheet };
    expect(sheet.equipment?.bag?.contents).toEqual(bag.contents);
  });

  it("answers 404 for a character that does not exist, and to anyone but an administrator", async () => {
    const guest = await startGuest("Maren Ormstead");
    const [character] = (await me(guest)).characters;
    const status = async (id: string, from: string) =>
      (
        await api.handle(
          new Request(`http://localhost/api/players/${id}`, { headers: { cookie: from } }),
        )
      ).status;
    expect(await status("no-such-character", cookie)).toBe(404);
    expect(await status(character!.id, guest)).toBe(404);
  });

  it("lists an account that has no character yet", async () => {
    expect(await players(cookie)).toContainEqual(
      expect.objectContaining({ username: SEEDED_ADMIN_USERNAME, admin: true, character: null }),
    );
  });

  it("is listed for administrators only", async () => {
    const guest = await startGuest("Maren Ormstead");
    const response = await api.handle(
      new Request("http://localhost/api/players", { headers: { cookie: guest } }),
    );
    expect(response.status).toBe(404);
  });
});

async function killInWorld(characterId: string, blame: Blame) {
  const internals = world.server as unknown as {
    session: {
      actors: Map<string, unknown>;
      applyDamage(actor: unknown, amount: number, blame?: Blame): void;
    };
    tick(): void;
  };
  internals.session.applyDamage(internals.session.actors.get(characterId), 10_000, blame);
  internals.tick();
  await world.store.flush();
}

async function playing(name: string): Promise<string> {
  const guest = await startGuest(name);
  const [character] = (await me(guest)).characters;
  await world.join(openSocket(), character!.id, { admin: false });
  return character!.id;
}

type PlayerPage = {
  player: PlayerEntry;
  deaths: DeathRecord[];
  kills: DeathRecord[];
};

async function page(characterId: string): Promise<PlayerPage> {
  const response = await api.handle(
    new Request(`http://localhost/api/players/${characterId}`, { headers: { cookie } }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as PlayerPage;
}

describe("a player's deaths and kills", () => {
  it("lists a death on the victim's page and the kill on the killer's, and counts both", async () => {
    const maren = await playing("Maren Ormstead");
    const tobin = await playing("Tobin Reed");

    await killInWorld(tobin, { source: "Rusty sword", by: "Maren Ormstead", byId: maren });

    const listed = await players(cookie);
    expect(listed.find((entry) => entry.character?.id === tobin)).toMatchObject({
      deaths: 1,
      kills: 0,
    });
    expect(listed.find((entry) => entry.character?.id === maren)).toMatchObject({
      deaths: 0,
      kills: 1,
    });

    const tobinPage = await page(tobin);
    expect(tobinPage.player).toMatchObject({
      character: { name: "Tobin Reed" },
      deaths: 1,
      kills: 0,
    });
    expect(tobinPage.deaths).toEqual([
      expect.objectContaining({
        cause: { source: "Rusty sword", by: "Maren Ormstead" },
        killer: { id: maren, character: true },
      }),
    ]);
    expect((await page(maren)).kills).toEqual([
      expect.objectContaining({
        victim: { id: tobin, name: "Tobin Reed", character: true },
      }),
    ]);
  });
});

describe("the trait catalogue", () => {
  function saveTraits(traits: unknown[], headers: Record<string, string>): Promise<Response> {
    return api.handle(
      new Request("http://localhost/api/traits", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ traits }),
      }),
    );
  }

  it("keeps what an administrator saves", async () => {
    const saved = [{ id: "howls", name: "Howls" }];

    const response = await saveTraits(saved, { cookie });

    expect(response.ok).toBe(true);
    expect(await world.blobs.readTraits()).toEqual(saved);
  });

  it("refuses anybody else and leaves the catalogue as it was", async () => {
    const response = await saveTraits([{ id: "howls", name: "Howls" }], {});

    expect(response.status).toBe(404);
    expect(await world.blobs.readTraits()).toEqual(traitsJson);
  });
});
