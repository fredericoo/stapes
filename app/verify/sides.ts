import { type ArenaFighter, fighterForTile } from "../game/arena";
import { equipmentForBody } from "../game/battlerKit";
import { slotTakes } from "../game/itemMoves";
import { Rng } from "../game/rng";
import { resolveBattler } from "../lib/battler";
import { EQUIP_SLOTS, type EquipSlot } from "../lib/kit";
import { type Mastery, MASTERIES, MAX_MASTERY, MIN_MASTERY } from "../lib/mastery";
import type { TileDef } from "../lib/types";

export type Kit = "rolled" | "none";

export const KITS: readonly Kit[] = ["rolled", "none"];

export type Subject = "A" | "B";

export const SUBJECTS: readonly Subject[] = ["A", "B"];

export function opponent(subject: Subject): Subject {
  return subject === "A" ? "B" : "A";
}

export type SideSpec = {
  text: string;
  tileId: string;
  masteries: Partial<Record<Mastery, number>>;
  equipment: Partial<Record<EquipSlot, string | null>>;
};

export class SideError extends Error {}

const EMPTY_SLOT = "none";

export function parseSide(text: string, tilesById: Record<string, TileDef>): SideSpec {
  const colon = text.indexOf(":");
  const tileId = colon === -1 ? text : text.slice(0, colon);
  const def = tilesById[tileId];
  if (!def) throw new SideError(`"${tileId}" is not a tile in tiles.json.`);
  if (!resolveBattler(def)) {
    throw new SideError(
      `"${tileId}" has no battler block that loads, so it has nothing to fight with.`,
    );
  }

  const spec: SideSpec = { text, tileId, masteries: {}, equipment: {} };
  const pairs = colon === -1 ? [] : text.slice(colon + 1).split(",");
  for (const pair of pairs.map((each) => each.trim()).filter(Boolean)) {
    const [key = "", value = ""] = pair.split("=").map((part) => part.trim());
    if (MASTERIES.includes(key as Mastery)) {
      const level = Number(value);
      if (value === "" || !Number.isInteger(level) || level < MIN_MASTERY || level > MAX_MASTERY) {
        throw new SideError(
          `${key} takes a whole number from ${MIN_MASTERY} to ${MAX_MASTERY}, not "${value}".`,
        );
      }
      spec.masteries[key as Mastery] = level;
    } else if (EQUIP_SLOTS.includes(key as EquipSlot)) {
      spec.equipment[key as EquipSlot] =
        value === EMPTY_SLOT ? null : slotTile(key, value, tilesById);
    } else {
      throw new SideError(
        `"${key}" is neither a mastery (${MASTERIES.join(", ")}) nor an equipment slot (${EQUIP_SLOTS.join(", ")}).`,
      );
    }
  }
  return spec;
}

function slotTile(slot: string, tileId: string, tilesById: Record<string, TileDef>): string {
  const def = tilesById[tileId];
  if (!def) throw new SideError(`"${tileId}" is not a tile in tiles.json.`);
  if (!slotTakes(slot as EquipSlot, def)) {
    throw new SideError(`The ${slot} slot does not take "${tileId}".`);
  }
  return tileId;
}

/**
 * A kit is rolled from a stream of its own, salted by side, so rolling one never
 * moves the dice the fight is fought with, and the two sides of a mirror match
 * roll different kits.
 */
const KIT_SALT: Record<Subject, number> = { A: 0x6b1e5a1d, B: 0x2f9c33e7 };

export function fighterOn(
  spec: SideSpec,
  subject: Subject,
  seed: number,
  kit: Kit,
  tilesById: Record<string, TileDef>,
): ArenaFighter {
  const base = fighterForTile(spec.tileId, tilesById);
  const equipment = { ...base.equipment };
  if (kit === "rolled") {
    const rng = new Rng((seed ^ KIT_SALT[subject]) >>> 0);
    const rolled = equipmentForBody(spec.tileId, tilesById, () => rng.next());
    for (const slot of EQUIP_SLOTS) equipment[slot] = rolled[slot]?.tileId ?? null;
  }
  return {
    tileId: spec.tileId,
    masteries: { ...base.masteries, ...spec.masteries },
    equipment: { ...equipment, ...spec.equipment },
  };
}

/** The bag is left out: nothing in a fight reads it, and it is in almost every kit. */
export function loadoutOf(fighter: ArenaFighter): string {
  const held = EQUIP_SLOTS.flatMap((slot) => {
    const tileId = fighter.equipment[slot];
    return tileId && slot !== "bag" ? [`${slot} ${tileId}`] : [];
  });
  return held.length > 0 ? held.join(", ") : "nothing held or worn";
}
