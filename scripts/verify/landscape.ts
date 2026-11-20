import { join, relative, resolve } from "node:path";
import { parseMap } from "../../app/lib/mapData";
import { traitsById, withTraits } from "../../app/lib/traits";
import { normalizeTiles } from "../../app/lib/types";
import { tilesByIdFromList } from "../../app/lib/validation";
import {
  applyExceptions,
  describeArea,
  parseExceptions,
  type VerifyException,
} from "../../app/verify/exceptions";
import { checkLandscape, type LandscapeProblem } from "../../app/verify/landscape";
import { type Command, type Outcome, UsageError, percent } from "./cli";

const EXCEPTIONS_FILE = "verify-exceptions.json";
/** Failures printed one by one before the rest are only counted, so a map that breaks a rule everywhere still prints a readable report. */
const LISTED_PER_KIND = 20;

async function readExceptions(dir: string): Promise<VerifyException[]> {
  const file = Bun.file(join(dir, EXCEPTIONS_FILE));
  if (!(await file.exists())) return [];
  try {
    return parseExceptions(JSON.parse(await file.text()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${join(dir, EXCEPTIONS_FILE)} does not load: ${message}`);
  }
}

function failureLines(failing: readonly LandscapeProblem[]): string[] {
  const byKind = new Map<string, LandscapeProblem[]>();
  for (const problem of failing)
    byKind.set(problem.kind, [...(byKind.get(problem.kind) ?? []), problem]);
  const lines: string[] = [];
  for (const [kind, problems] of byKind) {
    for (const problem of problems.slice(0, LISTED_PER_KIND))
      lines.push(`FAIL   ${kind}  ${problem.message}`);
    const more = problems.length - LISTED_PER_KIND;
    if (more > 0) lines.push(`FAIL   ${kind}  and ${more.toLocaleString("en")} more`);
  }
  return lines;
}

export const landscape: Command = {
  name: "landscape",
  summary:
    "check the map's rivers, banks, ground patches, borders and how crowded deserts and snow are",
  usage: "bun run verify landscape [--data <dir>] [--json]",
  options: { data: { type: "string" } },
  help: [
    ["--data <dir>", "the content directory to check (default: data)"],
    ["--json", "print one JSON object instead of the table"],
  ],
  async run({ values, positionals }): Promise<Outcome> {
    if (positionals.length > 0) {
      throw new UsageError(
        `landscape takes no arguments, and was given "${positionals.join(" ")}".`,
      );
    }
    const dir =
      typeof values.data === "string" ? resolve(values.data) : join(import.meta.dir, "../../data");
    const read = async (file: string) => JSON.parse(await Bun.file(join(dir, file)).text());
    const tiles = withTraits(
      normalizeTiles(await read("tiles.json")),
      traitsById(await read("traits.json")),
    );
    const report = checkLandscape({
      map: parseMap(await Bun.file(join(dir, "map.json")).text()),
      tilesById: tilesByIdFromList(tiles),
    });
    const { failing, excused, stale } = applyExceptions<LandscapeProblem>(
      "landscape",
      report.problems,
      await readExceptions(dir),
    );

    const densest = Object.entries(report.densest)
      .map(([kind, d]) => `${kind} ${percent(d.share)} at ${d.at}`)
      .join(", ");
    const lines = [
      `checked ${report.cells.toLocaleString("en")} surface cells; most crowded open ground: ${densest || "none"}`,
      "",
      ...failureLines(failing),
    ];
    for (const { kind, area, reason } of stale) {
      lines.push(
        `STALE  ${kind} in ${describeArea(area)} is excused in ${EXCEPTIONS_FILE}, but nothing there has that problem; remove the area from the entry "${reason}"`,
      );
    }
    if (lines.length > 2) lines.push("");
    lines.push(
      `${failing.length} failing, ${excused.length} excused, ${stale.length} stale` +
        (failing.length + stale.length > 0 ? " (failing and stale exit 1)" : ""),
    );

    const nearby = relative(process.cwd(), dir) || ".";
    return {
      exitCode: failing.length + stale.length > 0 ? 1 : 0,
      seed: null,
      json: {
        data: nearby.startsWith("..") ? dir : nearby,
        cells: report.cells,
        densest: report.densest,
        failing,
        excused,
        stale,
      },
      text: lines.join("\n"),
    };
  },
};
