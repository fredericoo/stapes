import { findPlayers } from "../game/player";
import { battlerIssues, resolveBattler } from "../lib/battler";
import { resolveBrain, validateBrain } from "../lib/brain";
import { resolveDialog, validateDialog } from "../lib/dialog";
import { parseFormula, statusesNamedIn } from "../lib/formula";
import {
  MAX_CRAFT_RECIPES,
  MAX_EXTRACT_SLOTS,
  resolveAddStatus,
  resolveCraft,
  resolveDecay,
  resolveEmit,
  resolveEndure,
  resolveExtract,
  resolvePressurePlate,
  resolvePush,
  resolveReceive,
  resolveRemoveStatus,
  resolveRespawn,
  resolveRewardDef,
  resolveSetSpawn,
  resolveSwitch,
  resolveTeleportDef,
  type TileInteractions,
} from "../lib/interactions";
import { resolveItem } from "../lib/item";
import { listCoords } from "../lib/mapData";
import { resolveProjectile } from "../lib/projectile";
import { anchorFits } from "../lib/spriteAnchor";
import {
  COMBAT_STATUS_ID,
  MODIFIER_KEYS,
  resolveStatus,
  type StatusDef,
  statusesById,
} from "../lib/status";
import { tileArtError, tileIdentityError } from "../lib/tileSave";
import {
  type MapFile,
  MAX_LEVEL,
  MAX_LIGHT_LEVEL,
  maxLightRadius,
  MIN_LEVEL,
  normalizeTileDef,
  TILE_KINDS,
  TILE_TYPES,
  type TileDef,
  type TilesetDef,
} from "../lib/types";
import { removeUnfitPlacements } from "../lib/validation";
import { checkReferences, type Catalogue, iconProblem } from "./references";

export type Severity = "error" | "warn";

export type ContentFile = "tiles.json" | "statuses.json" | "tilesets.json" | "map.json";

export type Finding = {
  severity: Severity;
  file: ContentFile;
  id: string;
  path: string;
  message: string;
};

export type SheetSize = { width: number; height: number };

export type Loaded<T> = { value: T } | { error: string };

export type ContentInput = {
  tiles: Loaded<unknown>;
  statuses: Loaded<unknown>;
  tilesets: Loaded<unknown>;
  sheetSizes: Record<string, SheetSize | null>;
  map: Loaded<MapFile>;
};

export type ContentReport = {
  ok: boolean;
  counts: { errors: number; warnings: number };
  checked: {
    tiles: number;
    brains: number;
    dialogs: number;
    battlers: number;
    statuses: number;
    tilesets: number;
    placements: number | null;
  };
  findings: Finding[];
};

export class Findings {
  readonly list: Finding[] = [];

  constructor(private readonly file: ContentFile) {}

  error(id: string, path: string, message: string) {
    this.list.push({ severity: "error", file: this.file, id, path, message });
  }

  warn(id: string, path: string, message: string) {
    this.list.push({ severity: "warn", file: this.file, id, path, message });
  }
}

const RESOLVERS: { [K in keyof TileInteractions]-?: (def: TileDef) => unknown } = {
  brain: resolveBrain,
  dialog: resolveDialog,
  battler: resolveBattler,
  item: resolveItem,
  projectile: resolveProjectile,
  push: resolvePush,
  switch: resolveSwitch,
  reward: resolveRewardDef,
  craft: resolveCraft,
  extract: resolveExtract,
  teleport: resolveTeleportDef,
  addStatus: resolveAddStatus,
  removeStatus: resolveRemoveStatus,
  setSpawn: resolveSetSpawn,
  endure: resolveEndure,
  decay: resolveDecay,
  respawn: resolveRespawn,
  pressurePlate: resolvePressurePlate,
  emit: resolveEmit,
  receive: resolveReceive,
};

const KIND_OF_BLOCK: Partial<Record<keyof TileInteractions, TileDef["kind"]>> = {
  battler: "battler",
  item: "item",
  projectile: "projectile",
};

type Entry = Record<string, unknown>;

function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryId(raw: unknown, index: number): string {
  return isEntry(raw) && typeof raw.id === "string" && raw.id ? raw.id : `#${index}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function checkContent(input: ContentInput): ContentReport {
  const tileFindings = new Findings("tiles.json");
  const statusFindings = new Findings("statuses.json");
  const tilesetFindings = new Findings("tilesets.json");
  const mapFindings = new Findings("map.json");

  const rawTiles = parsed(input.tiles, tileFindings);
  const rawStatuses = parsed(input.statuses, statusFindings);
  const rawTilesets = parsed(input.tilesets, tilesetFindings);

  const sheets = loadSheets(rawTilesets, input.sheetSizes, tilesetFindings);
  const tiles = loadTiles(rawTiles, tileFindings);
  const tilesById: Record<string, TileDef> = {};
  for (const { def } of tiles) tilesById[def.id] = def;
  const statusDefs = loadStatuses(rawStatuses, statusFindings);
  const catalogue: Catalogue = { tilesById, statusDefs, sheets };

  for (const { raw, def } of tiles) checkTile(raw, def, catalogue, tileFindings);
  checkStatuses(rawStatuses, catalogue, statusFindings);
  let placements: number | null = null;
  if ("error" in input.map) mapFindings.warn("", "", `The map does not load: ${input.map.error}.`);
  else placements = checkMap(input.map.value, tilesById, mapFindings);

  const findings = [
    ...tileFindings.list,
    ...statusFindings.list,
    ...tilesetFindings.list,
    ...mapFindings.list,
  ].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.id.localeCompare(b.id) ||
      a.path.localeCompare(b.path),
  );
  const errors = findings.filter((finding) => finding.severity === "error").length;

  return {
    ok: errors === 0,
    counts: { errors, warnings: findings.length - errors },
    checked: {
      tiles: tiles.length,
      brains: tiles.filter(({ def }) => def.interactions?.brain != null).length,
      dialogs: tiles.filter(({ def }) => def.interactions?.dialog != null).length,
      battlers: tiles.filter(({ def }) => def.kind === "battler").length,
      statuses: list(rawStatuses).length,
      tilesets: list(rawTilesets).length,
      placements,
    },
    findings,
  };
}

const UNREAD = Symbol("unread");

function parsed(loaded: Loaded<unknown>, findings: Findings): unknown {
  if ("value" in loaded) return loaded.value;
  findings.error("", "", `The file does not load: ${loaded.error}.`);
  return UNREAD;
}

function severityRank(severity: Severity): number {
  return severity === "error" ? 0 : 1;
}

function loadSheets(
  raw: unknown,
  sizes: Record<string, SheetSize | null>,
  findings: Findings,
): Map<string, TilesetDef | null> {
  const sheets = new Map<string, TilesetDef | null>();
  if (!Array.isArray(raw)) {
    if (raw !== UNREAD) findings.error("", "", "tilesets.json is not a list of sheets.");
    return sheets;
  }
  raw.forEach((entry, index) => {
    const id = entryId(entry, index);
    if (!isEntry(entry) || typeof entry.id !== "string" || typeof entry.file !== "string") {
      findings.error(id, "", "This sheet has no id or no file.");
      return;
    }
    if (sheets.has(entry.id)) {
      findings.error(
        id,
        "id",
        `A second sheet has the id "${id}"; tiles on it read one of the two.`,
      );
      return;
    }
    const size = sizes[entry.file];
    if (!size) {
      findings.error(id, "file", `tilesets/${entry.file} is missing or is not a PNG.`);
      sheets.set(entry.id, null);
      return;
    }
    if (size.width !== entry.width || size.height !== entry.height) {
      findings.error(
        id,
        "width",
        `tilesets.json says ${String(entry.width)}×${String(entry.height)} px, but tilesets/${entry.file} is ${size.width}×${size.height} px.`,
      );
    }
    sheets.set(entry.id, { ...(entry as TilesetDef), width: size.width, height: size.height });
  });
  return sheets;
}

function loadTiles(raw: unknown, findings: Findings): { raw: Entry; def: TileDef }[] {
  if (!Array.isArray(raw)) {
    if (raw !== UNREAD) findings.error("", "", "tiles.json is not a list of tiles.");
    return [];
  }
  const loaded: { raw: Entry; def: TileDef }[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const id = entryId(entry, index);
    if (!isEntry(entry) || typeof entry.id !== "string" || !entry.id) {
      findings.error(id, "id", "This tile has no id, so nothing can name or place it.");
      return;
    }
    if (typeof entry.name !== "string") {
      findings.error(id, "name", "This tile has no name.");
      return;
    }
    if (seen.has(entry.id)) {
      findings.error(id, "id", `A second tile has the id "${id}"; a lookup by id finds the last.`);
    }
    seen.add(entry.id);
    try {
      loaded.push({ raw: entry, def: normalizeTileDef(entry) });
    } catch (error) {
      findings.error(id, "", `normalizeTileDef throws on this tile: ${messageOf(error)}.`);
    }
  });
  return loaded;
}

function loadStatuses(raw: unknown, findings: Findings): Record<string, StatusDef> {
  if (!Array.isArray(raw) && raw !== UNREAD) {
    findings.error("", "", "statuses.json is not a list of statuses.");
  }
  return statusesById(list(raw));
}

function checkTile(raw: Entry, def: TileDef, catalogue: Catalogue, findings: Findings) {
  const id = def.id;
  try {
    checkNormalised(raw, def, findings);

    const refusal = tileIdentityError(def) ?? tileArtError(def);
    if (refusal)
      findings.error(id, "", `The tile editor would refuse to save this tile: ${refusal}.`);

    const sheet = catalogue.sheets.get(def.anchor.tilesetId);
    if (sheet === undefined) {
      findings.error(
        id,
        "anchor.tilesetId",
        `The anchor names sheet "${def.anchor.tilesetId}", which tilesets.json does not list.`,
      );
    } else if (sheet) {
      const problem = anchorFits(def, def.anchor, [sheet]);
      if (problem) findings.error(id, "anchor", `${problem} (${sheet.width}×${sheet.height} px).`);
    }

    checkBlocks(raw, def, catalogue, findings);
    checkReferences(def, catalogue, findings);
  } catch (error) {
    findings.error(id, "", `Checking this tile threw: ${messageOf(error)}.`);
  }
}

function checkNormalised(raw: Entry, def: TileDef, findings: Findings) {
  const id = def.id;
  if (raw.kind !== undefined && !TILE_KINDS.includes(raw.kind as TileDef["kind"])) {
    findings.error(
      id,
      "kind",
      `Kind "${String(raw.kind)}" is not one of ${TILE_KINDS.join(", ")}, so the tile loads as a prop.`,
    );
  }
  if (!TILE_TYPES.includes(raw.type as TileDef["type"])) {
    findings.error(
      id,
      "type",
      `Type "${String(raw.type)}" is not one of ${TILE_TYPES.join(", ")}, so normalizeTileDef reads the tile as the old encoding.`,
    );
    return;
  }
  if (raw.particles != null && def.particles === undefined) {
    findings.error(id, "particles", "The particles do not parse, so normalizeTileDef drops them.");
  }
  const transitions = isEntry(raw.transitions) ? raw.transitions : {};
  for (const side of ["appear", "disappear"] as const) {
    if (transitions[side] != null && def.transitions?.[side] === undefined) {
      findings.error(
        id,
        `transitions.${side}`,
        `The ${side} transition does not parse, so normalizeTileDef drops it.`,
      );
    }
  }
  const radius = maxLightRadius(raw as TileDef);
  if (radius > MAX_LIGHT_LEVEL) {
    findings.warn(
      id,
      "light",
      `A frame's light radius is ${radius}, and every radius above MAX_LIGHT_LEVEL is drawn at ${MAX_LIGHT_LEVEL}.`,
    );
  }
}

function checkBlocks(raw: Entry, def: TileDef, catalogue: Catalogue, findings: Findings) {
  const id = def.id;
  const blocks = isEntry(raw.interactions) ? raw.interactions : {};
  if (raw.interactions != null && !isEntry(raw.interactions)) {
    findings.error(id, "interactions", "The interactions are not an object, so none of them load.");
  }

  if (def.kind === "battler") {
    for (const issue of battlerIssues(def)) {
      findings.error(
        id,
        "interactions.battler",
        `The battler block does not load (${issue}), so this body has no hit points, no natural weapon and no spells.`,
      );
    }
  } else if ((def.kind === "item" || def.kind === "projectile") && blocks[def.kind] == null) {
    findings.error(
      id,
      `interactions.${def.kind}`,
      `The kind is ${def.kind}, but there is no ${def.kind} block, so ${RESOLVERS[def.kind].name} returns null.`,
    );
  }

  for (const [key, block] of Object.entries(blocks)) {
    if (block == null) continue;
    const resolve = RESOLVERS[key as keyof TileInteractions];
    const path = `interactions.${key}`;
    if (!resolve) {
      findings.warn(id, path, `"${key}" is not an interaction the game reads.`);
      continue;
    }
    const kind = KIND_OF_BLOCK[key as keyof TileInteractions];
    if (kind && def.kind !== kind) {
      findings.error(
        id,
        path,
        `The tile has a ${key} block but its kind is ${def.kind}, so ${resolve.name} ignores the block.`,
      );
      continue;
    }
    if (key === "battler" || resolve(def) !== null) continue;
    if (key === "brain") {
      const reasons = brainErrors(block);
      findings.error(
        id,
        path,
        reasons.length > 0
          ? `The brain does not load: ${reasons.join(" ")}`
          : "The brain does not load: it fails the brain schema, so resolveBrain returns null and the body never thinks.",
      );
      continue;
    }
    findings.error(
      id,
      path,
      `The ${key} block does not load: it fails its schema, so ${resolve.name} returns null and the game ignores it.`,
    );
  }

  checkDroppedParts(raw, def, findings);
  checkBrainAndDialog(def, catalogue, findings);
}

function brainErrors(block: unknown): string[] {
  try {
    return validateBrain(block as Parameters<typeof validateBrain>[0])
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);
  } catch {
    return [];
  }
}

function checkDroppedParts(raw: Entry, def: TileDef, findings: Findings) {
  const id = def.id;
  const blocks = isEntry(raw.interactions) ? raw.interactions : {};

  const battler = resolveBattler(def);
  const rawKit = isEntry(blocks.battler) ? blocks.battler.kit : undefined;
  const kitDropped =
    rawKit !== undefined && (!Array.isArray(rawKit) || rawKit.length > (battler?.kit ?? []).length);
  if (battler && kitDropped) {
    findings.error(
      id,
      "interactions.battler.kit",
      "The kit does not load, so kitSchema's fallback replaces it with an empty kit and the body is born carrying nothing.",
    );
  }

  const craft = resolveCraft(def);
  const rawRecipes = isEntry(blocks.craft) ? list(blocks.craft.recipes) : [];
  if (craft && rawRecipes.length > craft.recipes.length) {
    findings.error(
      id,
      "interactions.craft.recipes",
      `${rawRecipes.length - craft.recipes.length} of ${rawRecipes.length} recipes are left out: a recipe that fails its schema is dropped, and only the first ${MAX_CRAFT_RECIPES} are kept.`,
    );
  }

  const extract = resolveExtract(def);
  const rawSlots = isEntry(blocks.extract) ? list(blocks.extract.slots) : [];
  if (extract && rawSlots.length > extract.slots.length) {
    findings.error(
      id,
      "interactions.extract.slots",
      `${rawSlots.length - extract.slots.length} of ${rawSlots.length} slots are left out: a slot that fails its schema is dropped, and only the first ${MAX_EXTRACT_SLOTS} are kept.`,
    );
  }

  const projectile = resolveProjectile(def);
  const rawHit = isEntry(blocks.projectile) ? blocks.projectile.hit : undefined;
  if (projectile && rawHit != null && !projectile.hit) {
    findings.error(
      id,
      "interactions.projectile.hit",
      "The hit transition does not parse, so the projectile shows nothing when it lands.",
    );
  }
}

function checkBrainAndDialog(def: TileDef, catalogue: Catalogue, findings: Findings) {
  const brain = resolveBrain(def);
  if (brain) {
    for (const issue of validateBrain(brain)) {
      if (issue.severity === "warn") findings.warn(def.id, "interactions.brain", issue.message);
    }
  }

  const dialog = resolveDialog(def);
  if (dialog) {
    const issues = validateDialog(dialog, {
      tilesById: catalogue.tilesById,
      statusIds: new Set(Object.keys(catalogue.statusDefs)),
    });
    for (const issue of issues) {
      const message = `In the dialog, ${issue.message}.`;
      if (issue.severity === "error") findings.error(def.id, "interactions.dialog", message);
      else findings.warn(def.id, "interactions.dialog", message);
    }
  }
}

function checkStatuses(raw: unknown, catalogue: Catalogue, findings: Findings) {
  const seen = new Set<string>();
  list(raw).forEach((entry, index) => {
    const id = entryId(entry, index);
    const status = resolveStatus(entry);
    if (!status) {
      findings.error(id, "", `This status does not load: ${statusFailure(entry)}`);
      return;
    }
    if (seen.has(status.id)) {
      findings.error(id, "id", `A second status has the id "${id}"; statusesById keeps the first.`);
      return;
    }
    seen.add(status.id);
    if (status.id === COMBAT_STATUS_ID) {
      findings.error(
        id,
        "id",
        `"${COMBAT_STATUS_ID}" is built into the game, and statusesById replaces this entry with COMBAT_STATUS.`,
      );
    }

    const formulas: [string, string][] = [["everyMs", status.everyMs.source]];
    if (status.effects.hp) formulas.push(["effects.hp", status.effects.hp.source]);
    for (const key of MODIFIER_KEYS) {
      const formula = status.modifiers[key];
      if (formula) formulas.push([`modifiers.${key}`, formula.source]);
    }
    for (const [path, source] of formulas) {
      for (const named of statusesNamedIn(source)) {
        if (!catalogue.statusDefs[named]) {
          findings.error(
            id,
            path,
            `The formula asks has_status('${named}'), and no status has that id, so it is always 0.`,
          );
        }
      }
    }

    const problem = status.icon ? iconProblem(status.icon, catalogue) : null;
    if (problem) findings.error(id, "icon", problem);
  });
}

function statusFailure(entry: unknown): string {
  if (!isEntry(entry)) return "it is not an object.";
  const formulas: [string, unknown][] = [
    ["everyMs", entry.everyMs],
    ["effects.hp", isEntry(entry.effects) ? entry.effects.hp : undefined],
    ...MODIFIER_KEYS.map((key): [string, unknown] => [
      `modifiers.${key}`,
      isEntry(entry.modifiers) ? entry.modifiers[key] : undefined,
    ]),
  ];
  for (const [path, source] of formulas) {
    if (typeof source === "string" && !parseFormula(source)) {
      return `the ${path} formula "${source}" does not parse, so resolveStatus returns null and nothing can grant it.`;
    }
  }
  return "it fails the status schema, so resolveStatus returns null and nothing can grant it.";
}

type Tally = { tileId: string; what: string; count: number; first: string };

function tally(tallies: Map<string, Tally>, tileId: string, what: string, where: string) {
  const key = JSON.stringify([tileId, what]);
  const counted = tallies.get(key);
  if (counted) counted.count++;
  else tallies.set(key, { tileId, what, count: 1, first: where });
}

function placements(count: number): string {
  return count === 1 ? "1 placement" : `${count} placements`;
}

const UNKNOWN_TILE: Record<string, (tally: Tally) => string> = {
  placed: ({ tileId, count }) => `The map has ${placements(count)} of "${tileId}"`,
  contents: ({ tileId, count }) =>
    `${placements(count)} on the map hold "${tileId}" in their contents`,
  rewardTileIds: ({ tileId, count }) => `${placements(count)} on the map reward "${tileId}"`,
};

function checkMap(map: MapFile, tilesById: Record<string, TileDef>, findings: Findings): number {
  const players = findPlayers(map);
  if (players.length !== 1) {
    const where = players.map((at) => `${at.x},${at.y} L${at.z}`).join(", ");
    findings.warn(
      "player",
      "",
      players.length === 0
        ? "The map has no player tile, so requireSinglePlayer refuses to start the world."
        : `The map has ${players.length} player tiles (${where}), and requireSinglePlayer refuses to start the world unless there is exactly one.`,
    );
  }

  let count = 0;
  const unknown = new Map<string, Tally>();
  for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
    for (const { x, y, stack } of listCoords(map, z)) {
      const where = `${x},${y} L${z}`;
      for (const placed of stack) {
        count++;
        if (!tilesById[placed.tileId]) tally(unknown, placed.tileId, "placed", where);
        for (const held of placed.contents ?? []) {
          if (!tilesById[held.tileId]) tally(unknown, held.tileId, "contents", where);
        }
        for (const tileId of placed.rewardTileIds ?? []) {
          if (!tilesById[tileId]) tally(unknown, tileId, "rewardTileIds", where);
        }
      }
    }
  }
  for (const counted of unknown.values()) {
    findings.warn(
      counted.tileId,
      counted.what === "placed" ? "" : counted.what,
      `${UNKNOWN_TILE[counted.what]!(counted)}, which tiles.json does not define (first at ${counted.first}).`,
    );
  }

  try {
    const unfit = new Map<string, Tally>();
    for (const removed of removeUnfitPlacements(map, tilesById).removed) {
      tally(unfit, removed.tileId, removed.reason, `${removed.x},${removed.y} L${removed.z}`);
    }
    for (const { tileId, what: reason, count: times, first } of unfit.values()) {
      const one = times === 1;
      findings.warn(
        tileId,
        "",
        `The map has ${placements(times)} of "${tileId}" that ${one ? "does" : "do"} not fit where ${one ? "it stands" : "they stand"} (first at ${first}: ${reason}), so removeUnfitPlacements takes ${one ? "it" : "them"} off on the next save.`,
      );
    }
  } catch (error) {
    findings.warn("player", "", messageOf(error));
  }

  return count;
}
