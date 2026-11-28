import { join, relative, resolve } from "node:path";
import { parseMap } from "../../app/lib/mapData";
import { statusesById } from "../../app/lib/status";
import { traitsById, withTraits } from "../../app/lib/traits";
import { normalizeTiles, type Coord } from "../../app/lib/types";
import { tilesByIdFromList } from "../../app/lib/validation";
import { findStranded, type StrandedRegion } from "../../app/verify/stranded";
import { applyExceptions, describeArea } from "../../app/verify/exceptions";
import { type Command, type Outcome, UsageError, wholeNumber } from "./cli";
import { EXCEPTIONS_FILE, readExceptions } from "./exceptionsFile";
import { strandedImage } from "./strandedImage";

const at = (c: Coord) => `${c.x},${c.y} L${c.z}`;
const keyOf = (c: Coord) => `${c.x},${c.y},${c.z}`;

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
    const found = findStranded(
      map,
      tilesByIdFromList(tiles),
      statusesById(await read("statuses.json")),
    );
    /**
     * Excused cell by cell, so a place is excused only when every one of its
     * cells is inside the area: one that spills out of it still fails.
     */
    const { excused, stale } = applyExceptions(
      "stranded",
      found.regions.flatMap((region) => region.cells.map((c) => ({ kind: "stranded", ...c }))),
      await readExceptions(dir),
    );
    const excusedCells = new Map(excused.map((c) => [`${c.x},${c.y},${c.z}`, c.reason]));
    const isExcused = (region: StrandedRegion) =>
      region.cells.every((c) => excusedCells.has(`${c.x},${c.y},${c.z}`));
    const failing = found.regions.filter((region) => !isExcused(region));
    const forgiven = found.regions.filter(isExcused);
    const report = {
      ...found,
      ok: failing.length === 0 && stale.length === 0,
      regions: failing,
      stranded: failing.reduce((n, region) => n + region.cells.length, 0),
      excused: forgiven.map((region) => ({
        cells: region.cells.length,
        at: region.cells[0]!,
        reason: excusedCells.get(keyOf(region.cells[0]!))!,
      })),
      stale,
    };
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
      for (const { cells, at: first, reason } of report.excused) {
        lines.push(`EXCUSED  ${cells} cells around ${at(first)}\n         ${reason}`);
      }
      for (const { area, reason } of report.stale) {
        lines.push(
          `STALE  stranded in ${describeArea(area)} is excused in ${EXCEPTIONS_FILE}, but nobody is stranded there; remove the area from the entry "${reason}"`,
        );
      }
      if (report.excused.length > 0 || report.stale.length > 0) lines.push("");
      lines.push(
        report.regions.length === 0
          ? `and can get back from every one of them${report.excused.length > 0 ? " but the places excused above" : ""}`
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
