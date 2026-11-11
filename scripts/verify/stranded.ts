import { join, relative, resolve } from "node:path";
import { parseMap } from "../../app/lib/mapData";
import { statusesById } from "../../app/lib/status";
import { traitsById, withTraits } from "../../app/lib/traits";
import { normalizeTiles, type Coord } from "../../app/lib/types";
import { tilesByIdFromList } from "../../app/lib/validation";
import { findStranded, type StrandedRegion } from "../../app/verify/stranded";
import { type Command, type Outcome, UsageError, wholeNumber } from "./cli";
import { strandedImage } from "./strandedImage";

const at = (c: Coord) => `${c.x},${c.y} L${c.z}`;

function regionLines(region: StrandedRegion, entrances: number): string[] {
  const lines = [`${region.cells.length} cells around ${at(region.cells[0]!)}`];
  for (const entrance of region.entrances.slice(0, entrances)) {
    lines.push(`    ${entrance.by} from ${at(entrance.from)} to ${at(entrance.to)}`);
  }
  const more = region.entrances.length - entrances;
  if (more > 0) lines.push(`    and ${more} more ways in`);
  return lines;
}

export const stranded: Command = {
  name: "stranded",
  summary: "walk data/map.json from where a player starts and list every place they cannot leave",
  usage: "bun run verify stranded [--data <dir>] [--regions <n>] [--image <file.png>] [--json]",
  options: { data: { type: "string" }, regions: { type: "string" }, image: { type: "string" } },
  help: [
    ["--data <dir>", "the content directory to check (default: data)"],
    ["--regions <n>", "how many stranded places to list in the table (default: 20)"],
    ["--image <file.png>", "also draw the map with every stranded cell in red, and write it there"],
    ["--json", "print one JSON object instead of the table, with every place in it"],
  ],
  async run({ values, positionals }): Promise<Outcome> {
    if (positionals.length > 0) {
      throw new UsageError(
        `stranded takes no arguments, and was given "${positionals.join(" ")}".`,
      );
    }
    const dir =
      typeof values.data === "string" ? resolve(values.data) : join(import.meta.dir, "../../data");
    const shown = wholeNumber(values.regions, "--regions", 20, 0);
    const read = async (file: string) => JSON.parse(await Bun.file(join(dir, file)).text());

    const tiles = withTraits(
      normalizeTiles(await read("tiles.json")),
      traitsById(await read("traits.json")),
    );
    const map = parseMap(await Bun.file(join(dir, "map.json")).text());
    const report = findStranded(
      map,
      tilesByIdFromList(tiles),
      statusesById(await read("statuses.json")),
    );
    const image = typeof values.image === "string" ? resolve(values.image) : null;
    if (image) await Bun.write(image, strandedImage(map, report));

    const nearby = relative(process.cwd(), dir) || ".";
    const lines: string[] = [];
    if (!report.start) {
      lines.push("the map has no player to start from");
    } else {
      lines.push(
        `from ${at(report.start)} a player can get to ${report.reachable.toLocaleString("en")} cells`,
        "",
      );
      for (const region of report.regions.slice(0, shown)) lines.push(...regionLines(region, 3));
      const more = report.regions.length - shown;
      if (more > 0) lines.push(`and ${more} more places`);
      if (report.regions.length > 0) lines.push("");
      lines.push(
        report.ok
          ? "and can get back from every one of them"
          : `${report.stranded.toLocaleString("en")} of them, in ${report.regions.length} places, cannot be left again`,
      );
    }
    if (image) lines.push("", `map drawn to ${image}`);
    return {
      exitCode: report.ok ? 0 : 1,
      seed: null,
      json: { data: nearby.startsWith("..") ? dir : nearby, image, ...report },
      text: lines.join("\n"),
    };
  },
};
