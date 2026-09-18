import * as v from "valibot";
import {
  resolveTransition,
  type Transition,
  type TransitionSide,
} from "./tileTransition";
import type { TileDef } from "./types";

/**
 * A thing that is only ever in the air: how fast it goes, and what it does
 * where it lands.
 *
 * ## A kind of tile, and the fourth one
 *
 * A projectile is a tile whose {@link TileDef.kind} is `projectile`, on exactly
 * the terms a battler and an item are their own kinds: the field is
 * authoritative and the block is subordinate, so {@link resolveProjectile}
 * refuses a tile whose kind is not its own even when the block is sitting right
 * there.
 *
 * **A tile, because a projectile is art before it is anything else.** It needs
 * the eight bearings a flight is drawn on, the animation frames, the sheet and
 * anchor they are measured from, the height its depth box is built from, and
 * whether it carries a light — which is the whole of why an arcane bolt lights
 * the yard it crosses without anything here knowing what light is. Every one of
 * those is what a tile already is, and a second home for them would be the
 * second art pipeline `CLAUDE.md` says not to grow.
 *
 * The light took a second piece of work to be true, and the sentence above was
 * written before it: a flight is not a placement and not an actor, so neither
 * of the two things that make light ever saw one. It is painted now as an
 * emitter override, through the door a torch in a bag goes through — see
 * `../render/projectileMotion`'s `flightLight`.
 *
 * What the kind buys on top of that is the thing it is for: a `projectile` tile
 * is the only one whose editor offers a speed and a hit effect, and no wall or
 * crate grows a field it can never use.
 *
 * ## Exclusive with `item`, and the shard is why
 *
 * The arcane shard is the coin the shopkeeper trades in — an `artifact` that
 * piles to 99 — so it cannot also be the thing a stone throws. What flies is
 * `arcane-bolt`, which looks like a shard and is not one. That split is the
 * mutual exclusivity of {@link TileDef.kind} doing its job rather than working
 * around it: a tile is one thing, and "currency" and "ammunition" are two.
 *
 * ## Three sides, and two of them are already yours
 *
 * A flight plays `appear` when it is loosed and, where it stops, either `hit`
 * or `disappear`. The first two are the tile's own {@link TileDef.transitions},
 * which every tile has already — `appear` and `disappear` mean here what they
 * mean there, a thing arriving and a thing going, and a flight arrives when it
 * is loosed and goes when it lands. Only {@link ProjectileBlock.hit} is new,
 * because only it is a claim about the fight.
 *
 * ## Purely a picture, and the one field that is not
 *
 * Nothing here decides what a blow comes to. The one field the simulation reads
 * is {@link ProjectileBlock.cellsPerSecond}, and what it decides is *when*: how
 * long the drawing lasts, and — the same number — how long the blow it depicts
 * waits before it takes anybody's health. See `../game/projectile`, which argues
 * why the outcome is still settled on the tick the shot is loosed even though
 * its consequences are not.
 *
 * So an author editing this speed is editing the game's timing as well as its
 * art: an arrow at one cell a second is nearly a second of a six-cell shot
 * during which the target has not been hit yet.
 */

/**
 * Which moment of a flight an effect belongs to.
 *
 * **`hit` is a variant of `disappear` rather than a fourth moment.** A flight
 * ends exactly once and ends one of two ways, so the two are mutually exclusive
 * by construction: what plays where it lands is `hit` when the blow connected
 * and `disappear` when it did not.
 */
export type ProjectileSide = TransitionSide | "hit";

/**
 * How fast a projectile may travel, in cells per second.
 *
 * The floor is not zero: a speed of zero is an arrow that never arrives and a
 * flight that never ends, which is a hang rather than a slow shot. One cell a
 * second is as slow as anything could want to be and still be going somewhere —
 * and it is slow enough to be a real cost, since a flight holds the world's tick
 * loop open for as long as it lasts.
 *
 * The ceiling is a thousand, which crosses the widest authorable reach inside a
 * single tick. Anything past that is a shot nobody sees at all and may as well
 * have no projectile authored.
 */
export const MIN_PROJECTILE_SPEED = 1;
export const MAX_PROJECTILE_SPEED = 1000;

/**
 * What a fresh projectile travels at, in cells per second.
 *
 * **Read against the two speeds already in the game.** A body walks a cell every
 * `WALK_DURATION_MS`, which is five cells a second, and a melee lean is out and
 * back in 150ms. Twenty is four times walking pace and crosses a six-cell reach
 * in about three hundred milliseconds — near enough to the length of one swing
 * that a shot reads as a blow struck rather than as an object drifting across
 * the yard.
 *
 * The first value here was three and three quarter cells a second, written in a
 * unit that hid it. An arrow slower than the archer could walk is the failure
 * this constant exists to make impossible to write by accident.
 */
export const DEFAULT_PROJECTILE_SPEED = 20;

/** What a `projectile` tile authors beyond its art. */
export type ProjectileBlock = {
  /**
   * How fast it travels, in cells per second.
   *
   * A speed rather than a duration, so a long shot takes longer than a short
   * one — which is the only thing in the animation carrying any information
   * about distance. A fixed duration would make a shot crossing six cells look
   * exactly like one crossing two, at wildly different apparent speeds.
   *
   * **And it is felt, not only seen.** The blow waits out the flight, so this
   * is what makes a lobbed stone hurt later than a loosed arrow across the same
   * yard. @see `../game/projectile`
   *
   * **On the projectile rather than on what fires it**, which is what moved
   * when this became a kind. Three bows used to state it three times, and the
   * war bow's 24 against the other two's 20 was a difference only a reader
   * comparing the three blocks could find — a twentieth of a second over a
   * six-cell shot. One arrow, one speed, one place to change it.
   */
  cellsPerSecond: number;
  /**
   * Played where it lands, on a landing that connected.
   *
   * The one thing a projectile says about the fight it came out of, and the
   * only side that is not already {@link TileDef.transitions}. Absent falls
   * back to `disappear` — see {@link projectileEffect}.
   */
  hit?: Transition;
};

const projectileSchema = v.object({
  cellsPerSecond: v.pipe(
    v.number(),
    v.minValue(MIN_PROJECTILE_SPEED),
    v.maxValue(MAX_PROJECTILE_SPEED),
  ),
  // Parsed on its own and dropped rather than refused, exactly as a tile's two
  // sides are: a projectile whose burst is malformed should still fly, because
  // the alternative is a weapon that stops firing over its art.
  hit: v.optional(v.unknown()),
});

/**
 * A tile's projectile block, or null.
 *
 * **Gated on the kind**, on exactly the terms `resolveBattler` and
 * `resolveItem` are: a block left behind on a tile that is no longer a
 * projectile is inert rather than quietly in charge.
 *
 * Null is also the answer for a tile that simply is not one, which is what
 * makes "name anything and fail gracefully" true: a weapon pointed at a crate
 * looses nothing, and nothing anybody wrote has to say so.
 */
export function resolveProjectile(
  def: TileDef | undefined,
): ProjectileBlock | null {
  if (!def || def.kind !== "projectile") return null;
  const parsed = v.safeParse(projectileSchema, def.interactions?.projectile);
  if (!parsed.success) return null;
  const hit = resolveTransition(parsed.output.hit);
  return {
    cellsPerSecond: parsed.output.cellsPerSecond,
    ...(hit ? { hit } : {}),
  };
}

/**
 * What to play at one end of a flight, or nothing.
 *
 * **`hit` falls back to `disappear`**, which is the whole of what makes the
 * third side an addition rather than a rearrangement: an author who wants a
 * fireball to dissolve wherever it stops writes one block and gets it on both
 * outcomes, and an author who wants the landing that *connected* to look
 * different writes the second. Nothing falls the other way — a `hit` authored
 * alone leaves a miss silent, which is correct, because a miss that borrowed
 * the hit's sparks would be the picture saying a shot landed that did not.
 *
 * `appear` and `disappear` are read off the tile's own transitions, so a
 * projectile authored in the Effects tab needs nothing here to know about it.
 */
export function projectileEffect(
  def: TileDef | undefined,
  side: ProjectileSide,
): Transition | undefined {
  if (!def) return undefined;
  if (side === "hit") {
    return resolveProjectile(def)?.hit ?? def.transitions?.disappear;
  }
  return def.transitions?.[side];
}

/** Which side a landing plays. @see projectileEffect */
export function landingSide(connected: boolean): ProjectileSide {
  return connected ? "hit" : "disappear";
}

/** Every tile that can be fired, for a picker to offer. */
export function projectileTiles(tiles: readonly TileDef[]): TileDef[] {
  return tiles.filter((tile) => tile.kind === "projectile");
}
