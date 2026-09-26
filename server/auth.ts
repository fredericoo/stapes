import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins/username";
import { MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH, MIN_USERNAME_LENGTH } from "../app/lib/account";
import { TursoDialect } from "./authDialect";
import type { Config } from "./config";
import type { Database } from "./db";

export type Role = "USER" | "ADMIN";

export type Viewer = {
  id: string;
  username: string;
  role: Role;
};

export const SEEDED_ADMIN_USERNAME = "admin";
const SEEDED_ADMIN_PASSWORD = "salem123";

const SEEDED_ADMIN_EMAIL = "admin@stapes.invalid";

export function createAuth(db: Database, config: Config, secret: string) {
  return betterAuth({
    appName: "The Last Stones",
    secret,
    baseURL: config.PUBLIC_ORIGIN,
    basePath: "/api/auth",
    database: {
      dialect: new TursoDialect(db),
      type: "sqlite",
      transaction: false,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "USER",
          input: false,
        },
      },
    },
    trustedOrigins: config.deployed
      ? [config.PUBLIC_ORIGIN]
      : (request) => [request?.headers.get("origin") ?? config.PUBLIC_ORIGIN],
    advanced: {
      cookies: {
        sessionToken: { attributes: { sameSite: "lax" } },
      },
      useSecureCookies: config.PUBLIC_ORIGIN.startsWith("https:"),
    },
    plugins: [
      username({
        minUsernameLength: MIN_USERNAME_LENGTH,
        maxUsernameLength: MAX_USERNAME_LENGTH,
        displayUsername: false,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

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
    username: user.username ?? user.id,
    role: user.role === "ADMIN" ? "ADMIN" : "USER",
  };
}

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
