import { join } from "node:path";
import { statusesById } from "../../app/lib/status";
import { normalizeTiles } from "../../app/lib/types";
import type { BattleOptions, Catalogue } from "../../app/verify/battle";
import { type RatingRow, type RatingsReport, runRatings } from "../../app/verify/ratings";
import { KITS } from "../../app/verify/sides";
import { choice, type Command, table, wholeNumber } from "./cli";

const DATA = join(import.meta.dir, "../../data");

const DEFAULT_SEEDS = 100;
const DEFAULT_MAX_SECONDS = 120;

async function catalogue(): Promise<Catalogue> {
  const tiles = normalizeTiles(await Bun.file(join(DATA, "tiles.json")).json());
  return {
    tilesById: Object.fromEntries(tiles.map((tile) => [tile.id, tile])),
    statusDefs: statusesById(await Bun.file(join(DATA, "statuses.json")).json()),
  };
}

function evenText(row: RatingRow): string {
  if (row.harmless) return "harmless";
  return row.even === null ? "none" : String(row.even);
}

function heaviestText(row: RatingRow): string {
  if (row.heaviestBlow === 0) return "-";
  return `${row.heaviestBlow} (${(row.heaviestShare * 100).toFixed(0)}%)`;
}

function ratingsText(report: RatingsReport): string {
  const setup = `${report.seeds.toLocaleString("en")} seeds a level, each fought both ways round · statuses ${report.statuses ? "on" : "off"} · kit ${report.kit} · undecided after ${report.maxSeconds} s`;
  const rows = table(
    [
      ["creature", "rating", "authored", "even level", "heaviest blow"],
      ...report.rows.map((row) => [
        row.key,
        String(row.rating),
        row.authored ? "yes" : "no",
        evenText(row),
        heaviestText(row),
      ]),
    ],
    [1, 3, 4],
  );
  const key =
    "Even level: the lowest level at which a player with Sharp, Toughness and Agility at that level, holding that level's sword, wins at least as often as it loses. The Arena's Duel casts no spells, so a body that fights with them is harder than its even level. Heaviest blow: the most one swing of any weapon in its kit can be worth before armour, and its share of the hit points of a player whose Toughness is the creature's rating.";
  return [setup, rows, key].join("\n\n");
}

export const ratings: Command = {
  name: "ratings",
  summary:
    "bisect the level at which a player fights each creature even, beside the rating it shows",
  usage: "bun run verify ratings [options]",
  options: {
    seeds: { type: "string" },
    seed: { type: "string" },
    statuses: { type: "string" },
    kit: { type: "string" },
    "max-seconds": { type: "string" },
  },
  help: [
    ["--seeds <n>", `seeds to fight at each level tried (default ${DEFAULT_SEEDS})`],
    ["--seed <s>", "the first seed (default 1)"],
    ["--statuses on|off", "apply the status catalogue, as the world does (default on)"],
    ["--kit rolled|none", "roll each body's kit per seed, as the world does (default rolled)"],
    [
      "--max-seconds <n>",
      `a fight still going after this long counts as undecided (default ${DEFAULT_MAX_SECONDS})`,
    ],
  ],
  async run({ values }) {
    const options: BattleOptions = {
      seeds: wholeNumber(values.seeds, "--seeds", DEFAULT_SEEDS, 1),
      seed: wholeNumber(values.seed, "--seed", 1),
      statuses: choice(values.statuses, "--statuses", ["on", "off"] as const, "on") === "on",
      kit: choice(values.kit, "--kit", KITS, "rolled"),
      maxSeconds: wholeNumber(values["max-seconds"], "--max-seconds", DEFAULT_MAX_SECONDS, 1),
    };
    const report = runRatings(await catalogue(), options);
    return { exitCode: 0, seed: options.seed, json: { ...report }, text: ratingsText(report) };
  },
};
