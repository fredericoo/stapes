import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEEDED_ADMIN_USERNAME, createAuth, seedAdmin, viewerOf, type Auth } from "./auth";
import { resolveAuthSecret } from "./authSecret";
import { Characters } from "./characters";
import { readConfig } from "./config";
import { openDatabase, type Database } from "./db";
import { MAX_CHARACTERS_PER_ACCOUNT } from "../app/lib/characterName";

const SEEDED_ADMIN_PASSWORD = "salem123";

let directory: string;
let db: Database;
let auth: Auth;
let characters: Characters;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stapes-accounts-"));
  db = await openDatabase(join(directory, "stapes.db"));
  auth = createAuth(
    db,
    readConfig({ DATA_DIR: directory } as never),
    await resolveAuthSecret(db, undefined),
  );
  characters = new Characters(db);
});

afterEach(async () => {
  await db.close?.();
  await rm(directory, { recursive: true, force: true });
});

async function makeAccount(username: string): Promise<string> {
  const created = await auth.api.signUpEmail({
    body: {
      email: `${username}@example.test`,
      password: "a-long-enough-password",
      name: username,
      username,
    },
  });
  return created.user.id;
}

async function sessionHeaders(username: string, password: string): Promise<Headers> {
  const response = await auth.api.signInUsername({
    body: { username, password },
    asResponse: true,
  });
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error(`no session cookie for ${username}`);
  return new Headers({ cookie: cookie.split(";")[0]! });
}

describe("the session signing key", () => {
  it("is generated once and read back on every boot after", async () => {
    const first = await resolveAuthSecret(db, undefined);
    expect(first.length).toBeGreaterThanOrEqual(32);

    expect(await resolveAuthSecret(db, undefined)).toBe(first);
  });

  it("lets the environment say instead, and leaves the stored one alone", async () => {
    const generated = await resolveAuthSecret(db, undefined);

    expect(await resolveAuthSecret(db, "a-secret-from-somewhere-else")).toBe(
      "a-secret-from-somewhere-else",
    );

    const stored = await db.prepare("SELECT secret FROM auth_secret WHERE id = 0");
    expect(await stored.get()).toEqual({ secret: generated });
  });
});

describe("the seeded administrator", () => {
  it("can sign in to a fresh world", async () => {
    await seedAdmin(auth, db, () => {});

    const viewer = await viewerOf(
      auth,
      await sessionHeaders(SEEDED_ADMIN_USERNAME, SEEDED_ADMIN_PASSWORD),
    );
    expect(viewer).toEqual({
      id: expect.any(String),
      username: SEEDED_ADMIN_USERNAME,
      role: "ADMIN",
    });
  });

  it("is not written again once its password has been changed", async () => {
    await seedAdmin(auth, db, () => {});
    await auth.api.changePassword({
      body: {
        currentPassword: SEEDED_ADMIN_PASSWORD,
        newPassword: "something-else-entirely",
      },
      headers: await sessionHeaders(SEEDED_ADMIN_USERNAME, SEEDED_ADMIN_PASSWORD),
    });

    await seedAdmin(auth, db, () => {});

    await expect(sessionHeaders(SEEDED_ADMIN_USERNAME, SEEDED_ADMIN_PASSWORD)).rejects.toThrow();
    const viewer = await viewerOf(
      auth,
      await sessionHeaders(SEEDED_ADMIN_USERNAME, "something-else-entirely"),
    );
    expect(viewer?.role).toBe("ADMIN");
  });
});

describe("an account across a restart", () => {
  it("is still there, with its character, when the database is opened again", async () => {
    const userId = await makeAccount("durable");
    const made = await characters.create(userId, "Keeper");
    if ("error" in made) throw new Error(made.error);

    await db.close?.();
    db = await openDatabase(join(directory, "stapes.db"));
    auth = createAuth(
      db,
      readConfig({ DATA_DIR: directory } as never),
      await resolveAuthSecret(db, undefined),
    );
    characters = new Characters(db);

    const viewer = await viewerOf(auth, await sessionHeaders("durable", "a-long-enough-password"));
    expect(viewer?.id).toBe(userId);
    expect((await characters.listFor(userId)).map((character) => character.name)).toEqual([
      "Keeper",
    ]);
  });
});

describe("an ordinary account", () => {
  it("is a USER, and cannot ask to be anything else", async () => {
    await auth.api.signUpEmail({
      body: {
        email: "climber@example.test",
        password: "a-long-enough-password",
        name: "climber",
        username: "climber",
        role: "ADMIN",
      } as never,
    });

    const viewer = await viewerOf(auth, await sessionHeaders("climber", "a-long-enough-password"));
    expect(viewer?.role).toBe("USER");
  });

  it("becomes an administrator when the database says so", async () => {
    await makeAccount("author");
    const promote = await db.prepare("UPDATE user SET role = 'ADMIN' WHERE username = ?");
    await promote.run(["author"]);

    const viewer = await viewerOf(auth, await sessionHeaders("author", "a-long-enough-password"));
    expect(viewer?.role).toBe("ADMIN");
  });
});

describe("characters", () => {
  it("stores the name capitalised, whatever was typed", async () => {
    const account = await makeAccount("player");
    const made = await characters.create(account, "  aRTHur ");
    expect(made).toEqual({
      character: {
        id: expect.any(String),
        name: "Arthur",
        createdAt: expect.any(Number),
      },
    });
  });

  it("refuses a name that is not a name", async () => {
    const account = await makeAccount("player");
    expect(await characters.create(account, "Ka1n")).toEqual({
      error: expect.any(String),
    });
    expect(await characters.listFor(account)).toEqual([]);
  });

  it("refuses a name somebody already has, in any casing", async () => {
    const mine = await makeAccount("mine");
    const theirs = await makeAccount("theirs");
    await characters.create(mine, "Arthur");

    expect(await characters.create(theirs, "ARTHUR")).toEqual({
      error: expect.stringContaining("Arthur"),
    });
    expect(await characters.listFor(theirs)).toEqual([]);
  });

  it(`holds at most ${MAX_CHARACTERS_PER_ACCOUNT}`, async () => {
    const account = await makeAccount("player");
    for (let n = 0; n < MAX_CHARACTERS_PER_ACCOUNT; n++) {
      expect(await characters.create(account, `Namer${"a".repeat(n)}`)).toEqual({
        character: expect.anything(),
      });
    }

    expect(await characters.create(account, "Onetoomany")).toEqual({
      error: expect.any(String),
    });
    expect(await characters.listFor(account)).toHaveLength(MAX_CHARACTERS_PER_ACCOUNT);
  });

  it("is only ever owned by the account that made it", async () => {
    const mine = await makeAccount("mine");
    const theirs = await makeAccount("theirs");
    const made = await characters.create(mine, "Arthur");
    if (!("character" in made)) throw new Error("expected a character");

    expect(await characters.ownedBy(made.character.id, mine)).toEqual(made.character);
    expect(await characters.ownedBy(made.character.id, theirs)).toBeNull();
  });

  it("answers null for an id no account owns", async () => {
    expect(await characters.nameOf("npc:1,2,0,1")).toBeNull();
  });
});
