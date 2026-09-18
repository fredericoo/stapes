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
 * **`hit` sits on the same moment as `disappear` rather than being a fourth
 * one.** A flight ends exactly once, and both of these describe that ending —
 * `disappear` is the projectile going, which it does however the fight went,
 * and `hit` is the blow landing, which is a separate claim about the same
 * instant. They are played together rather than chosen between; see
 * {@link landingPlays}.
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
   * only side that is not already {@link TileDef.transitions}. Absent plays
   * nothing: `disappear` is already playing on every landing, so there is
   * nothing for this to fall back to — see {@link landingPlays}.
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
 * **Each side answers for itself, and `hit` no longer falls back.** It used to
 * borrow `disappear` when nothing was authored, because a landing played
 * exactly one side and the fallback was what stopped a connected shot ending
 * in silence. A landing plays both now — see {@link landingPlays} — so the
 * fallback would draw the same effect twice on every blow that lands.
 *
 * `appear` and `disappear` are read off the tile's own transitions, so a
 * projectile authored in the Effects tab needs nothing here to know about it.
 * `hit` is the projectile block's, because it is the only one of the three that
 * is a claim about the fight.
 */
export function projectileEffect(
  def: TileDef | undefined,
  side: ProjectileSide,
): Transition | undefined {
  if (!def) return undefined;
  if (side === "hit") return resolveProjectile(def)?.hit ?? undefined;
  return def.transitions?.[side];
}

/**
 * The sides a landing plays, in the order they are begun.
 *
 * **`disappear` always, and `hit` as well when the blow connected.** A flight
 * ends exactly once, and the two sides answer different questions about that
 * moment: `disappear` is *the projectile going*, which it does however the
 * fight went, and `hit` is *the blow landing*, which is a thing that either
 * happened or did not.
 *
 * They used to be mutually exclusive — a landing picked one — and that made an
 * author choose between the two rather than describe both. A fireball that
 * dissolves as it stops and throws sparks where it connects had to be written
 * as one or the other, and a miss got whichever was left.
 *
 * Nothing falls the other way: a `hit` authored alone still leaves a miss with
 * no sparks, which is correct, because a miss that borrowed them would be the
 * picture saying a shot landed that did not.
 */
export function landingPlays(connected: boolean): ProjectileSide[] {
  return connected ? ["disappear", "hit"] : ["disappear"];
}

/** Every tile that can be fired, for a picker to offer. */
export function projectileTiles(tiles: readonly TileDef[]): TileDef[] {
  return tiles.filter((tile) => tile.kind === "projectile");
}
