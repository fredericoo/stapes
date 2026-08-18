/**
 * Put an environment back to exactly what the repo says, in one command.
 *
 * There are three sources of truth and nothing reconciles them: `data/` in the
 * repo, the R2 bucket, and the Durable Object holding the world being played.
 * Seeding fixes the second and cannot touch the third — the object prefers its
 * own checkpoint to the bucket, and the editor's save deliberately carries
 * every player's kit, tags and masteries forward, so no amount of seeding or
 * saving clears what it remembers about somebody. This is both halves:
 *
 *   1. upload `data/` over the bucket, and
 *   2. ask the deployment to throw its world away and reload from it.
 *
 * **It destroys everything anybody has done.** Every position, kit, reward and
 * mastery in the world, for every player. There is no undo and nothing is
 * backed up.
 *
 *   RESET_SECRET=… pnpm reset --remote
 *   pnpm reset                      # against `pnpm dev` on localhost
 *   RESET_SECRET=… pnpm reset --remote --url https://staging.example.workers.dev
 *
 * The secret is the one set with `wrangler secret put RESET_SECRET`. A
 * deployment without one has no reset endpoint at all — see
 * `app/routes/reset.ts`.
 */
import { seedR2 } from "./seed-r2";

/**
 * The deployed Worker.
 *
 * Hardcoded because it cannot be derived: a `workers.dev` hostname is the
 * Worker's name under the *account's* subdomain, and `wrangler.jsonc` knows the
 * first half only. `--url` is the way to point this somewhere else.
 */
const DEPLOYED_ORIGIN = "https://stapes.rincofrederico.workers.dev";

/** Where `pnpm dev` serves from. */
const LOCAL_ORIGIN = "http://localhost:5173";

const RESET_PATH = "/reset";

function originFrom(argv: string[], remote: boolean): string {
  const at = argv.indexOf("--url");
  if (at < 0) return remote ? DEPLOYED_ORIGIN : LOCAL_ORIGIN;
  const url = argv[at + 1];
  if (!url) throw new Error("--url needs a value");
  // Parsed rather than trusted: a typo here is a POST at whatever it does
  // resolve to, and the failure would read as "reset did nothing".
  return new URL(url).origin;
}

async function main() {
  const remote = process.argv.includes("--remote");
  const origin = originFrom(process.argv, remote);
  const secret = process.env.RESET_SECRET;

  // Before the seed, not after. Half a reset — a bucket replaced and a world
  // still running the old one — is a worse state than the one we started in,
  // and this is the failure that is certain to happen to somebody.
  if (!secret) {
    throw new Error(
      "RESET_SECRET is not set. It is the secret this deployment was given " +
        "with `wrangler secret put RESET_SECRET`.",
    );
  }

  console.log(`Seeding data/ into R2 (${remote ? "remote" : "local"})…`);
  const count = await seedR2(remote);
  console.log(`\n${count} objects seeded.`);

  console.log(`\nWiping the world at ${origin}…`);
  const res = await fetch(`${origin}${RESET_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    // The body, because the status alone does not separate the two answers that
    // matter: 404 is a deployment with no secret configured, 401 is the wrong
    // one, and both look like "it did not work".
    throw new Error(
      `Reset failed: ${res.status} ${res.statusText} — ${await res.text()}`,
    );
  }

  console.log("World reset. Everyone reconnecting starts fresh.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
