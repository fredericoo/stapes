import type { Equipment } from "../app/game/equipment";
import { equipDestination, isBodySlot, type SlotRef } from "../app/game/itemMoves";
import type { BattlerDef } from "../app/lib/battler";
import { resolveContainer } from "../app/lib/item";
import type { ItemInstance } from "../app/lib/itemInstance";
import { resolveLight } from "../app/lib/tileResolve";
import type { TileDef } from "../app/lib/types";
import type { EquipSlot } from "../app/game/affordances";
import { isLit } from "./arcane";
import { bestUpgrade, gearSlots, stoneHanded, type Taste } from "./gear";

export type Dressing =
  | { readonly kind: "move"; readonly from: SlotRef; readonly to: SlotRef; readonly tileId: string }
  | { readonly kind: "drop"; readonly from: SlotRef; readonly tileId: string };

/** How the bot judges what it carries. */
export type Judge = {
  readonly body: BattlerDef;
  readonly taste: Taste;
  /** Things never thrown away: money, anything an NPC buys, anything saved for, stones. */
  readonly keeps: (tileId: string) => boolean;
  /** Things never worn as a light, though they glow: the money. */
  readonly spends: (tileId: string) => boolean;
  /** Moves that failed lately, by tile id, which are not tried again yet. */
  readonly refused: (tileId: string) => boolean;
};

type Carried = { readonly from: SlotRef; readonly instance: ItemInstance };

/**
 * The next thing a bot should do with what it carries, or null. A light
 * comes first, whenever nothing worn gives one and no worn stone makes one,
 * so a bot carries light wherever it goes. Then the best upgrade it carries goes on, the old piece
 * coming off into its place; a bag held in a hand is emptied into the one on
 * its back; and gear that is worse than what it wears, and that nobody buys,
 * is dropped, because a bag holds four things.
 */
export function nextDressing(
  equipment: Equipment,
  tilesById: Record<string, TileDef>,
  judge: Judge,
): Dressing | null {
  const carried = carriedLoose(equipment);
  const usable = carried.filter(({ instance }) => !judge.refused(instance.tileId));

  const { body, taste } = judge;
  if (!isLit(equipment, tilesById, taste.statusDefs, body.masteries)) {
    for (const { from, instance } of usable) {
      if (judge.spends(instance.tileId) || !givesLight(instance, tilesById)) continue;
      const to = equipDestination(equipment, tilesById, instance);
      if (to && equipment[to.kind] === null) {
        return { kind: "move", from, to, tileId: instance.tileId };
      }
    }
  }

  let best: { dressing: Dressing; gain: number } | null = null;
  for (const { from, instance } of usable) {
    const def = tilesById[instance.tileId];
    const heldIn = isBodySlot(from) ? from.kind : null;
    const upgrade = def && bestUpgrade(def, equipment, tilesById, body, taste, heldIn);
    if (!upgrade || upgrade.gain <= 0) continue;
    if (!best || upgrade.gain > best.gain) {
      const to = { kind: upgrade.slot };
      best = { dressing: { kind: "move", from, to, tileId: instance.tileId }, gain: upgrade.gain };
    }
  }
  if (best) return best.dressing;

  const emptying = emptyHandBag(equipment, tilesById);
  if (emptying) return emptying;

  const stoneHands = stoneHanded(equipment, tilesById, taste, body.masteries);
  for (const { from, instance } of carried) {
    if (judge.keeps(instance.tileId) || (instance.contents?.length ?? 0) > 0) continue;
    const def = tilesById[instance.tileId];
    if (!def || gearSlots(def, taste.style, stoneHands).includes(from.kind as EquipSlot)) continue;
    const upgrade = bestUpgrade(def, equipment, tilesById, body, taste);
    if (upgrade && upgrade.gain <= 0) return { kind: "drop", from, tileId: def.id };
  }
  return null;
}

/**
 * Everything carried but not worn in its own square: the bag's contents and
 * whatever either hand holds, which is where a trade puts what it gives once
 * the bag is full.
 */
function carriedLoose(equipment: Equipment): Carried[] {
  const out: Carried[] = (equipment.bag?.contents ?? []).map((instance, index) => ({
    from: { kind: "contents", index },
    instance,
  }));
  for (const hand of ["weapon", "offhand"] as const) {
    const held = equipment[hand];
    if (held) out.push({ from: { kind: hand }, instance: held });
  }
  return out;
}

/**
 * A bag bought while one was worn lands in a hand; once it is on the back,
 * the old one is in that hand with everything in it. Its things move across
 * one at a time, and the empty bag is then worse than the worn one and is
 * dropped as gear nobody needs.
 */
function emptyHandBag(equipment: Equipment, tilesById: Record<string, TileDef>): Dressing | null {
  const worn = equipment.bag;
  const wornDef = worn ? tilesById[worn.tileId] : undefined;
  const room =
    (wornDef ? (resolveContainer(wornDef)?.size ?? 0) : 0) - (worn?.contents?.length ?? 0);
  if (room <= 0) return null;
  for (const hand of ["weapon", "offhand"] as const) {
    const contents = equipment[hand]?.contents ?? [];
    const index = contents.length - 1;
    const instance = contents[index];
    if (!instance) continue;
    return {
      kind: "move",
      from: { kind: "contents", index, of: hand },
      to: { kind: "contents", index: worn?.contents?.length ?? 0 },
      tileId: instance.tileId,
    };
  }
  return null;
}

function givesLight(instance: ItemInstance, tilesById: Record<string, TileDef>): boolean {
  const def = tilesById[instance.tileId];
  return def !== undefined && resolveLight(def, { direction: instance.direction }) !== undefined;
}
