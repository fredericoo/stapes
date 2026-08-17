import * as v from "valibot";
import type { TileDef } from "./types";

/**
 * What it takes to be hit, and to hit back.
 *
 * Authored on the tile def beside the other interaction blocks, and parsed
 * rather than trusted on exactly the terms `push` and `brain` are: a malformed
 * block reads as "not a battler", never as a crashed world.
 *
 * Six numbers, and the reason there are six rather than two is that each one
 * answers a question the others cannot. `atk` and `def` decide how much a
 * connecting blow is worth; `acc` decides how reliably a blow is worth its
 * maximum; `flee` decides whether it connects at all; `spd` decides how often
 * the question is asked. Collapsing any pair would make a creature that is
 * hard to hit and one that shrugs off hits indistinguishable, and those are
 * different animals.
 *
 * Being a battler is not the same as being an actor. A battler is anything with
 * hit points — the player, a cat, and in time a barrel worth smashing. What
 * *drives* it is `./brain`'s question, and a body may perfectly well have one,
 * the other, both or neither.
 */
export type BattlerDef = {
  /** Hit points a fresh instance of this tile starts at. */
  maxHp: number;
  /**
   * The most damage one blow can do, against a foe with no {@link def}.
   * A ceiling rather than an average — see `../game/combat`.
   */
  atk: number;
  /** Flat reduction on every blow that lands. */
  def: number;
  /**
   * 0–100. How reliably a blow is worth its full {@link atk}.
   *
   * 100 is not "always hits" — that is {@link flee}'s business — it is "when it
   * hits, it hits for everything". Below that, damage is drawn from a band that
   * widens downward as accuracy falls.
   */
  acc: number;
  /**
   * 0–100. Dodging, measured against half the attacker's {@link acc}.
   * 50 flee against 50 acc is a 25% dodge.
   */
  flee: number;
  /**
   * 0–100. How often this entity can swing, on a curve rather than a line —
   * see `attackIntervalMs`. 100 is a blow every couple of ticks, 0 is one every
   * few seconds.
   */
  spd: number;
  /**
   * How far a blow reaches, in cells, as a radius rather than a square.
   *
   * Measured in three dimensions with height costing a whole cell per unit —
   * see `../game/distance`, which is also where the odd-looking default is
   * argued. The short version: at {@link DEFAULT_MELEE_RANGE} the sphere is
   * exactly the eight cells around you plus half a level either way, and the
   * numbers that produce that shape have room on both sides.
   *
   * A radius rather than a square because this is the number a bow and a spell
   * will grow out of, and a square that had to become a sphere later would
   * change every authored melee creature on the way past.
   */
  range: number;
  /**
   * Floors this creature bothers to look up and down.
   *
   * **A fact about the creature, not about the world.** Whether anything is in
   * the way is geometry and is asked separately — see `../game/sight`. This is
   * the other half: a rat with `{ up: 0, down: 0 }` standing in the open does
   * not notice you on the ledge above it, not because it cannot see through the
   * air but because it does not look. That is a characterisation, and it is the
   * dial that makes a hawk different from a rat rather than just better at it.
   *
   * Zero by default, so an authored creature minds its own floor until somebody
   * decides otherwise.
   */
  sight: { up: number; down: number };
};

/** Both ends of the 0–100 stats, named so the editor and the schema agree. */
export const MIN_PERCENT_STAT = 0;
export const MAX_PERCENT_STAT = 100;

/**
 * What a tile gets the moment somebody ticks the Battler box.
 *
 * Middling on purpose: the enemy baseline the design calls for is 50 accuracy,
 * and everything else here is chosen so a pair of untouched defaults fight to a
 * conclusion in a few seconds rather than either whiffing forever or one-shotting.
 */
/**
 * Melee: the eight cells around you, half a level up and half a level down.
 *
 * √3 is the corner of that box and 2 is the first cell outside it, so anything
 * in `[1.733, 2)` draws exactly this shape. This is the midpoint of that band in
 * the squared terms the comparison actually runs in — `3.5` between `3` and `4`
 * — which is as far from either wall as the shape allows. See `../game/distance`.
 */
export const DEFAULT_MELEE_RANGE = 1.87;

export const DEFAULT_BATTLER: BattlerDef = {
  maxHp: 20,
  atk: 5,
  def: 0,
  acc: 50,
  flee: 20,
  spd: 40,
  range: DEFAULT_MELEE_RANGE,
  sight: { up: 0, down: 0 },
};

const percent = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_PERCENT_STAT),
  v.maxValue(MAX_PERCENT_STAT),
);

/** Floors of perception, up or down. Whole floors — half a look is not a thing. */
const levelSlack = v.pipe(v.number(), v.integer(), v.minValue(0));

const battlerSchema = v.object({
  // At least one, because a body that starts dead is not a body anybody meant
  // to author — it would be deleted on the frame it was placed.
  maxHp: v.pipe(v.number(), v.integer(), v.minValue(1)),
  atk: v.pipe(v.number(), v.integer(), v.minValue(0)),
  def: v.pipe(v.number(), v.integer(), v.minValue(0)),
  acc: percent,
  flee: percent,
  spd: percent,
  // Both optional, and both authored long after the first creatures were: every
  // tile already on disk parses to the melee default and to minding its own
  // floor, which is what those creatures already did.
  range: v.optional(v.pipe(v.number(), v.minValue(0)), DEFAULT_MELEE_RANGE),
  sight: v.optional(
    v.object({ up: levelSlack, down: levelSlack }),
    // A getter, so two tiles never share one mutable block.
    () => ({ up: 0, down: 0 }),
  ),
});

const battlerCache = new WeakMap<TileDef, BattlerDef | null>();

/**
 * Parsed battler stats for a tile def, or null when it has none.
 *
 * **Gated on the kind.** A tile whose kind is not `battler` has no stats however
 * much of a block is sitting in the file — see {@link TileKind} for why the
 * stored field wins over the block rather than the other way round. Without the
 * gate, the select in the editor and the data on disk could disagree about what
 * a tile is, and the disagreement would only surface as a fight nobody expected.
 *
 * Memoised on def identity, like every other resolver here: this is asked once
 * per body per attack *and* once per body per frame by the renderer drawing
 * health bars, and re-validating six numbers at that rate would be the most
 * expensive thing in either loop.
 */
export function resolveBattler(def: TileDef): BattlerDef | null {
  const cached = battlerCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.kind === "battler" ? def.interactions?.battler : undefined;
  const parsed = raw == null ? null : v.safeParse(battlerSchema, raw);
  const battler = parsed?.success ? (parsed.output as BattlerDef) : null;
  battlerCache.set(def, battler);
  return battler;
}

/** Whether this tile has hit points at all. */
export function isBattler(def: TileDef): boolean {
  return resolveBattler(def) !== null;
}
