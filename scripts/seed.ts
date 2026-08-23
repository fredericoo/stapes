/**
 * Load `data/` into a world's database.
 *
 * Rarely needed, and that is the point: the server seeds itself on boot when
 * the store is empty, so a fresh environment comes up playable with nothing to
 * run. This is for the other case — replacing authored content in a database
 * that already has some, which the boot path deliberately will not do.
 *
 *   bun scripts/seed.ts                  # ./.dev/stapes.db
 *   DATA_DIR=/data bun scripts/seed.ts   # a deployed volume
 *
 * It does not touch the world being played. The checkpoint is preferred over
 * authored content on load, so a seed changes nothing anybody can see until the
 * world is reset — `POST /api/reset`, which is destructive and says so.
 */
import { openDatabase } from "../server/db";
import { SqliteBlobs } from "../server/blobs";
import { seedFromDirectory } from "../server/seed";
import { readConfig } from "../server/config";

const config = readConfig();
const db = await openDatabase(config.databasePath);
const blobs = new SqliteBlobs(db);

await seedFromDirectory(blobs, config.SEED_DIR);
await db.close?.();

console.log(
  `Seeded ${config.SEED_DIR} into ${config.databasePath}.\n` +
    `The running world keeps its checkpoint — POST /api/reset to start it over.`,
);
