import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins/username";
import { MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH, MIN_USERNAME_LENGTH } from "../app/lib/account";
import { TursoDialect } from "./authDialect";
import type { Config } from "./config";
import type { Database } from "./db";

/** The two roles. Assigned in the database and nowhere else. */
export type Role = "USER" | "ADMIN";

/** Who is making a request, once the cookie has been read. */
export type Viewer = {
  id: string;
  username: string;
  role: Role;
};

/**
 * The username a fresh deployment comes up with, and the password it comes up
 * with it.
 *
 * Seeded rather than documented because a world with no way in is a world
 * nobody can author — the map editor is behind `ADMIN` now, and the first
 * `ADMIN` has to come from somewhere. The seed **creates and never updates**:
 * change this password in the running deployment and the next boot leaves it
 * alone, which is the whole reason it is safe to leave the seed in.
 */
export const SEEDED_ADMIN_USERNAME = "admin";
const SEEDED_ADMIN_PASSWORD = "salem123";

/**
 * The one address this server writes without anybody having typed it.
 *
 * Everybody else gives their own at sign-up. The seeded administrator is
 * created at boot, before there is anybody to ask, and the column is `NOT NULL`
 * — so it gets a placeholder rather than a guess at who the operator is.
 *
 * `.invalid` is reserved by RFC 2606 precisely for this: it can never be
 * registered, so a bug that started sending mail would bounce at the first
 * resolver rather than reaching a stranger who happens to own `stapes.com`.
 */
const SEEDED_ADMIN_EMAIL = "admin@stapes.invalid";

/**
 * Accounts, sessions and passwords, over the world's own database.
 *
 * **Signing in is a username and a password; the email is only stored.** It is
 * asked for at sign-up and kept, so there is a way to reach somebody about
 * their account — but nothing sends to it, nothing verifies it, and there is no
 * reset flow behind it. A game that made you click a link in your inbox before
 * it would let you walk around has asked for the wrong thing.
 *
 * **The role is not an input.** `input: false` is what keeps it out of every
 * request body Better Auth parses, sign-up included, so the only way to become
 * an `ADMIN` is an `UPDATE` somebody ran by hand against the database. That is
 * the whole access-control design: there is no promote endpoint to get wrong.
 *
 * **It shares the world's connection.** See {@link TursoDialect} — the database
 * is held exclusively, so accounts could not have a handle of their own even if
 * a separate file were wanted.
 */
export function createAuth(db: Database, config: Config, secret: string) {
  return betterAuth({
    appName: "Stapes",
    secret,
    baseURL: config.PUBLIC_ORIGIN,
    // Lives under the same `/api` prefix everything else does, because the one
    // origin is the whole deployment — see `server/index.ts`.
    basePath: "/api/auth",
    database: {
      dialect: new TursoDialect(db),
      type: "sqlite",
      // Never opened, and the dialect throws if one is asked for. A `BEGIN`
      // here would not own the connection the world checkpoints on.
      transaction: false,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // Nothing to verify against, and nowhere to send the mail. @see
      // syntheticEmail
      requireEmailVerification: false,
      autoSignIn: true,
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "USER",
          // The line that makes "roles are assigned in the database" true
          // rather than a convention: with this, a `role` in a request body is
          // dropped before it reaches the adapter.
          input: false,
        },
      },
    },
    /**
     * Which origins may post to these routes.
     *
     * Deployed, exactly one: the origin this server serves. That is the CSRF
     * check, and it is the whole of it — a form on somebody else's page cannot
     * sign your account out or change its password.
     *
     * In development, whatever the request came from. `bun dev` serves the
     * client on a port the operating system picked, `vite dev --host` puts it
     * on a LAN address as well so a phone can reach it, and Playwright asks for
     * `127.0.0.1` where `PUBLIC_ORIGIN` says `localhost` — three origins that
     * are all the same machine, and pinning any one of them breaks the other
     * two. Nothing here is defending a real account.
     */
    trustedOrigins: config.deployed
      ? [config.PUBLIC_ORIGIN]
      : (request) => [request?.headers.get("origin") ?? config.PUBLIC_ORIGIN],
    advanced: {
      cookies: {
        // The cookie has to ride the socket upgrade, which is same-origin and
        // a plain navigation, so `lax` is enough — and it is what the actor
        // cookie this replaces used. @see server/index.ts
        sessionToken: { attributes: { sameSite: "lax" } },
      },
      useSecureCookies: config.PUBLIC_ORIGIN.startsWith("https:"),
    },
    plugins: [
      username({
        minUsernameLength: MIN_USERNAME_LENGTH,
        maxUsernameLength: MAX_USERNAME_LENGTH,
        // A username is typed to sign in and never shown to anybody else, so
        // there is nothing to gain from a second, differently-cased copy of it.
        displayUsername: false,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Who this request is, or null.
 *
 * The one way anything here learns an identity: it reads the signed session
 * cookie off the headers, so nothing can hand in a user id and be believed.
 * That is the property the anonymous actor cookie had and the reason accounts
 * were built on top of it rather than beside it — every call site that used to
 * read the cookie now calls this instead, and none of them had to learn a new
 * rule about what to trust.
 */
export async function viewerOf(auth: Auth, headers: Headers): Promise<Viewer | null> {
  const result = await auth.api.getSession({ headers });
  if (!result?.user) return null;
  const user = result.user as {
    id: string;
    username?: string | null;
    role?: string | null;
  };
  return {
    id: user.id,
    // Only ever absent for a row written before the username plugin existed,
    // which in this database is no row at all. Falls back to the id rather
    // than throwing, because a session is not the place to discover a schema
    // problem.
    username: user.username ?? user.id,
    role: user.role === "ADMIN" ? "ADMIN" : "USER",
  };
}

/**
 * Put the first administrator in an empty database.
 *
 * **Create-only, and that is what makes it safe to ship.** It looks for the
 * username and returns if it finds it, so changing the password in a running
 * deployment is permanent: the next boot sees `admin` already there and does
 * nothing. Deleting the row is what would bring the seeded password back, and
 * that is a deliberate act.
 *
 * The role is set with SQL rather than through Better Auth, for the reason the
 * field is `input: false`: there is no endpoint that grants a role, on purpose,
 * so this is the same `UPDATE` an operator would run by hand.
 */
export async function seedAdmin(
  auth: Auth,
  db: Database,
  log: (message: string) => void = console.log,
): Promise<void> {
  const existing = await db.prepare("SELECT id FROM user WHERE username = ?");
  if (await existing.get([SEEDED_ADMIN_USERNAME])) return;

  await auth.api.signUpEmail({
    body: {
      email: SEEDED_ADMIN_EMAIL,
      password: SEEDED_ADMIN_PASSWORD,
      name: SEEDED_ADMIN_USERNAME,
      username: SEEDED_ADMIN_USERNAME,
    },
  });
  const promote = await db.prepare("UPDATE user SET role = 'ADMIN' WHERE username = ?");
  await promote.run([SEEDED_ADMIN_USERNAME]);
  log(
    `[auth] seeded the ${SEEDED_ADMIN_USERNAME} account — change its password before anybody else can reach this world`,
  );
}
