import { openDatabase } from "../server/db";
import { SqliteBlobs } from "../server/blobs";
import { seedFromDirectory } from "../server/seed";
import { readConfig } from "../server/config";

const config = readConfig();
const db = await openDatabase(config.databasePath);
const blobs = new SqliteBlobs(db);

await seedFromDirectory(blobs, config.SEED_DIR, config.SEED_TREE);
await db.close?.();

console.log(
  `Seeded ${config.SEED_DIR} into ${config.databasePath}.\n` +
    `The server builds the map from the tree when it next starts, keeping players.`,
);
