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
