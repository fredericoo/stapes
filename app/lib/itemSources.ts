import { resolveBattler } from "./battler";
import { resolveDialog, walkCommands } from "./dialog";
import { resolveCraft, resolveDecay, resolveExtract, type CraftOutput } from "./interactions";
import { isItem } from "./item";
import type { TileDef } from "./types";

export type ExchangeSide = { tileId: string; count: number; chance: number | null };

/** `take` is what the player hands over and `give` what they receive. */
export type Exchange = {
  kind: "trade" | "craft";
  at: string;
  name: string | null;
  take: ExchangeSide[];
  give: ExchangeSide[];
};

export type FindKind = "start" | "gather" | "drop" | "decay";

export type Find = { kind: FindKind; from: string; chance: number };

export type ItemSources = {
  finds: Find[];
  obtained: Exchange[];
  usedIn: Exchange[];
};

export function itemSources(
  tiles: readonly TileDef[],
  playerTileId: string,
): Map<string, ItemSources> {
  const sources = new Map<string, ItemSources>();
  for (const tile of tiles) {
    if (isItem(tile)) sources.set(tile.id, { finds: [], obtained: [], usedIn: [] });
  }

  const exchanges = new Map<string, Exchange>();
  for (const tile of tiles) {
    for (const exchange of exchangesAt(tile)) {
      exchanges.set(JSON.stringify(exchange), exchange);
    }
  }
  for (const exchange of exchanges.values()) {
    for (const tileId of new Set(exchange.give.map((side) => side.tileId))) {
      sources.get(tileId)?.obtained.push(exchange);
    }
    for (const tileId of new Set(exchange.take.map((side) => side.tileId))) {
      sources.get(tileId)?.usedIn.push(exchange);
    }
  }

  for (const tile of tiles) {
    const kind: FindKind =
      tile.id === playerTileId ? "start" : resolveExtract(tile) ? "gather" : "drop";
    for (const [tileId, chance] of findsAt(tile)) {
      sources.get(tileId)?.finds.push({ kind, from: tile.id, chance });
    }
    const decay = resolveDecay(tile);
    if (decay && isItem(tile)) {
      sources.get(decay.tileId)?.finds.push({ kind: "decay", from: tile.id, chance: 100 });
    }
  }
  for (const entry of sources.values()) {
    entry.finds.sort((a, b) => FIND_ORDER[a.kind] - FIND_ORDER[b.kind] || b.chance - a.chance);
  }
  return sources;
}

const FIND_ORDER: Record<FindKind, number> = { start: 0, gather: 1, drop: 2, decay: 3 };

function exchangesAt(tile: TileDef): Exchange[] {
  const out: Exchange[] = [];
  const dialog = resolveDialog(tile);
  if (dialog) {
    for (const { command } of walkCommands(dialog)) {
      if (command.kind !== "request_trade") continue;
      out.push({
        kind: "trade",
        at: tile.id,
        name: null,
        take: command.take.map((side) => ({ ...side, chance: null })),
        give: command.give.map((side) => ({ ...side, chance: null })),
      });
    }
  }
  const craft = resolveCraft(tile);
  if (craft) {
    for (const recipe of craft.recipes) {
      out.push({
        kind: "craft",
        at: tile.id,
        name: recipe.name.trim() || null,
        take: recipe.inputs.map((input) => ({ ...input, chance: null })),
        give: craftGives(recipe.output),
      });
    }
  }
  return out;
}

function craftGives(output: CraftOutput): ExchangeSide[] {
  if (output.kind === "all") {
    return output.items.map((item) => ({
      tileId: item.tileId,
      count: 1,
      chance: item.chance >= 100 ? null : item.chance,
    }));
  }
  const total = output.items.reduce((sum, item) => sum + item.weight, 0);
  return output.items.map((item) => ({
    tileId: item.tileId,
    count: 1,
    chance: total > 0 && item.weight < total ? (item.weight / total) * 100 : null,
  }));
}

/**
 * The chance of coming away with at least one of each item, so a kit naming
 * raw meat twice at 100% and 33% reads as one certain find, and a bag's
 * contents count only as often as the bag itself is carried.
 */
function findsAt(tile: TileDef): Map<string, number> {
  const misses = new Map<string, number>();
  const roll = (tileId: string, percent: number) => {
    const hit = Math.min(1, Math.max(0, percent / 100));
    misses.set(tileId, (misses.get(tileId) ?? 1) * (1 - hit));
  };

  const extract = resolveExtract(tile);
  if (extract) for (const slot of extract.slots) roll(slot.tileId, slot.chance);

  const battler = resolveBattler(tile);
  for (const entry of battler?.kit ?? []) {
    roll(entry.tileId, entry.chance);
    for (const content of entry.contents ?? []) {
      roll(content.tileId, (entry.chance * content.chance) / 100);
    }
  }

  const finds = new Map<string, number>();
  for (const [tileId, miss] of misses) {
    if (miss < 1) finds.set(tileId, (1 - miss) * 100);
  }
  return finds;
}
