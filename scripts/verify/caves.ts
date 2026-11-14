import { join, relative, resolve } from "node:path";
import { parseMap } from "../../app/lib/mapData";
import { traitsById, withTraits } from "../../app/lib/traits";
import { normalizeTiles } from "../../app/lib/types";
import { tilesByIdFromList } from "../../app/lib/validation";
import { type CaveProblem, checkCaves } from "../../app/verify/caves";
import {
  applyExceptions,
  describeArea,
  parseExceptions,
  type VerifyException,
} from "../../app/verify/exceptions";
import { AUTHORED_HOLES, SYSTEM } from "../caveSystem";
import { type Command, type Outcome, UsageError } from "./cli";

const EXCEPTIONS_FILE = "verify-exceptions.json";

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

export const caves: Command = {
  name: "caves",
  summary: "check every cave floor for open sky, daylight, headroom and a way in",
  usage: "bun run verify caves [--data <dir>] [--json]",
  options: { data: { type: "string" } },
  help: [
    ["--data <dir>", "the content directory to check (default: data)"],
    ["--json", "print one JSON object instead of the table"],
  ],
  async run({ values, positionals }): Promise<Outcome> {
    if (positionals.length > 0) {
      throw new UsageError(`caves takes no arguments, and was given "${positionals.join(" ")}".`);
    }
    const dir =
      typeof values.data === "string" ? resolve(values.data) : join(import.meta.dir, "../../data");
    const read = async (file: string) => JSON.parse(await Bun.file(join(dir, file)).text());
    const exceptions = await readExceptions(dir);
    const tiles = withTraits(
      normalizeTiles(await read("tiles.json")),
      traitsById(await read("traits.json")),
    );
    const report = checkCaves({
      map: parseMap(await Bun.file(join(dir, "map.json")).text()),
      tilesById: tilesByIdFromList(tiles),
      levels: SYSTEM.levels,
      mouth: SYSTEM.mouth,
      mouthDescent: SYSTEM.mouthDescent,
      openings: [SYSTEM.mouth, ...AUTHORED_HOLES],
    });
    const { failing, excused, stale } = applyExceptions<CaveProblem>(
      "caves",
      report.problems,
      exceptions,
    );

    const walked = Object.entries(report.walked).map(([z, n]) => `${z} ${n.toLocaleString("en")}`);
    const lines = [
      `checked ${report.cells.toLocaleString("en")} cave floor cells; walked to ${walked.join(", ")}`,
      "",
    ];
    for (const problem of failing) lines.push(`FAIL   ${problem.kind}  ${problem.message}`);
    const byReason = new Map<string, Map<string, number>>();
    for (const { reason, kind } of excused) {
      const kinds = byReason.get(reason) ?? new Map<string, number>();
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      byReason.set(reason, kinds);
    }
    for (const [reason, kinds] of byReason) {
      const counted = [...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ");
      lines.push(`EXCUSED  ${counted}\n         ${reason}`);
    }
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
        walked: report.walked,
        daylit: report.daylit,
        failing,
        excused,
        stale,
      },
      text: lines.join("\n"),
    };
  },
};
