import { join, relative, resolve } from "node:path";
import { parseMap } from "../../app/lib/mapData";
import { readPngSize } from "../../app/lib/png";
import {
  checkContent,
  type ContentReport,
  type Finding,
  type Loaded,
  type SheetSize,
} from "../../app/verify/content";
import { type Command, type Outcome, UsageError } from "./cli";

async function load<T>(path: string, parse: (text: string) => T): Promise<Loaded<T>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { error: `${path} does not exist` };
  try {
    return { value: parse(await file.text()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function sheetSizes(dir: string, tilesets: Loaded<unknown>) {
  const sizes: Record<string, SheetSize | null> = {};
  if (!("value" in tilesets) || !Array.isArray(tilesets.value)) return sizes;
  for (const entry of tilesets.value as { file?: unknown }[]) {
    if (typeof entry?.file !== "string") continue;
    const png = Bun.file(join(dir, "tilesets", entry.file));
    try {
      sizes[entry.file] = readPngSize(new Uint8Array(await png.arrayBuffer()));
    } catch {
      sizes[entry.file] = null;
    }
  }
  return sizes;
}

function findingLines(finding: Finding, dir: string): string {
  const where = [finding.id, finding.path].filter(Boolean).join(" · ");
  const label = finding.severity === "error" ? "ERROR" : "WARN ";
  return `${label} ${join(dir, finding.file)}${where ? `  ${where}` : ""}\n      ${finding.message}`;
}

function summary(report: ContentReport, dir: string): string {
  const { checked, counts } = report;
  const lines = [
    `checked ${checked.tiles} tiles (${checked.battlers} battlers, ${checked.brains} brains, ${checked.dialogs} dialogs), ${checked.statuses} statuses, ${checked.tilesets} tilesets` +
      (checked.placements === null
        ? ""
        : `, ${checked.placements.toLocaleString("en")} map placements`),
    "",
  ];
  for (const finding of report.findings) lines.push(findingLines(finding, dir));
  if (report.findings.length > 0) lines.push("");
  lines.push(
    `${counts.errors} ${counts.errors === 1 ? "error" : "errors"}, ${counts.warnings} ${counts.warnings === 1 ? "warning" : "warnings"}` +
      (counts.errors > 0 ? " (errors exit 1; map findings are warnings)" : ""),
  );
  return lines.join("\n");
}

export const content: Command = {
  name: "content",
  summary: "load every tile, status, brain and dialog in data/ and check every id they name",
  usage: "bun run verify content [--data <dir>] [--json]",
  options: { data: { type: "string" } },
  help: [
    ["--data <dir>", "the content directory to check (default: data)"],
    ["--json", "print one JSON object instead of the table"],
  ],
  async run({ values, positionals }): Promise<Outcome> {
    if (positionals.length > 0) {
      throw new UsageError(`content takes no arguments, and was given "${positionals.join(" ")}".`);
    }
    const dir =
      typeof values.data === "string" ? resolve(values.data) : join(import.meta.dir, "../../data");
    const tilesets = await load(join(dir, "tilesets.json"), JSON.parse);
    const report = checkContent({
      tiles: await load(join(dir, "tiles.json"), JSON.parse),
      statuses: await load(join(dir, "statuses.json"), JSON.parse),
      tilesets,
      sheetSizes: await sheetSizes(dir, tilesets),
      map: await load(join(dir, "map.json"), parseMap),
    });
    const nearby = relative(process.cwd(), dir) || ".";
    const shown = nearby.startsWith("..") ? dir : nearby;
    return {
      exitCode: report.ok ? 0 : 1,
      seed: null,
      json: { data: shown, ...report },
      text: summary(report, shown),
    };
  },
};
