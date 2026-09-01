import type { Element } from "./element";
import type { TileInteractions } from "./interactions";
import type { ItemInstance } from "./itemInstance";

export type Direction = "n" | "e" | "s" | "w";

export const DIRECTIONS: Direction[] = ["n", "e", "s", "w"];

/**
 * A bearing on the plan, to the nearest eighth — the four {@link Direction}s
 * plus the four corners between them.
 *
 * **A superset of {@link Direction} rather than a parallel type**, and that
 * containment is what keeps it cheap. A placement still faces one of four ways,
 * because walking is four ways and facing follows walking; an eight-way tile
 * placed on the map is simply asked for the cardinal it is facing, and answers.
 * Nothing about climbing, movement or the editor's facing control had to learn a
 * new vocabulary — only the sprite lookup, which is the one thing that actually
 * varies by eighths.
 *
 * It exists for things that travel on an arbitrary bearing rather than walking
 * on a grid. An arrow is the first: a shot at somebody two cells east and five
 * north is going *somewhere between* north and north-east, and a four-way sprite
 * would draw it pointing at neither. See `./item`'s `ProjectileDef`.
 */
export type Octant =
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "nw";

/**
 * Every bearing, in clockwise screen order starting at north.
 *
 * The order is load-bearing rather than tidy: whatever picks an octant from an
 * angle indexes this, so a list in some other order would rotate every arrow in
 * the game by however far it was shuffled.
 */
export const OCTANTS: Octant[] = [
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
  "nw",
];

/**
 * The cardinal an eighth is nearest to, for a tile that only authored four.
 *
 * A corner is equidistant between the two cardinals it sits between, so the
 * choice is arbitrary and is settled here once — clockwise, so north-east reads
 * as east — rather than being re-guessed by every fallback that needs it. What
 * matters is that it is the *same* arbitrary answer everywhere, since two
 * spellings would make one sprite lookup disagree with another about which way
 * a half-authored tile is facing.
 */
const NEAREST_CARDINAL: Record<Octant, Direction> = {
  n: "n",
  ne: "e",
  e: "e",
  se: "s",
  s: "s",
  sw: "w",
  w: "w",
  nw: "n",
};

export function nearestCardinal(octant: Octant): Direction {
  return NEAREST_CARDINAL[octant];
}

export type CellRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SpriteRef = {
  tilesetId: string;
  /** Rectangle in 8px cells, not pixels. */
  rect: CellRect;
  /** Cell within rect (0..w-1, 0..h-1). Defaults to bottom-right. */
  base: { x: number; y: number };
};

export type LightDef = {
  /** Reach in cells, where attenuation hits zero. */
  radius: number;
  /** 0–1 multiplier on the emitted colour. */
  intensity: number;
  /** Hex, e.g. "#ffcc88". */
  color: string;
};

export type Frame = {
  sprite: SpriteRef;
  durationMs: number;
  /** Absent means this frame does not emit light. */
  light?: LightDef;
};

export type TileSprite = {
  frames: Frame[];
};

/** 0 = flat, 4 = a full level. See {@link HEIGHT_PER_LEVEL}. */
export type TileHeight = 0 | 1 | 2 | 3 | 4;

/**
 * Which axis a tile's art varies along.
 *
 * `directional8` is `directional` with four more keys and no other difference —
 * same field, same lookup, same climb variants, same everything. It is a
 * separate *type* rather than a flag because the editor has to know how many
 * squares to offer and a sprite scan has to know how many keys to walk, and
 * both of those are questions about what the tile is rather than about what
 * happens to be authored on it. A four-way tile with a stray `ne` sprite in the
 * file is a four-way tile.
 */
export type TileType = "simple" | "directional" | "directional8" | "autotile";

export const TILE_TYPES: TileType[] = [
  "simple",
  "directional",
  "directional8",
  "autotile",
];

/**
 * What a tile *is*, as opposed to what it does.
 *
 * The three are mutually exclusive, and that exclusivity is the whole reason
 * this is a stored field rather than something read off the interaction blocks
 * the way {@link resolveActor} reads actorhood. Derived from the blocks,
 * "battler" and "item" would be two independent booleans that can both be true,
 * and there would be no way to say which one a tile is — only which blocks it
 * happens to carry.
 *
 * So the field is authoritative and the blocks are subordinate: `resolveBattler`
 * and `resolveItem` both refuse a tile whose kind is not theirs, even when the
 * block is sitting right there. A stale block left behind by a hand-edit is
 * inert rather than quietly in charge.
 *
 * - `prop` — scenery and machinery. Everything the world is made of: a wall, a
 *   crate, a door, a deer with a brain. Being a prop says nothing about whether
 *   it moves or thinks; see {@link TileDef.actor}, which is orthogonal.
 * - `battler` — has hit points. See `./battler`.
 * - `item` — can be carried. See `./item`.
 */
export type TileKind = "prop" | "battler" | "item";

export const TILE_KINDS: TileKind[] = ["prop", "battler", "item"];

/** Climb / facing key: non-directional use `"default"`; directional use n/e/s/w. */
export type VariantKey = "default" | Direction;

/** Blob autotile slice index (0 = isolated … 46 = full). */
export type AutotileSlice = number;

export const AUTOTILE_SLICE_COUNT = 47;

/**
 * How a tile *looks* right now, as opposed to what it is or where it faces.
 *
 * A second axis beside {@link Direction} and {@link AutotileSlice}, and
 * deliberately the one axis that changes nothing else: a walking deer is
 * exactly as solid, as climbable and as heavy as a standing one. Anything that
 * would change behaviour is a tile swap instead — see
 * {@link SwitchInteraction} — because behaviour is read off the def, and two
 * behaviours need two defs.
 *
 * **A state is read from the actor or the session, never from the placement.**
 * That is what separates it from a swap, and it is a statement about audience
 * before it is one about persistence: the map has one copy that everybody
 * looking at the world sees, so a swap can only express something true for
 * everyone. A door is open, full stop. Whether *you* have already emptied a
 * quest chest is true of you and false of the player beside you, and writing it
 * to the map would have to lie to one of you.
 *
 * - `idle` — the default, and not one state among the rest. It *is* the tile's
 *   sprite; the others are sparse overrides on it. See {@link TileDef.states}.
 * - `moving` — this body is crossing a cell. Read from the snapshot's live
 *   motion, which the client already interpolates. A *fall* is deliberately not
 *   this: the art is a walk cycle, and legs pumping in mid-air read as a joke.
 *   A falling body draws idle until a `falling` state exists to draw it.
 *
 * **Every state in this union must be driven by a renderer.** `attacking` and
 * `open` were designed alongside `moving` and are specified in
 * `plans/stateful-sprites.md`, but they are deliberately absent until the things
 * that drive them exist: a swing on the wire, and a session that knows who has
 * what open. A state nobody draws is a control in the editor that does nothing
 * when you use it, and an authored sprite that never appears is indistinguishable
 * from a bug — so each arrives with its driver, in the same change.
 */
export type SpriteState = "idle" | "moving";

export const SPRITE_STATES: SpriteState[] = ["idle", "moving"];

/** The non-idle states, which are the only ones {@link TileDef.states} keys. */
export type OverrideSpriteState = Exclude<SpriteState, "idle">;

/**
 * The sprites for one state, keyed by whichever axis this tile's
 * {@link TileType} uses.
 *
 * Exactly the three sprite fields {@link TileDef} carries inline, which is the
 * point: a state does not get its own way of being directional. `TileDef` is
 * structurally one of these, so the idle state needs no unwrapping.
 */
export type StateSprites = {
  /** type === "simple" */
  sprite?: TileSprite;
  /**
   * type === "directional" (four keys) or "directional8" (eight).
   *
   * One field for both, because they are one axis at two resolutions: an octant
   * *is* a direction where the two overlap, so a lookup written for four keys
   * reads eight without noticing. Two fields would be two places for a rename to
   * miss, and a tile switched from four ways to eight would lose the art it
   * already had.
   */
  sprites?: Partial<Record<Octant, TileSprite>>;
  /** type === "autotile" — sparse 0..46 */
  slices?: Partial<Record<AutotileSlice, TileSprite>>;
};

export type TileDef = StateSprites & {
  id: string;
  name: string;
  height: TileHeight;
  type: TileType;
  /** What this tile is — see {@link TileKind}. Required; absent reads as prop. */
  kind: TileKind;
  /** Reserved for flammable/wet/frozen/pushable later. */
  attributes: Record<string, never>;
  /**
   * Other tile ids this autotile reads as *itself* when it looks at its
   * neighbours. Only meaningful when `type === "autotile"`.
   *
   * An 8-neighbour mask can only ask "is my neighbour more of me?", which makes
   * two very different absences identical: the empty tile outside a house and
   * the empty tile of a stair well cut through its floor both read as *not
   * floor*. So a floor drawn to tuck itself inside a wall tucks itself around
   * the stair well too, and no amount of art fixes it — the neighbourhood the
   * two cases present is the same neighbourhood. The map is the only thing that
   * knows which absence is which, and this is where it says so.
   *
   * One-directional on purpose. Naming a tile here says how *this* tile reads
   * the world; it does not enlist that tile into reading the world back the
   * same way. Connection that ran both ways would let adding one tile silently
   * change how an existing one draws, somewhere else on the map, with nothing
   * on the changed tile to explain why.
   */
  connectsTo?: string[];
  /**
   * When true, this tile does not occlude light (e.g. water).
   * Default / absent → blocks. Prefer this over deprecated {@link blocksLight}.
   */
  lightPassing?: boolean;
  /**
   * @deprecated Use {@link lightPassing} (inverted). Kept so old tiles.json still loads.
   */
  blocksLight?: boolean;
  /**
   * When true, this tile contributes no physical volume — other tiles and the
   * player can pass through it. Authored {@link height} is kept for lighting
   * and drawing. Default / absent → solid.
   */
  intangible?: boolean;
  /**
   * When true, unsupported tiles fall until they land on something solid.
   * Default / absent → not affected by gravity.
   */
  affectedByGravity?: boolean;
  /**
   * When false, this tile’s top is not a stand / land surface.
   * Default / absent → walkable.
   */
  walkable?: boolean;
  /**
   * When true, a placement of this tile is a *body* — something driven, rather
   * than scenery — even with no brain to say so. Authoring a brain already
   * implies this (see {@link resolveActor}), so the flag is only needed for the
   * mindless body: a prop that gravity moves, a thing with no behaviour of its
   * own. Set it and leave the brain empty for that; author a brain and this
   * follows.
   *
   * Bodies walk, fall and press plates through the same paths the player does;
   * what drives them is a separate question. Placements of a body tile are
   * adopted as actors when the world loads, which is why placing one is the
   * whole of putting an NPC in the map: there is no spawner. The authored
   * `player` tile is the exception — a spawn marker driven by a socket, adopted
   * by tile id and never routed through {@link resolveActor}, so it carries
   * neither this flag nor a brain. Default / absent → scenery.
   */
  actor?: boolean;
  /**
   * Milliseconds this body takes to cross one cell. Absent → the player's pace.
   *
   * The knob that decides whether a creature can be outrun. Everything moving at
   * exactly the player's speed makes a follower impossible to shake and a
   * fleeing animal impossible to catch, since the gap between you can never
   * change.
   *
   * Read through `resolveWalkDurationMs`. Larger is slower.
   */
  walkDurationMs?: number;
  /**
   * World-side dirs you may climb UP toward, keyed by variant.
   * Simple / autotile use `"default"`; directional use `n`/`e`/`s`/`w`
   * for each placement facing. Missing dirs default to true.
   */
  climbFrom?: Partial<Record<VariantKey, Partial<Record<Direction, boolean>>>>;
  /**
   * How this object behaves in play mode — what the player can do to it, and
   * what it does on its own. Absent → inert. Read through `resolvePush` /
   * `resolveSwitch` / `resolvePressurePlate` / `isInteractive` in
   * ./interactions, which validate the on-disk shape.
   */
  interactions?: TileInteractions;
  /**
   * Sprites for the non-idle {@link SpriteState}s, sparse at every level.
   *
   * Overrides rather than a required outer level, so the three sprite fields
   * this type carries inline stay the idle state. That is what makes the whole
   * axis free to add: every tile already on disk is correct as written — it is
   * all-idle — and {@link normalizeTileDef} needs no new branch. Making state a
   * required level would instead rewrite every autotile as 47 slices under
   * `states.idle` and touch every consumer that walks sprites.
   *
   * Sparse *within* a state too: a state that authors only `n` and `s` falls
   * back to idle facing east and west. See `resolveTileSprite`, which owns the
   * order of that fallback.
   */
  states?: Partial<Record<OverrideSpriteState, StateSprites>>;
};

/** Whether this tile’s top is a stand/land surface. Default: true. */
export function resolveWalkable(def: TileDef): boolean {
  return def.walkable !== false;
}

/** Whether this tile has no physical volume. Default: solid (false). */
export function resolveIntangible(def: TileDef): boolean {
  return def.intangible === true;
}

/**
 * Whether a placement of this tile is a body something drives.
 *
 * A brain is the usual way to say yes: authoring what drives a body is authoring
 * that it *is* one, so a tile with a brain is an actor without also ticking a
 * box. The explicit {@link TileDef.actor} flag stays for the rarer body that is
 * driven but mindless — a prop gravity moves, a thing with no behaviour of its
 * own — which has no brain to imply it.
 *
 * The player is neither: it is driven by a connection, adopted by tile id, and
 * never routed through here. That is the one hardcoded exception, and it needs
 * no flag — which is why the authored `player` tile carries none.
 */
export function resolveActor(def: TileDef): boolean {
  return def.actor === true || def.interactions?.brain != null;
}

/**
 * Height that counts for stacking, collision, and standing elevation.
 * Intangible tiles read as 0 so others can pass through; lighting and sprite
 * depth still use authored {@link TileDef.height} — see
 * `../render/depthClump` for how depth sorts what an intangible tile holds.
 */
export function physicalHeight(def: TileDef): number {
  return resolveIntangible(def) ? 0 : def.height;
}

const OPEN_CLIMB: Record<Direction, boolean> = {
  n: true,
  e: true,
  s: true,
  w: true,
};

/**
 * Does this tile's art vary by which way it faces?
 *
 * True of both resolutions, which is what lets everything downstream of facing —
 * climb variants above all — stay written in four cardinals. An eight-way tile
 * is still placed facing one of four ways; only its sprite table is wider.
 */
export function isDirectional(def: TileDef): boolean {
  return def.type === "directional" || def.type === "directional8";
}

/**
 * The sprite keys this tile's art is authored under.
 *
 * The one place the two resolutions are told apart, so a scan that walks every
 * sprite on a def — for animation, for light, for the editor — cannot quietly
 * stop at four keys on a tile that has eight.
 */
export function facingKeysFor(def: TileDef): readonly Octant[] {
  return def.type === "directional8" ? OCTANTS : DIRECTIONS;
}

/** World climb-from flags for a variant; missing dirs default to true. */
export function resolveClimbFrom(
  def: TileDef,
  variant: VariantKey = "default",
): Record<Direction, boolean> {
  const key: VariantKey = isDirectional(def)
    ? variant === "default"
      ? "s"
      : variant
    : "default";
  const flags = def.climbFrom?.[key] ?? def.climbFrom?.default;
  return {
    n: flags?.n !== false,
    e: flags?.e !== false,
    s: flags?.s !== false,
    w: flags?.w !== false,
  };
}

/** Persist climb-from; omit all-open variants and the field when unrestricted. */
export function climbFromForSave(
  def: TileDef,
  byVariant: Partial<Record<VariantKey, Record<Direction, boolean>>>,
): TileDef["climbFrom"] {
  const keys: VariantKey[] = isDirectional(def) ? DIRECTIONS : ["default"];
  const out: NonNullable<TileDef["climbFrom"]> = {};
  let any = false;
  for (const key of keys) {
    const flags = byVariant[key] ?? OPEN_CLIMB;
    if (flags.n && flags.e && flags.s && flags.w) continue;
    const partial: Partial<Record<Direction, boolean>> = {};
    for (const d of DIRECTIONS) {
      if (!flags[d]) partial[d] = false;
    }
    out[key] = partial;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Height units per map level (full stack before overflow).
 *
 * Four rather than two because a level is also a *ceiling*. An interior is
 * exactly one level tall, so unless a body is shorter than a level nothing
 * indoors can ever raise it: a person the height of a storey standing on a
 * stool has their head in the floor above, and `fitsHeightAtElevation` refuses
 * it. At two units the only height below a full level was one — half a level,
 * the height of a rat — so "a person is a little shorter than a storey" was not
 * a thing the world could be told. At four it is: the player is 3, and standing
 * on a 1-unit stool puts its head exactly at the floor above.
 *
 * The cost is paid in pixels. One unit is `PX_PER_HEIGHT` = 2px, so anything a
 * three-high body stands on *under a roof* has to be a single unit. That is the
 * whole of the indoor vocabulary for furniture: what you climb onto is 2px
 * tall, and anything taller is something you walk around instead.
 */
export const HEIGHT_PER_LEVEL = 4;

/** Whether light passes through this tile. Default: blocks (false). */
export function resolveLightPassing(def: TileDef): boolean {
  if (def.lightPassing != null) return def.lightPassing;
  if (def.blocksLight != null) return !def.blocksLight;
  return false;
}

/** @deprecated Use {@link resolveLightPassing}. */
export function resolveBlocksLight(def: TileDef): boolean {
  return !resolveLightPassing(def);
}

export type TilesetDef = {
  id: string;
  name: string;
  file: string;
  width: number;
  height: number;
};

export type PlacedTile = {
  tileId: string;
  direction?: Direction;
  /**
   * Signal channel this placement is wired to. Emitters drive it, receivers
   * follow it, and sharing a name is the whole of the binding — there is no
   * link table and no per-tile identity to keep alive.
   *
   * Absent on all but the handful of wired placements in a map, which is why
   * this is a placement field rather than an id minted for every tile in the
   * world. It must survive any swap of the tile occupying the slot: a plate
   * pressing, a door opening and a crate being shoved are all the same wire.
   *
   * See ../game/signals for how it is read.
   */
  channel?: string;
  /**
   * What this placement says when somebody looks at it.
   *
   * A placement field for the same reason {@link channel} is: what a thing says
   * belongs to the slot, not to the tile filling it. Two signs share one `sign`
   * tile def and read differently, and the text has to outlive every swap of the
   * tile in the slot — a described door that opens is still the same door.
   *
   * The tile's own {@link TileDef.name} is what a look reports without one;
   * this is the line underneath. Absent on all but the few placements anybody
   * has written on.
   */
  description?: string;
  /**
   * What taking this placement's reward marks the player with, and what stops
   * them taking it twice. See `../lib/interactions`'s `RewardInteraction`.
   *
   * A placement field on exactly the terms {@link channel} is, and for the same
   * argument: the tile says *what kind of thing this is* — a chest you open, a
   * person you receive from — and the slot says which particular one. One
   * `quest-chest` tile therefore furnishes a whole map, where a tag on the def
   * would make every chest in the world one reward between them.
   *
   * Sharing a tag between two placements is the whole of making them a choice,
   * exactly as sharing a channel is the whole of wiring two tiles together.
   * There is no quest registry and nothing to keep alive.
   */
  rewardTag?: string;
  /**
   * The tiles this placement hands over, one item each.
   *
   * Beside {@link rewardTag} because they are one authored fact — this chest
   * gives *these* things and marks you *this* way — and neither is any use
   * without the other. Tile ids rather than instances: an instance is minted at
   * the moment of giving, so two players who open one chest come away with two
   * distinct swords rather than one sword that exists twice.
   */
  rewardTileIds?: string[];
  /**
   * Where this placement sends whoever activates it. See `../lib/interactions`'s
   * {@link TeleportInteraction}.
   *
   * A placement field on exactly the terms {@link rewardTag} is, and for the
   * same argument: the tile says *what kind of thing this is* — a portal you
   * step into, a ladder you climb — and the slot says which particular one. One
   * `portal` tile therefore furnishes a whole map, where coordinates on the def
   * would make every portal in the world lead to one room.
   *
   * Read as a cell or as a delta depending on the tile's
   * `TeleportInteraction.destination`; `resolveTeleport` is the one place that
   * decides which, and everything downstream takes the absolute answer.
   */
  teleportTo?: Coord;
  /**
   * Which actor drives this placement, for the handful of tiles that are
   * somebody's avatar rather than scenery.
   *
   * Authored maps never carry one: the map's single `player` tile marks where
   * actors enter, and ownership is assigned at runtime as they join. It is what
   * lets the simulation tell two identical player tiles apart — without it,
   * finding "this connection's actor" would mean guessing between them.
   *
   * Survives a move for free because `moveEntity` spreads the placement rather
   * than rebuilding it field by field.
   */
  owner?: string;
  /**
   * Who conjured this, for the handful of placements somebody cast into being.
   *
   * **A second field rather than a second meaning for {@link owner}**, and the
   * distinction is load-bearing: `owner` means "which actor *drives* this
   * placement" and is what finds a connection's body, so writing a caster into
   * it would make a conjured flame something the simulation tries to walk
   * around and a connection tries to look up. One says whose body this is; this
   * one says whose doing it was.
   *
   * What it buys is attribution: a flame reaches its victim through a status,
   * and the status carries this on so that damage it deals later pays the
   * arcanist who lit it — see `../game/statuses`'s `StatusInstance.causedBy`.
   *
   * A name that no longer belongs to anybody is not an error. The lookup comes
   * back empty and the burning is attributed to nobody, which is what every
   * flame in the world did before this existed.
   *
   * Authored maps never carry one: nothing an author stamps into a map was cast.
   */
  castBy?: string;
  /**
   * What the spell that conjured this was made of, for the placements somebody
   * cast.
   *
   * **The second half of {@link castBy}, and it travels the same road.** That
   * one buys attribution — a flame pays the arcanist who lit it — and this buys
   * the wheel: the status the flame puts on whoever steps in it carries these on
   * as `StatusInstance.elements`, and the damage it does is scaled against
   * whatever that body is attuned to.
   *
   * On the placement rather than on the conjured tile's def, because the element
   * is a fact about the *spell* and not about fire: the same `arcane-flame` tile
   * is what an ember stone and a hearth both leave behind, and only one of those
   * was magic. An authored flame carries none of this and is neutral, which is
   * exactly what every flame in the world did before this existed.
   */
  castElements?: Element[];
  /**
   * Which particular item this placement is, for the placements that are one.
   *
   * A placement field on exactly the terms {@link channel} and
   * {@link description} are: identity belongs to the slot, not to the tile def
   * filling it, and two `rusty-sword` placements are two distinct swords. It is
   * what lets the same thing be followed across being picked up and put down —
   * see `./itemInstance`, which owns both directions of that trip.
   *
   * Minted once when the world loads and never again. Absent on everything that
   * is not an item, which is almost every placement in a map.
   */
  itemId?: string;
  /**
   * How many pulls this resource has left in it, for the placements somebody
   * has already worked.
   *
   * **The shared half of an extract, and it lives here for exactly the reason a
   * container's {@link contents} do**: the checkpoint stores the map and a cell
   * patch carries the placement, so a number written here is the same number for
   * every client and survives the world going quiet with no second store to keep
   * in step. A decay deadline is deliberately *not* kept this way — see
   * `../game/decay` — and the difference is what it means: a deadline is a clock
   * nobody authored, where this is a fact about how much of a thing is left.
   *
   * Absent on everything nobody has touched, which is every placement in an
   * authored map: the tile's `ExtractInteraction.durability` is what a fresh one
   * is worth, and this only appears once somebody has taken from it. Stripped on
   * the way to `data/map.json` on {@link itemId}'s terms — a half-mined vein is
   * a state of play, not something anybody typed.
   *
   * Read through `../lib/interactions`' `extractsLeft`, which is the one place
   * that joins it to the def's count and clamps it to one.
   */
  extractsLeft?: number;
  /**
   * What this container is holding, for the placements that hold anything.
   *
   * Here rather than on a session index because a container on the floor *is*
   * its contents' address: the checkpoint stores the map, an editor save writes
   * the map, and both keep a chest's contents with no second store to keep in
   * step. It rides the cell patch the container itself travels on.
   *
   * Flat, never nested — a container may not hold a container, so this is a list
   * and not a tree. See `./item`.
   */
  contents?: ItemInstance[];
  /**
   * How many things this placement is, for the placements that are a pile.
   *
   * One placement rather than one per thing, which is the whole of "two berries
   * on a tile are two berries in the same tile": a stack is a list of things
   * standing on each other and a pile is not that — nothing is standing on
   * anything, and drawing twelve berry sprites in one cell would say the wrong
   * thing about the cell as well as costing twelve quads.
   *
   * The mirror of {@link ItemInstance.count}, and it has to be: a pile picked up
   * and put down again is the same pile, and a field on one side and not the
   * other is a count that silently becomes one the first time somebody moves it.
   *
   * Absent on everything that is not a pile, which is almost every placement in
   * a map. See `./piles` for the arithmetic and `./item`'s {@link pileMax} for
   * what may carry it at all.
   */
  count?: number;
};

/**
 * Cap on {@link PlacedTile.description}, in characters.
 *
 * A layout bound rather than a safety one — the text is authored in the editor,
 * not typed by a stranger, and it reaches the screen as `textContent`. What it
 * protects is the view: a look label wraps at 60% of the square, so a paragraph
 * would be a wall across the world it is describing.
 */
export const MAX_DESCRIPTION_LENGTH = 240;

/**
 * Cells of one chunk, keyed by {@link coordKey}.
 */
export type ChunkCells = Record<string, PlacedTile[]>;

/**
 * A level's cells, grouped into {@link CHUNK_SIZE} squares keyed by
 * {@link chunkKey}.
 *
 * Grouped rather than flat because the map is copy-on-write: editing one cell
 * copies the record holding it, and a populated floor runs to thousands of
 * cells. Chunking bounds that copy to one chunk, and gives change detection a
 * granularity between "this level" and "this cell" — which is what lets the
 * renderer rebuild the geometry around an edit instead of the whole floor.
 *
 * On disk the format stays flat; {@link parseMap} and {@link serializeMap}
 * convert at the boundary.
 */
export type LevelChunks = Record<string, ChunkCells>;

export type MapFile = {
  version: 1;
  levels: Record<string, LevelChunks>;
};

/** The on-disk shape: cells flat per level, no chunk grouping. */
export type FlatMapFile = {
  version: 1;
  levels: Record<string, Record<string, PlacedTile[]>>;
};

export type Coord = {
  x: number;
  y: number;
  z: number;
};

export const MIN_LEVEL = -8;
export const MAX_LEVEL = 8;
export const CELL_SIZE = 8;
export const CHUNK_SIZE = 16;

/**
 * How far light travels, in cells — the span of the whole lighting model.
 *
 * Sky spill is seeded at this level and every lateral step costs at least 1, so
 * nothing sky-lit reaches further. {@link clampTileLight} then holds authored
 * block emitters to the same number, which makes it the single answer to "how
 * far can light reach from here" rather than one of two.
 *
 * That single answer is what the chunked bake is built on. `LIGHT_APRON` in
 * `./lightingChunks` crops each chunk to its own rect plus this, and the crop is
 * exact only because nothing can reach in from further away. Raising it widens
 * every bake in the world; see that file for what the apron costs.
 *
 * Lives here rather than beside the flood that seeds it because the clamp is
 * applied at normalisation, and `./lightingFlood` imports this module. It is
 * re-exported there, so `MAX_LIGHT_LEVEL` still reads from either.
 */
export const MAX_LIGHT_LEVEL = 15;

export function defaultBase(rect: CellRect): { x: number; y: number } {
  return { x: Math.max(0, rect.w - 1), y: Math.max(0, rect.h - 1) };
}

export function coordKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseCoordKey(key: string): { x: number; y: number } {
  const [xs, ys] = key.split(",");
  return { x: Number(xs), y: Number(ys) };
}

export function levelKey(z: number): string {
  return String(z);
}

export function clampLevel(z: number): number {
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(z)));
}

/** Context for resolving which TileSprite a placement uses. */
export type TileResolveContext = {
  /** How this placement looks right now. Absent → {@link SpriteState} `idle`. */
  state?: SpriteState;
  /**
   * Which way this is facing. An {@link Octant} rather than a {@link Direction},
   * since the two overlap: a placement supplies one of four and something
   * travelling on a bearing supplies one of eight, and the lookup is the same
   * lookup either way. @see resolveTileSprite for what a tile with fewer
   * sprites than the asker has bearings falls back to.
   */
  direction?: Octant;
  /** Required for autotile neighbor matching. */
  map?: MapFile;
  x?: number;
  y?: number;
  z?: number;
  /** Override slice for previews (isolated = 0). */
  autotileSlice?: AutotileSlice;
};

function framesWithLight(frames: Frame[], light?: LightDef): Frame[] {
  if (!light) return frames;
  return frames.map((f) => (f.light ? f : { ...f, light }));
}

function framesToSprite(frames: Frame[] | undefined, light?: LightDef): TileSprite {
  return { frames: framesWithLight(frames ?? [], light) };
}

/**
 * Migrate legacy `directional` + `variants` (+ tile-level `light`) to the
 * type → TileSprite model. Idempotent on already-new tiles.
 */
/**
 * The kind on the wire, or `prop` when there is not a valid one.
 *
 * A default rather than a migration: it does not look at the interaction blocks
 * to guess, because guessing is the two-sources-of-truth problem {@link TileKind}
 * exists to avoid. `data/tiles.json` states every kind outright, and a tile that
 * somehow arrives without one is inert scenery — visibly wrong in the editor,
 * rather than silently in charge of a fight.
 */
function readKind(raw: Record<string, unknown>): TileKind {
  const kind = raw?.kind;
  return typeof kind === "string" && TILE_KINDS.includes(kind as TileKind)
    ? (kind as TileKind)
    : "prop";
}

export function normalizeTileDef(raw: unknown): TileDef {
  const t = raw as Record<string, unknown>;
  if (t && typeof t.type === "string" && TILE_TYPES.includes(t.type as TileType)) {
    const def = raw as TileDef;
    return clampTileLight({
      ...def,
      attributes: def.attributes ?? {},
      kind: readKind(t),
    });
  }

  const legacy = raw as {
    id: string;
    name: string;
    height: TileHeight;
    directional?: boolean;
    variants?: Partial<Record<VariantKey, Frame[]>>;
    attributes?: Record<string, never>;
    light?: LightDef;
  };

  const light = legacy.light;
  const type: TileType = legacy.directional ? "directional" : "simple";

  // Everything that is not part of the old sprite encoding is carried across
  // untouched, rather than copied field by field. Three fields in a row were
  // added to `TileDef` and silently lost here — the enumeration reads as
  // exhaustive and is not, and nothing fails until a creature quietly ignores
  // the flag somebody just authored. Only the keys this function *replaces*
  // need naming, and they are named right here.
  const {
    directional: _wasDirectional,
    variants: _wasVariants,
    light: _wasLight,
    ...carried
  } = raw as Record<string, unknown>;

  const base: TileDef = {
    ...(carried as Omit<TileDef, "type" | "attributes" | "kind">),
    id: legacy.id,
    name: legacy.name,
    height: legacy.height,
    type,
    kind: readKind(raw as Record<string, unknown>),
    attributes: legacy.attributes ?? {},
  };

  if (type === "directional") {
    const sprites: Partial<Record<Direction, TileSprite>> = {};
    for (const d of DIRECTIONS) {
      const frames = legacy.variants?.[d];
      if (frames) sprites[d] = framesToSprite(frames, light);
    }
    return clampTileLight({ ...base, sprites });
  }

  return clampTileLight({
    ...base,
    sprite: framesToSprite(legacy.variants?.default, light),
  });
}

export function normalizeTiles(raw: unknown[]): TileDef[] {
  return raw.map(normalizeTileDef);
}

/**
 * A sprite whose frames all emit within {@link MAX_LIGHT_LEVEL}, or the sprite
 * itself when they already do.
 *
 * Identity is preserved on the common path deliberately: every tile on disk is
 * already inside the cap, so a load that rewrote each one would allocate a whole
 * new object graph to change nothing.
 */
function clampSpriteLight(sprite: TileSprite): TileSprite {
  if (!sprite.frames.some((f) => f.light && f.light.radius > MAX_LIGHT_LEVEL)) {
    return sprite;
  }
  return {
    ...sprite,
    frames: sprite.frames.map((f) =>
      f.light && f.light.radius > MAX_LIGHT_LEVEL
        ? { ...f, light: { ...f.light, radius: MAX_LIGHT_LEVEL } }
        : f,
    ),
  };
}

/** {@link clampSpriteLight} across the three sprite fields a state can hold. */
function clampStateLight<T extends StateSprites>(state: T): T {
  const out = { ...state };
  if (out.sprite) out.sprite = clampSpriteLight(out.sprite);
  if (out.sprites) {
    out.sprites = Object.fromEntries(
      Object.entries(out.sprites).map(([k, v]) => [
        k,
        v ? clampSpriteLight(v) : v,
      ]),
    ) as typeof out.sprites;
  }
  if (out.slices) {
    out.slices = Object.fromEntries(
      Object.entries(out.slices).map(([k, v]) => [
        k,
        v ? clampSpriteLight(v) : v,
      ]),
    ) as typeof out.slices;
  }
  return out;
}

/**
 * Hold every emitter on a tile to {@link MAX_LIGHT_LEVEL}.
 *
 * `LightDef.radius` is a plain number, and the tile editor's input has a minimum
 * and no maximum, so nothing upstream of here stops a 25 being typed or hand-
 * edited into `tiles.json`. Left alone, that lamp lights the chunk it stands in
 * and goes dark in the next one along: the chunked bake crops to `LIGHT_APRON`
 * cells of margin and simply never reads an emitter beyond it. Nothing throws,
 * no test fails, and the light swells into existence as you walk back towards
 * it.
 *
 * The cap could instead have been paid for — measure the widest authored radius
 * and crop to that — and it is the wrong trade. The apron is charged on *every*
 * bake, so one wide tile takes a 32-cell chunk from baking 3.8x its own area to
 * 12x it, everywhere in the world, whether or not that tile is anywhere near.
 * A ceiling equal to the model's own span costs nothing instead, and it is not
 * an arbitrary one: a block emitter reaching further than sky spill does is
 * already outside what the rest of the lighting is built to describe.
 *
 * **Applied at normalisation, which is the only door in.** Every tile reaches
 * the game through `DataStore.readTiles` → {@link normalizeTiles} → here — dev
 * disk and R2 alike, editor saves included, since a save is written and then
 * read back through the same path. Clamping the editor's input alone would
 * leave the hand-edited file and the seeded bucket as ways back to the bug.
 *
 * Silent rather than rejected. This is one author's own content and a save that
 * failed over a light radius would be worse than a light that stops at the
 * distance the editor already shows as its ceiling.
 */
function clampTileLight(def: TileDef): TileDef {
  const out = clampStateLight(def);
  if (!out.states) return out;
  return {
    ...out,
    states: Object.fromEntries(
      Object.entries(out.states).map(([k, v]) => [
        k,
        v ? clampStateLight(v) : v,
      ]),
    ) as typeof out.states,
  };
}

/** The TileSprites one {@link StateSprites} holds, on this tile's own axis. */
function stateSpritesOn(tile: TileDef, from: StateSprites): TileSprite[] {
  if (tile.type === "simple") {
    return from.sprite ? [from.sprite] : [];
  }
  if (isDirectional(tile)) {
    return facingKeysFor(tile)
      .map((d) => from.sprites?.[d])
      .filter((s): s is TileSprite => s != null);
  }
  if (!from.slices) return [];
  return Object.values(from.slices).filter((s): s is TileSprite => s != null);
}

/**
 * All TileSprites on a def, across every {@link SpriteState} (for animation /
 * light scans).
 *
 * Every state, not only idle, and that is load-bearing rather than tidy: this
 * feeds `tileCanEmitLight`, `maxLightRadius` and `tileLightVaries`, so a lantern
 * that only glows while it is being carried would otherwise be left out of the
 * bake — lit on screen and dark in the lighting, with nothing failing to say so.
 */
export function allTileSprites(tile: TileDef): TileSprite[] {
  const out = stateSpritesOn(tile, tile);
  for (const state of Object.values(tile.states ?? {})) {
    if (state) out.push(...stateSpritesOn(tile, state));
  }
  return out;
}

export function isAnimated(tile: TileDef): boolean {
  return allTileSprites(tile).some((s) => s.frames.length > 1);
}

/** True if any frame on any sprite can emit light. */
export function tileCanEmitLight(tile: TileDef): boolean {
  return allTileSprites(tile).some((s) =>
    s.frames.some(
      (f) => f.light && f.light.radius > 0 && f.light.intensity > 0,
    ),
  );
}

function frameLightKey(light: LightDef | undefined): string {
  return light ? `${light.radius},${light.intensity},${light.color}` : "";
}

/** True if a sprite emits differently from one frame to the next. */
function spriteLightVaries(sprite: TileSprite): boolean {
  if (sprite.frames.length < 2) return false;
  const first = frameLightKey(sprite.frames[0]!.light);
  return sprite.frames.some((f) => frameLightKey(f.light) !== first);
}

/**
 * True when this tile's emission changes as it animates — a torch that
 * flickers rather than a lamp that simply burns.
 *
 * The bake keys off this, and the distinction is what keeps flicker affordable:
 * a tile whose frames all emit the same is baked once and holds for good, while
 * this one has to be baked once per phase of its cycle. Treating every animated
 * emitter as varying would charge that to ordinary lamps for no visible change.
 */
export function tileLightVaries(tile: TileDef): boolean {
  return allTileSprites(tile).some(spriteLightVaries);
}

/**
 * Where in its emission cycle this tile is at `timeMs`, as a comparable string.
 *
 * Two placements of a tile with the same phase emit the same light, so this is
 * what a cache can hold baked light against — a flicker returning to a phase it
 * has already been at costs a lookup rather than a bake.
 *
 * Only variants whose light actually varies contribute: a directional torch
 * that flickers facing south and burns steadily facing north should not have
 * the south frames re-baked because the north sprite ticked over.
 */
export function tileEmissionPhase(tile: TileDef, timeMs: number): string {
  let phase = "";
  for (const sprite of allTileSprites(tile)) {
    if (!spriteLightVaries(sprite)) continue;
    phase += `${frameIndexAtTime(sprite.frames, timeMs)},`;
  }
  return phase;
}

/**
 * Furthest this tile's light can reach, in cells, over every variant and frame.
 *
 * The bound has to hold across variants rather than for the placement's current
 * one: a lamp swapping to its lit form, or a directional torch turning, changes
 * which frame is live, and the cells that stop being lit are as dirty as the
 * ones that start. Zero when the tile never emits.
 */
export function maxLightRadius(tile: TileDef): number {
  let max = 0;
  for (const sprite of allTileSprites(tile)) {
    for (const frame of sprite.frames) {
      const light = frame.light;
      if (!light || light.intensity <= 0) continue;
      if (light.radius > max) max = light.radius;
    }
  }
  return max;
}

export function frameAtTime(frames: Frame[], timeMs: number): Frame | undefined {
  if (frames.length === 0) return undefined;
  if (frames.length === 1) return frames[0];
  const total = frames.reduce((sum, f) => sum + Math.max(1, f.durationMs), 0);
  let t = ((timeMs % total) + total) % total;
  for (const f of frames) {
    const d = Math.max(1, f.durationMs);
    if (t < d) return f;
    t -= d;
  }
  return frames[frames.length - 1];
}

export function frameIndexAtTime(frames: Frame[], timeMs: number): number {
  if (frames.length === 0) return 0;
  if (frames.length === 1) return 0;
  const total = frames.reduce((sum, f) => sum + Math.max(1, f.durationMs), 0);
  let t = ((timeMs % total) + total) % total;
  for (let i = 0; i < frames.length; i++) {
    const d = Math.max(1, frames[i].durationMs);
    if (t < d) return i;
    t -= d;
  }
  return frames.length - 1;
}

// resolveTileSprite / getFrames / resolveLight live in ./tileResolve
// (needs autotile without a circular import).
