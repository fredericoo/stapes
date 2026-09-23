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

/**
 * Accounts, characters and who may author the world.
 *
 * Under `bun test` rather than `vitest` and against a real database file, on
 * exactly the terms `GameServer.test.ts` is: Better Auth reaches its tables
 * through a Kysely dialect written for Turso's driver — see `./authDialect` —
 * and a test against a stubbed adapter would prove nothing about the one thing
 * here that could actually be wrong.
 *
 * The seeded password is written out rather than imported. A test that imported
 * the constant would still pass if somebody changed the seed and forgot the
 * deployment already running on the old one.
 */

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

/** Make an account and hand back its id. */
async function makeAccount(username: string): Promise<string> {
  const created = await auth.api.signUpEmail({
    body: {
      // Typed by the person signing up in the real thing — see
      // `POST /api/account`. Nothing here reads it back.
      email: `${username}@example.test`,
      password: "a-long-enough-password",
      name: username,
      username,
    },
  });
  return created.user.id;
}

/** The headers a signed-in browser would send. */
async function sessionHeaders(username: string, password: string): Promise<Headers> {
  const response = await auth.api.signInUsername({
    body: { username, password },
    asResponse: true,
  });
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error(`no session cookie for ${username}`);
  return new Headers({ cookie: cookie.split(";")[0]! });
}

/**
 * The signing key, which a deployment is not required to supply.
 *
 * It used to be a hard requirement and a refusal to start, which is what a
 * preview deployment with an untouched environment meets — a crash loop, no
 * certificate, and a health check timing out with nothing in the log about a
 * missing variable. @see `./authSecret`
 */
describe("the session signing key", () => {
  it("is generated once and read back on every boot after", async () => {
    const first = await resolveAuthSecret(db, undefined);
    expect(first.length).toBeGreaterThanOrEqual(32);

    // A second boot against the same database. Anything else would sign every
    // existing session out on every restart.
    expect(await resolveAuthSecret(db, undefined)).toBe(first);
  });

  /**
   * An operator who would rather the secret lived somewhere other than the
   * volume sets `AUTH_SECRET`, and the stored row is then never consulted —
   * nor overwritten, so unsetting the variable again comes back to whatever
   * this deployment generated rather than signing everybody out twice.
   */
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

  /**
   * The whole reason it is safe to leave the seed in: an operator changes the
   * password on the first deploy, and every boot after that leaves it alone.
   * A seed that wrote unconditionally would put the published password back
   * every time the container restarted.
   */
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

/**
 * What an account is written through, and whether it is still there after a
 * restart.
 *
 * Every other test here asks the connection that did the writing, which
 * cannot see this failure: on Turso 0.7 the introspection query Kysely ships
 * made every autocommit write after it vanish at the next open, while staying
 * visible to the process that made it. @see `./authDialect`'s
 * `TursoIntrospector`
 */
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
    // `role` is declared `input: false`, so this is dropped before it reaches
    // the adapter rather than refused — which is what makes "roles are assigned
    // in the database" true rather than a convention.
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

  /**
   * Settled by the unique index rather than by a lookup: checking first and
   * inserting after leaves a window two signups can both pass through, and the
   * window is widest exactly when it matters.
   */
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

  /**
   * The whole of "two accounts cannot share a character": the socket asks this
   * question with the id the client named and the account the cookie proved,
   * and a character belonging to anybody else is simply not found.
   * @see `server/index.ts`
   */
  it("is only ever owned by the account that made it", async () => {
    const mine = await makeAccount("mine");
    const theirs = await makeAccount("theirs");
    const made = await characters.create(mine, "Arthur");
    if (!("character" in made)) throw new Error("expected a character");

    expect(await characters.ownedBy(made.character.id, mine)).toEqual(made.character);
    expect(await characters.ownedBy(made.character.id, theirs)).toBeNull();
  });

  /**
   * What the world asks about every body it seats, most of which are deer.
   * @see `GameServer.seatActor`
   */
  it("answers null for an id no account owns", async () => {
    expect(await characters.nameOf("npc:1,2,0,1")).toBeNull();
  });
});
