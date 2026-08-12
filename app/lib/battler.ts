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
export const DEFAULT_BATTLER: BattlerDef = {
  maxHp: 20,
  atk: 5,
  def: 0,
  acc: 50,
  flee: 20,
  spd: 40,
};

const percent = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_PERCENT_STAT),
  v.maxValue(MAX_PERCENT_STAT),
);

const battlerSchema = v.object({
  // At least one, because a body that starts dead is not a body anybody meant
  // to author — it would be deleted on the frame it was placed.
  maxHp: v.pipe(v.number(), v.integer(), v.minValue(1)),
  atk: v.pipe(v.number(), v.integer(), v.minValue(0)),
  def: v.pipe(v.number(), v.integer(), v.minValue(0)),
  acc: percent,
  flee: percent,
  spd: percent,
});

const battlerCache = new WeakMap<TileDef, BattlerDef | null>();

/**
 * Parsed battler stats for a tile def, or null when it has none.
 *
 * Memoised on def identity, like every other resolver here: this is asked once
 * per body per attack *and* once per body per frame by the renderer drawing
 * health bars, and re-validating six numbers at that rate would be the most
 * expensive thing in either loop.
 */
export function resolveBattler(def: TileDef): BattlerDef | null {
  const cached = battlerCache.get(def);
  if (cached !== undefined) return cached;

  const raw = def.interactions?.battler;
  const parsed = raw == null ? null : v.safeParse(battlerSchema, raw);
  const battler = parsed?.success ? (parsed.output as BattlerDef) : null;
  battlerCache.set(def, battler);
  return battler;
}

/** Whether this tile has hit points at all. */
export function isBattler(def: TileDef): boolean {
  return resolveBattler(def) !== null;
}
