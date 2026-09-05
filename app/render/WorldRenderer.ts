import * as THREE from "three";
import { tilesetUrl } from "../lib/api";
import {
  absoluteElevation,
  baseCellWorldOrigin,
  CELL_CENTRE,
  type DepthBox,
  DEPTH_LEAST_BODY,
  depthBox,
  depthStackBias,
  spriteWorldOrigin,
} from "../lib/geometry";
import {
  overlayEmitterOverridesPacked,
  VOID_BACKGROUND,
  type EmitterOverride,
  type PackedLevelLight,
  type PackedLightGrid,
} from "../lib/lighting";
import { sampleIllumination } from "../lib/clock";
import {
  changedCellsInChunk,
  changedCellsOnLevel,
  chunkKeyFor,
  getChunk,
  getStack,
  stackHeight,
  terrainHeight,
} from "../lib/mapData";
import {
  chunkAddressKey,
  parseChunkAddress,
  visibleChunkKeys,
} from "./meshWindow";
import {
  type RoofCut,
  cutHides,
  cutHidesWholeLevel,
} from "../lib/levelVisibility";
import { countOf } from "../lib/piles";
import { cutMaskFor } from "./cutMask";
import type {
  Frame,
  MapFile,
  PlacedTile,
  SpriteState,
  TileDef,
  TilesetDef,
} from "../lib/types";
import {
  CELL_SIZE,
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  coordKey,
  cellPhaseMs,
  frameIndexAtTime,
  levelKey,
  parseCoordKey,
  resolveActor,
  resolveLightPassing,
  tileCanEmitLight,
  tileEmissionPhase,
  tileLightVaries,
} from "../lib/types";
import { hasSpriteStates, isMobileTile } from "../lib/interactions";
import { clumpExtents } from "./depthClump";
import { getFrames, resolveTileSprite } from "../lib/tileResolve";
import {
  ChunkedLighting,
  LIGHT_WINDOW_MARGIN,
  type WorldRect,
} from "../lib/lightingChunks";
import {
  canBakeOffThread,
  WorkerChunkBaker,
} from "../lib/lightBakerClient";
import type { FramePhase, FrameProfiler } from "./frameProfile";
import type { ProjectileView } from "./projectileMotion";
import { GpuLighting } from "./gpuLighting";
import { PalettePass } from "./palettePass";
import {
  type LevelCutUniforms,
  type LevelLightUniforms,
  type Quad,
  WORLD_SHADER_CACHE_KEY,
  buildMergedQuadGeometry,
  buildSingleQuadGeometry,
  injectWorldShader,
  type LevelAnimUniforms,
  noAnimUniforms,
  noCutUniforms,
  writeBoxAttr,
  writeLightUvAttr,
} from "./worldQuads";
import { AnimationTable, tableCanHold } from "./animTable";
import {
  disposeGroupChildren,
  makeFollowingSpriteOutline,
  makeSpriteGhost,
  makeSpriteOutline,
  OutlineMaterials,
  OUTLINE_ALPHA_UNIFORM,
  pulseAlphaAt,
} from "./overlayMeshes";
import {
  NO_PILE_OFFSET,
  pileDepthNudge,
  pileOffsets,
  pileRings,
} from "./pileLayout";
import { animationKey, type SpriteQuadAssets, spriteQuadFor } from "./spriteQuad";
import { noTintUniforms, tintCacheKey, tintUniforms } from "./spriteTint";
import type { StatusTint } from "../lib/statusVfx";
import { ParticleLayer } from "./particleLayer";
import type { ParticleEmitterSpec } from "./particles";
import {
  appendVisibleTileEmitters,
  tileEmitterId,
  tileEmitterPrefix,
} from "./tileEmitters";
import { PLAYER_TILE_ID } from "../game/constants";

/**
 * A separate mesh whose sprite changes over time — because it animates, because
 * its {@link SpriteState} can change, or both.
 *
 * One registry for both rather than two, because they are the same operation
 * seen at two speeds: point this mesh at a different {@link Frame}. A state
 * change is only unusual in that it also replaces the list being indexed, which
 * is why `def` and the cell ride along — enough to re-resolve without going back
 * to the map for the placement.
 */
type AnimatedInstance = {
  mesh: THREE.Mesh;
  /** Instance key, so a cell's animated meshes can be dropped without a sweep. */
  key: string;
  frames: Frame[];
  tileset: TilesetDef;
  animKey: string;
  /** What resolved {@link frames}, so a state change can resolve them again. */
  def: TileDef;
  placed: PlacedTile;
  cell: { x: number; y: number; z: number };
  /** The state {@link frames} were resolved for. */
  state: SpriteState;
  /**
   * Index into {@link frames} the mesh's UVs currently show.
   *
   * Held per instance rather than inferred from the shared per-key index,
   * because a mesh can be younger than the key: a step rebuilds the walker's
   * mesh, and the rebuilt one starts at whatever frame the build wrote, not at
   * whatever frame the key last ticked to.
   */
  frameIdx: number;
};

/**
 * How high in its level's band an arrow sorts against coplanar surfaces.
 *
 * Above anything a real stack reaches — stacks are single digits and the band is
 * 64 wide — because an arrow drawn at exactly a floor's height is over that
 * floor rather than inside it. Well under the band, so it can never bleed into
 * the level above's. @see depthStackBias
 */
const PROJECTILE_STACK_BIAS = 32;

/** One arrow's mesh and everything needed to keep drawing it. */
type ProjectileMesh = {
  mesh: THREE.Mesh;
  /** Held for its height, which is the depth box's thickness. */
  def: TileDef;
  /**
   * The bearing's frames, resolved once.
   *
   * Once is enough because a flight's bearing never changes — see
   * `./projectileMotion` — so nothing can make this list go stale for as long as
   * the arrow is in the air.
   */
  frames: Frame[];
  tileset: TilesetDef;
  texture: THREE.Texture;
  /** Which frame the UVs currently show; -1 until the first is written. */
  frameIdx: number;
  /** The level whose material it is wearing. */
  z: number;
  /** The sprite footprint, so the centre can be found without the rect again. */
  w: number;
  h: number;
};

/** One quad the builder will emit, plus what decides how it is drawn. */
type BuildItem = Quad & {
  texture: THREE.Texture;
  /** Set when this tile gets its own mesh rather than joining a merged batch. */
  tileKey?: string;
  anim?: Omit<AnimatedInstance, "mesh" | "key">;
  /**
   * The animation this quad plays from inside the merged batch, before the
   * level's table has given it a row.
   *
   * The row is assigned in {@link WorldRenderer.buildLevel} rather than here so
   * that {@link WorldRenderer.cellItems} stays a pure function of the map: the
   * incremental path calls it twice on the same cell to compare, and a call
   * that quietly grew the level's table would make the two comparisons differ
   * by having been run.
   */
  mergedAnim?: { frames: Frame[]; tileset: TilesetDef; phaseMs: number };
  /**
   * The plume this placement gives off, on the one quad that stands for it.
   *
   * Ridden in on the build item rather than gathered in a sweep of its own,
   * because the emitter needs the placement's foot elevation and its depth box
   * and {@link WorldRenderer.cellItems} has just worked both of those out. A
   * second walk would be a second copy of the elevation arithmetic, and the two
   * would drift.
   *
   * A pile draws one quad per thing in it and emits once, so this is set on the
   * first offset only. @see WorldRenderer.tileEmittersByLevel
   */
  emitter?: ParticleEmitterSpec;
};

/** Shared empties, so the common frame allocates nothing to say "none". */
const EMPTY_EMITTERS: readonly ParticleEmitterSpec[] = [];
const EMPTY_TINTS: ReadonlyMap<string, StatusTint> = new Map();

const LIGHT_MAP_CELL_OFFSET = 0.5;

/** Map cell + stack slot identifying a placed tile instance. */
export type TileInstanceKey = {
  x: number;
  y: number;
  z: number;
  stackIndex: number;
};

/**
 * The string one placement is addressed by across every per-frame index —
 * motions, sprite states, separate meshes, ghosts.
 *
 * Exported because {@link WorldView.spriteStates} and
 * {@link WorldView.tileMotions} are both keyed by it and both are filled in by
 * the caller: two spellings of this would mean a state map whose keys silently
 * match nothing, with no type error and no missing sprite to notice — just a
 * deer that never animates.
 */
export function tileInstanceKey(k: TileInstanceKey): string {
  return `${k.z}:${k.x},${k.y}:${k.stackIndex}`;
}

/**
 * The level out of an instance key.
 *
 * Beside the function it inverts, and NaN-guarded, because the whole hazard of a
 * string key is that the two halves drift apart in different files: a parser
 * living next to the builder is one edit away from staying right, and one that
 * silently returned NaN would fetch a material against a level nothing else uses
 * and light the sprite by a room that does not exist.
 */
export function tileInstanceLevel(key: string): number {
  const z = Number.parseInt(key, 10);
  return Number.isNaN(z) ? 0 : z;
}

/**
 * Where a moving tile's solid volume is right now, in fractional cells and
 * absolute height units. A tile mid-step straddles two cells, so its box has
 * to travel with the sprite rather than snap between the cells it occupies.
 */
export type MotionBox = {
  x: number;
  y: number;
  foot: number;
  top: number;
  /** Separates the mover from whatever floor plane its feet are resting on. */
  stackBias: number;
};

/**
 * Per-frame motion for a placed tile (walk/fall lerp, push, etc.).
 * Not player-specific — any tile can move.
 */
export type TileMotion = TileInstanceKey & {
  ox: number;
  oy: number;
  box: MotionBox;
  /**
   * Also draw under this level while moving. Used when descending so the
   * mover stays visible after roof-cut hides the origin level group.
   */
  alsoDrawAtZ?: number;
};

export type WorldView = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  camera: { x: number; y: number };
  zoom: number;
  /** Minutes past midnight — drives ambient + clear colour. */
  minutesOfDay: number;
  /** Active lerps; each carries the depth box its sprite currently occupies. */
  tileMotions?: TileMotion[];
  /**
   * Arrows in the air, positioned for this frame. @see `./projectileMotion`
   *
   * Not a {@link TileMotion}, and the difference is that a motion moves a
   * *placement* — it is keyed by the slot it offsets, and there is a tile on the
   * board underneath it. A projectile is on no cell and in no stack: there is
   * nothing for it to be an offset of.
   */
  projectiles?: ProjectileView[];
  /**
   * How each placement looks right now, keyed by {@link TileInstanceKey}, and
   * holding only the entries that are *not* {@link SpriteState} `idle`.
   *
   * Sparse on purpose, on the same terms {@link tileMotions} is: almost nothing
   * in a map is ever in a non-idle state, and an absent key is the answer for
   * all of it. The caller decides what a state means — walking, mid-swing, open
   * — because that is a reading of the session, which this renderer has no
   * access to and no business guessing at.
   */
  spriteStates?: ReadonlyMap<string, SpriteState>;
  /**
   * Fractional cell-space emit positions for tiles mid-walk/fall so cast
   * light tracks sprite motion. Logical `x,y,z` must match the map cell.
   */
  emitterOverrides?: EmitterOverride[];
  /**
   * The geometry the view has cut away — the structure the player can see
   * into, not a whole storey. Omit to draw everything (editor / preview).
   */
  roofCut?: RoofCut;
  /**
   * The colour each placement is wearing, keyed by {@link TileInstanceKey}.
   *
   * Sparse, on the terms {@link spriteStates} is: almost nobody is ever under
   * anything, and an absent key is the answer for all of them.
   *
   * **Only reaches placements that have their own mesh** — every actor, and
   * nothing that is merged into its floor's batch. A tint is a material uniform
   * (see `./spriteTint`), and a merged tile shares its material with the whole
   * floor, so tinting one would tint the ground it is standing on. A key naming
   * a merged tile is dropped rather than approximated.
   */
  spriteTints?: ReadonlyMap<string, StatusTint>;
  /**
   * The plumes on screen this frame.
   *
   * Reconciled by id rather than replaced, so a plume that moved is the same
   * plume and keeps its particles — see `./particles`. A plume that stops being
   * listed is retired and its last sparks are allowed to finish.
   */
  particleEmitters?: readonly ParticleEmitterSpec[];
};

/** Silhouette outline around one placed tile, drawn over the finished frame. */
export type ObjectOutlineOverlay = TileInstanceKey & {
  kind: "objectOutline";
  color: number;
  /**
   * Breathe rather than sit still, for an outline that marks a decision the
   * player made rather than something the pointer happens to be over.
   *
   * A property of the outline and not of what it is around, because the same
   * body is outlined both ways within a second of each other — hovered, then
   * chosen — and the difference between those two readings is exactly this.
   */
  pulse?: boolean;
};

/**
 * A tile drawn where it *would* go, translucent, over a cell it is not in.
 *
 * The one overlay that is not about something already on the board, which is
 * why it names a tile rather than a stack slot: there is no placement to point
 * at yet, and the whole question is whether there is about to be one.
 *
 * It lands on top of whatever is in the cell, because that is where a dropped
 * thing goes — the ghost is drawn by the same rule that will place it.
 */
export type TileGhostOverlay = {
  kind: "ghost";
  tileId: string;
  x: number;
  y: number;
  z: number;
  alpha: number;
};

export type OverlaySpec = ObjectOutlineOverlay | TileGhostOverlay;

function overlaySpecKey(spec: OverlaySpec): string {
  if (spec.kind === "ghost") {
    return `g:${spec.tileId}@${spec.x},${spec.y},${spec.z}:${spec.alpha}`;
  }
  // Nothing about how the tile *looks* is in here — not the frame, not the pose,
  // not where the lerp has carried it. An outline follows the mesh it was cut
  // around (see {@link WorldRenderer.outlineFor}), so the only things that can
  // make it the wrong mesh are which tile it is on and what colour it wears.
  //
  // The pulse is in the key but the *phase* deliberately is not: a breathing
  // outline is one mesh whose uniform is written per frame, so keying on how lit
  // it is right now would rebuild the whole chrome layer sixty times a second.
  return `o:${spec.x},${spec.y},${spec.z},${spec.stackIndex}:${spec.color}${spec.pulse ? "~" : ""}`;
}

/**
 * Stable cache key for fractional emitter overrides (~0.01 cell).
 *
 * The lights are in it because an override that carries its own is not
 * answerable from the map: two people standing in one spot, one of them holding
 * a lantern, are the same six numbers and a different room.
 */
function emitterOverridesKey(
  overrides: EmitterOverride[] | undefined,
): string {
  if (!overrides?.length) return "";
  return overrides
    .map((o) => {
      const at = `${o.x},${o.y},${o.z}:${o.fx.toFixed(2)},${o.fy.toFixed(2)},${o.fz.toFixed(2)}`;
      if (!o.lights) return at;
      const lit = o.lights
        .map((l) => `${l.radius},${l.intensity},${l.color}`)
        .join(",");
      return `${at}*${lit}`;
    })
    .join("|");
}

/**
 * Tiles the static bake leaves out, painted per frame by the overlay instead.
 *
 * Derived from the tile set rather than named, so a second character — or a
 * hundred — is omitted automatically. A hardcoded `{player}` was correct only
 * for as long as exactly one thing moved.
 *
 * Both conditions are load-bearing, and both are *narrow*. **Actor** is the
 * rule, not "mobile": the overlay paints an override per actor per frame, so an
 * actor is exactly the population that gets painted back. **Light-passing** is
 * what makes omitting it sound: the overlay is add-only, so it can paint a light
 * the bake left out but cannot carve a shadow the bake never knew about.
 * Omitting an occluder would light straight through it. A mobile tile that
 * blocks light therefore stays baked and pays for its movement — see the note in
 * docs/notes.md before changing that.
 *
 * **It used to say `isMobileTile`, and that let a lit thing vanish.** A lantern
 * is affected by gravity and passes light, so it was omitted from the bake — and
 * nothing paints an override at a cell nobody is standing in, so a lantern lying
 * on the floor lit nothing at all. Omitting a tile is only ever worth it for
 * something that moves *every frame*; a dropped item moves on the tick it lands
 * and dirties a cell doing it, which is a cost it was always going to pay.
 *
 * **The player is named rather than derived, and it has to be.** It is driven by
 * a connection and adopted by tile id, so {@link resolveActor} deliberately
 * refuses it — see the note there. Deriving this set from actorhood alone
 * therefore returned an empty set on the shipped tile catalogue and quietly
 * stopped omitting the one body that moves every single frame, which put a ~22ms
 * rebake on every step the player took.
 */
export function dynamicLightTileIds(
  tilesById: Record<string, TileDef>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const def of Object.values(tilesById)) {
    // Light-passing is the load-bearing half and is checked first: omitting an
    // occluder would light straight through it, whoever it belongs to.
    if (!resolveLightPassing(def)) continue;
    if (resolveActor(def) || def.id === PLAYER_TILE_ID) ids.add(def.id);
  }
  return ids;
}


/**
 * Changed cells on one level past which they stop being examined one by one.
 *
 * Deciding whether an edit moved the *merged* batch costs two
 * {@link cellItems} rebuilds per cell, over the cell and its autotile ring. A
 * tick of ordinary play changes a couple of dozen cells across the world and is
 * worth asking about, because the answer is almost always "no" and the reward
 * is swapping one sprite instead of rebuilding a chunk. A paint stroke or a
 * level load changes hundreds, and there the question costs more than
 * rebuilding the chunks outright. Set well above what gameplay produces and
 * well below what an edit does.
 */
const MAX_ANALYSED_CELLS = 64;

/** The cells themselves plus their 8 neighbours — an autotile's whole input. */
function withNeighbourRing(cells: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const key of cells) {
    const { x, y } = parseCoordKey(key);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) out.add(coordKey(x + dx, y + dy));
    }
  }
  return out;
}

/**
 * Every tile id that some autotile in the catalogue reads as a neighbour.
 *
 * An autotile picks its slice from an eight-way mask, and `stackConnects` fills
 * that mask by matching a neighbour's placements against the autotile's own id
 * and its `connectsTo` list — nothing else in a stack is looked at. So a change
 * to a cell that touches none of these ids cannot restyle anything around it,
 * however much else about the cell moved.
 *
 * Which is the difference between a cheap frame and an expensive one, because
 * the change a tick actually produces is creatures walking: a rat is not in any
 * autotile's vocabulary, so its step needs no ring at all.
 */
function autotileVocabulary(tilesById: Record<string, TileDef>): Set<string> {
  const out = new Set<string>();
  for (const def of Object.values(tilesById)) {
    if (def.type !== "autotile") continue;
    out.add(def.id);
    for (const id of def.connectsTo ?? []) out.add(id);
  }
  return out;
}

/** The placements of a stack that any autotile would notice, in order. */
function autotileInputOf(
  stack: readonly PlacedTile[] | undefined,
  vocabulary: ReadonlySet<string>,
): string {
  if (!stack || stack.length === 0) return "";
  let sig = "";
  for (const placed of stack) {
    if (vocabulary.has(placed.tileId)) sig += placed.tileId + "|";
  }
  return sig;
}

/**
 * One chunk's geometry, and everything built alongside it.
 *
 * Held together rather than spread across four indexes keyed the same way,
 * because they are created and destroyed as a unit: a chunk leaving the window
 * has to take its meshes, its animated instances, its plumes *and* its entries
 * in the renderer-wide movable registry with it, and the failure when one of
 * those is forgotten is a stale key pointing at disposed geometry.
 */
type ChunkGeometry = {
  group: THREE.Group;
  z: number;
  chunk: string;
  animated: AnimatedInstance[];
  emitters: ParticleEmitterSpec[];
  /**
   * The {@link movableMeshes} keys this chunk installed.
   *
   * Recorded rather than recovered by prefix, because the prefix of a movable
   * key is its *cell* and what is being dropped is a chunk: finding them any
   * other way means walking the registry, which holds every mesh in the built
   * world.
   */
  movableKeys: Set<string>;
};

/** Do two windows name the same cells? Four compares on the common frame. */
function sameRect(a: WorldRect | null, b: WorldRect): boolean {
  return (
    a !== null && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
  );
}

function disposeObject3D(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
    }
  });
}

/**
 * Shared map world draw — preview-style (all levels opaque, no editor chrome).
 * Driven imperatively; no editor store.
 */
export class WorldRenderer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private world: THREE.Group;
  private overlayScene: THREE.Scene;
  private overlays: THREE.Group;
  /** null forces a rebuild; "" is the valid signature of an empty overlay set. */
  private overlaySig: string | null = null;
  /**
   * Materials of the outlines that breathe, and the clock they breathe on.
   *
   * The clock is the renderer's rather than each mesh's, so a target replaced
   * mid-cycle — a walking one is rebuilt on every frame it moves — picks the new
   * outline up at the phase the old one was leaving, instead of snapping back to
   * a full stop.
   */
  private pulsingOutlines: THREE.ShaderMaterial[] = [];
  /**
   * The outline materials, kept across rebuilds so the shader is compiled once
   * for the life of the page rather than once per rebuild — see
   * {@link OutlineMaterials}. Rebuilds are frequent: every step a target takes
   * and every row the pointer crosses is one.
   */
  private outlineMaterials = new OutlineMaterials();
  /** Outlines borrowing a world mesh, and the mesh each one is around. */
  private followingOutlines: { outline: THREE.Mesh; source: THREE.Mesh }[] = [];
  private pulseElapsedMs = 0;
  private textures = new Map<string, THREE.Texture>();
  private materials = new Map<string, THREE.MeshBasicMaterial>();
  private tilesets: TilesetDef[] = [];
  private tilesetById = new Map<string, TilesetDef>();
  private tilesById: Record<string, TileDef> = {};
  /**
   * One group per level, holding that level's built chunks.
   *
   * Kept as the parent of the chunk groups rather than replaced by them,
   * because the roof-cut's whole-storey arm is `group.visible = false` on one
   * object — a cut that hides a floor should skip that floor's draw calls with
   * one flag, not with a walk of however many chunks happen to be built.
   */
  private levelGroups = new Map<number, THREE.Group>();
  /**
   * The geometry that exists right now, one entry per built chunk.
   *
   * Keyed by {@link chunkAddressKey}. This is the whole of what makes the
   * renderer's cost track the window rather than the world: a chunk outside the
   * window has no entry, no group and no quads, and comes into being on the
   * frame the camera reaches for it. @see meshWindow
   */
  private chunkGeometry = new Map<string, ChunkGeometry>();
  /**
   * The window the built set was last decided against, so a frame in which
   * neither the map nor the camera moved costs one comparison.
   */
  private meshedWindow: WorldRect | null = null;
  /**
   * Every emitting placement on the board, by level.
   *
   * Derived from the built chunks rather than maintained beside them — see
   * {@link refreshTileEmitters} — because the geometry's unit is the chunk and
   * this one's is the level, which is the shape `appendVisibleTileEmitters`
   * culls in.
   *
   * Every built chunk, not the window: what is built is already a window, and
   * the per-frame cull is a finer question than this index answers.
   */
  private tileEmittersByLevel = new Map<number, ParticleEmitterSpec[]>();
  /**
   * Whether {@link tileEmittersByLevel} still agrees with the built chunks.
   *
   * The index is per level because that is the shape `appendVisibleTileEmitters`
   * culls in, and the geometry is per chunk, so the two are reconciled — lazily,
   * on the next frame that asks for emitters. Plumes are a handful in the whole
   * world, so rebuilding the index outright is cheaper than keeping it in step
   * edit by edit.
   */
  private tileEmittersStale = false;
  /**
   * The plumes handed to the particle system this frame, refilled in place.
   *
   * One array reused rather than a fresh one per frame: this is written on every
   * frame that has a plume in it, and an array per frame at 120fps is a
   * collection in the middle of the frame budget for a list that is usually
   * three entries long.
   */
  private readonly visibleEmitters: ParticleEmitterSpec[] = [];
  private animated: AnimatedInstance[] = [];
  private animatedByKey = new Map<string, AnimatedInstance[]>();
  /** @see WorldView.spriteStates — held so the map build can read it. */
  private spriteStates: ReadonlyMap<string, SpriteState> | undefined;
  /** Separate meshes that can receive {@link TileMotion} offsets (anim or in-motion). */
  private movableMeshes = new Map<string, THREE.Mesh>();
  /**
   * The arrows currently in the air, by flight id.
   *
   * Held between frames rather than rebuilt, for the reason the overlay layer is
   * *not*: an arrow moves every single frame of its life, so a signature-gated
   * rebuild would allocate and throw away a mesh thirty times a second. What
   * changes per frame is a position, a depth box and a light sample — three
   * attribute writes — which is exactly what a walking sprite already costs.
   */
  private projectileMeshes = new Map<string, ProjectileMesh>();
  /**
   * Every arrow, in one group under {@link world} rather than one per level.
   *
   * **Deliberately outside the level groups, which is the one thing that makes
   * this survive a map edit.** A level group is destroyed and rebuilt whenever
   * its floor changes, and a mesh parented in one would be disposed underneath
   * the map that still holds it — a torn-down geometry drawn on the next frame.
   * Nothing is lost by staying out: depth is resolved per fragment from the box
   * each quad carries, so group membership decides nothing about sorting. The
   * one thing it did decide is roof-cut visibility, and that is a line of code
   * here instead — see {@link applyProjectiles}.
   */
  private projectileGroup: THREE.Group;
  private movableBasePos = new Map<string, { x: number; y: number }>();
  private movableBaseBox = new Map<
    string,
    { box: DepthBox; stackBias: number }
  >();
  /**
   * Extra draw of a descending mover under {@link TileMotion.alsoDrawAtZ}.
   * Geometry is cloned (not shared) so level dispose cannot free the source.
   */
  private motionGhosts = new Map<string, THREE.Mesh>();
  /** Last roof-cut — level groups created mid-frame need it. */
  private roofCut: RoofCut | undefined;
  /**
   * The cut, per level, as the shader reads it.
   *
   * Held beside {@link lightUniformsByZ} and for the same reason: materials bind
   * uniforms by reference, so writing the level's own object reaches every
   * material on that floor without touching any of them.
   */
  private cutUniformsByZ = new Map<number, LevelCutUniforms>();
  /** Per level, the uniforms its materials read the animation table through. */
  private animUniformsByZ = new Map<number, LevelAnimUniforms>();
  /** Per level, the table itself — kept to free its texture and to time frames. */
  private animTablesByZ = new Map<number, AnimationTable>();
  /** Mask textures owned here, so a replaced one is freed rather than leaked. */
  private cutTextures = new Map<number, THREE.DataTexture>();
  private animClock = 0;
  private lastAnimTime = 0;
  private frameIndices = new Map<string, number>();
  private disposed = false;
  private magentaTex: THREE.DataTexture;
  private whiteTex: THREE.DataTexture;
  private lightTextures = new Map<number, THREE.DataTexture>();
  private lightUniformsByZ = new Map<number, LevelLightUniforms>();
  private lightingKey = "";
  private staticLightGrid: PackedLightGrid | null = null;
  /** Latest tint, so a level whose uniforms appear later still gets it. */
  private pendingAmbient: [number, number, number] | null = null;
  private gpuLighting = new GpuLighting();
  private lighting = new ChunkedLighting({}, dynamicLightTileIds({}));
  /** Null under SSR and tests, where the bake stays on the calling thread. */
  private lightBaker: WorkerChunkBaker | null = null;
  /** Tile defs the light cache was built against; new defs void every chunk. */
  private lightingTilesById: Record<string, TileDef> | null = null;
  /**
   * Actor bodies whose *own* light changes as they animate — a creature that
   * glows in pulses rather than steadily. Empty in every map so far, and cheap
   * to keep that way: their phase joins the overlay's cache key, and an empty
   * list contributes nothing to it.
   *
   * Only bodies. A light in somebody's bag is resolved before it ever reaches
   * this renderer and travels by value on the override, so
   * {@link emitterOverridesKey} already sees it change.
   */
  private flickeringDynamicDefs: TileDef[] = [];
  /** @see setLightingEnabled */
  private lightingEnabled = true;
  /** @see autotileVocabulary — rebuilt only when the catalogue is replaced. */
  private autotileVocab: ReadonlySet<string> = new Set();
  /** The catalogue {@link autotileVocab} was derived from. */
  private autotileVocabFor: Record<string, TileDef> | null = null;
  private prevMap: MapFile | null = null;
  private needsRender = true;
  private canvasW = 0;
  private canvasH = 0;
  private resizeObserver: ResizeObserver | null = null;
  /** Square buffer side in pixels, or null to track the element. */
  private fixedBufferPx: number | null = null;
  /**
   * Whether every tileset is on the GPU. Nothing is painted until it is —
   * @see renderOnce.
   */
  private assetsReady = false;
  /** Fired once, after the first frame that actually reached the canvas. */
  private onFirstFrame: (() => void) | null = null;
  private view: WorldView | null = null;
  private looping = false;
  private raf = 0;
  private palettePass = new PalettePass();
  private profiler: FrameProfiler | null = null;
  /**
   * The plumes, and every spark in the air. Built in the constructor because it
   * owns GPU buffers sized once — see `./particleLayer`.
   */
  private particles: ParticleLayer;
  /**
   * Placements currently wearing a tint, and what it takes to take one off.
   *
   * The texture and level are held rather than re-derived, because taking a tint
   * off is `materialFor(sameTexture, sameLevel, null)` and the instance key does
   * not carry either. The mesh is held so a placement whose level was rebuilt
   * under it can be recognised: the rebuilt mesh is already untinted, and
   * restoring a material onto a mesh that no longer exists is a no-op worth not
   * doing.
   */
  private tintedMeshes = new Map<
    string,
    { mesh: THREE.Mesh; texture: THREE.Texture; z: number; tintKey: string }
  >();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
    });
    this.renderer.setClearColor(VOID_BACKGROUND, 1);
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 50);
    this.camera.position.z = 25;

    this.world = new THREE.Group();
    this.scene.add(this.world);

    // Chrome lives in its own scene so it can be drawn after the palette
    // quantise, keeping outline colours exact instead of snapped to the ramp.
    this.overlayScene = new THREE.Scene();
    this.overlayScene.matrixWorldAutoUpdate = false;
    this.overlays = new THREE.Group();
    this.overlayScene.add(this.overlays);
    this.projectileGroup = new THREE.Group();
    this.projectileGroup.matrixAutoUpdate = false;
    this.projectileGroup.updateMatrix();
    this.world.add(this.projectileGroup);

    const data = new Uint8Array([255, 0, 255, 255]);
    this.magentaTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    this.magentaTex.magFilter = THREE.NearestFilter;
    this.magentaTex.minFilter = THREE.NearestFilter;
    this.magentaTex.colorSpace = THREE.SRGBColorSpace;
    this.magentaTex.needsUpdate = true;

    const white = new Uint8Array([255, 255, 255, 255]);
    this.whiteTex = new THREE.DataTexture(white, 1, 1, THREE.RGBAFormat);
    this.whiteTex.magFilter = THREE.LinearFilter;
    this.whiteTex.minFilter = THREE.LinearFilter;
    this.whiteTex.generateMipmaps = false;
    this.whiteTex.needsUpdate = true;

    // Last, because `ensureLightUniforms` needs `whiteTex` to exist.
    // Per level, because a lit spark has to be lit by the room it is in — see
    // `ParticleLayer`. Bound rather than passed once, so a plume on a storey
    // nobody has visited yet still gets that storey's light map.
    this.particles = new ParticleLayer((z) => this.ensureLightUniforms(z));
    this.world.add(this.particles.mesh);
    // Once, and never again: particle positions are baked into the vertices, so
    // the mesh's own matrix is the identity for its whole life. The scene does
    // not update matrices itself (see above), so without this the mesh keeps an
    // identity `matrixWorld` it was never given.
    this.particles.mesh.updateMatrixWorld(true);

    this.bindResize();
  }

  setAssets(tilesets: TilesetDef[], tilesById?: Record<string, TileDef>) {
    this.tilesets = tilesets;
    this.tilesetById = new Map(tilesets.map((t) => [t.id, t]));
    if (tilesById) this.tilesById = tilesById;
    this.assetsReady = false;
    void this.preloadTextures().then(() => {
      if (this.disposed) return;
      this.prevMap = null;
      // Force light re-upload after rebuild — materials may be new, and
      // the first setView can race textures still loading.
      this.lightingKey = "";
      this.staticLightGrid = null;
      if (this.view) {
        this.applyMap(this.view.map, this.cameraWindow(this.view), true);
        if (this.lightingEnabled) this.updateLighting(this.view);
      }
      this.assetsReady = true;
      this.needsRender = true;
    });
  }

  /** Attach a profiler to break {@link setView} down by phase. Null to stop. */
  setProfiler(profiler: FrameProfiler | null) {
    this.profiler = profiler;
  }

  private time<T>(phase: FramePhase, fn: () => T): T {
    return this.profiler ? this.profiler.measure(phase, fn) : fn();
  }

  setView(view: WorldView) {
    this.view = view;
    this.tilesById = view.tilesById;
    // Before applyMap, which is what reads it: a cell rebuilt this frame has to
    // come back in the state this view says it is in.
    this.spriteStates = view.spriteStates;
    this.applyCamera(view.camera.x, view.camera.y, view.zoom);

    // Before applyMap, which advances prevMap — the light cache needs to see
    // both versions to work out which chunks the edit reached.
    if (this.lightingEnabled) {
      this.time("sync", () => this.lighting.syncTo(this.prevMap, view.map));
    }

    this.time("map", () => {
      this.applyMap(view.map, this.cameraWindow(view), false);
      this.applyRoofCut(view.roofCut);
    });
    if (this.lightingEnabled) {
      this.time("light", () => this.updateLighting(view));
    }
    // After applyMap, so a mesh rebuilt this frame is in the registry to be
    // reached; before nothing, since a swap only touches its own quad.
    this.time("state", () => {
      this.applySpriteStates(view.spriteStates);
      // Beside the states, and after them, because both answer "what does this
      // placement look like right now" and a state change rebuilds the very
      // mesh a tint is worn by.
      this.applySpriteTints(view.spriteTints);
    });
    this.time("motion", () => {
      this.applyTileMotions(view.tileMotions);
      // Beside the motions, because it is the same kind of work at the same
      // point in the frame: something that is not where the map says it is.
      this.applyProjectiles(view.projectiles);
      // The plumes are only *reconciled* here. Advancing them is `tick`'s job,
      // because a plume moves with the clock rather than with the world: a
      // frame in which nothing at all changed still has sparks in it.
      this.particles.setEmitters(this.emittersFor(view));
    });
    this.needsRender = true;
  }

  /**
   * Every plume on screen this frame: the caller's, then the board's own.
   *
   * The board's half is culled by `./tileEmitters`, which owns the rule and the
   * arithmetic. What is left here is the one thing that needs a renderer: the
   * window, which is the camera's and is the same one the light bake crops to.
   */
  private emittersFor(view: WorldView): readonly ParticleEmitterSpec[] {
    if (this.tileEmittersStale) this.refreshTileEmitters();
    if (this.tileEmittersByLevel.size === 0) {
      return view.particleEmitters ?? EMPTY_EMITTERS;
    }

    const out = this.visibleEmitters;
    out.length = 0;
    if (view.particleEmitters) out.push(...view.particleEmitters);
    return appendVisibleTileEmitters(
      this.tileEmittersByLevel,
      this.cameraWindow(view),
      view.roofCut,
      out,
    );
  }

  /**
   * Draw the world unlit, and stop computing light at all.
   *
   * Not a shader switch with the bake still running behind it: while this is
   * off nothing is baked, stitched, uploaded or diffed for invalidation — the
   * two most expensive phases of a frame (`sync` and `light`) are skipped
   * outright, which is the point of the toggle.
   *
   * Skipping `syncTo` means the cache stops hearing about edits, so every
   * chunk it holds is suspect the moment light comes back on: turning it on
   * throws the cache away rather than trusting a diff that has a hole in it.
   */
  setLightingEnabled(enabled: boolean) {
    if (enabled === this.lightingEnabled) return;
    this.lightingEnabled = enabled;
    for (const u of this.lightUniformsByZ.values()) {
      u.uLightingEnabled.value = enabled ? 1 : 0;
    }
    if (enabled) {
      this.lighting.invalidateAll();
      // Left for the next frame's setView rather than baked here: that one
      // arrives with the emitter overrides this frame's view no longer has,
      // so baking now would only pay for a grid missing every dynamic light.
      this.staticLightGrid = null;
      this.lightingKey = "";
    }
    this.needsRender = true;
  }

  /** Asset handles the shared sprite-quad builder needs. */
  quadAssets(): SpriteQuadAssets {
    return {
      tilesetById: this.tilesetById,
      textures: this.textures,
      fallbackTexture: this.magentaTex,
      frameIndices: this.frameIndices,
    };
  }

  /**
   * Replace the chrome layer. Rebuilding allocates throwaway meshes, so a
   * signature gates it — this is called every frame from the play loop.
   */
  setOverlays(specs: OverlaySpec[]) {
    const sig = specs.map((spec) => this.overlayKey(spec)).join("|");
    if (sig === this.overlaySig) return;
    this.overlaySig = sig;

    disposeGroupChildren(this.overlays, this.outlineMaterials);
    this.pulsingOutlines = [];
    this.followingOutlines = [];
    for (const spec of specs) this.addOverlay(spec);
    // At the phase the clock is already at, so a rebuild is invisible rather
    // than a flash back to full brightness.
    this.applyPulse();
    // Scene has matrixWorldAutoUpdate=false — without this the meshes keep an
    // identity matrixWorld and all draw at the world origin.
    this.overlays.updateMatrixWorld(true);
    this.needsRender = true;
  }

  /**
   * Put every borrowed outline back on top of the mesh it is around.
   *
   * Here rather than in `setOverlays`, because the frames an outline has to keep
   * up on are the ones where it is *not* rebuilt: a sprite mid-step moves every
   * frame while the overlay set stays exactly as it was. Drawing is the one
   * thing that cannot be skipped on such a frame, so the copy rides with it.
   *
   * A copy rather than parenting, since the chrome is a separate scene — drawn
   * after the palette pass so an outline keeps its exact colour.
   */
  private syncFollowingOutlines() {
    for (const { outline, source } of this.followingOutlines) {
      outline.matrix.copy(source.matrixWorld);
      outline.matrixWorld.copy(source.matrixWorld);
    }
  }

  /** Write this instant's brightness into every breathing outline. */
  private applyPulse() {
    if (this.pulsingOutlines.length === 0) return;
    const alpha = pulseAlphaAt(this.pulseElapsedMs);
    for (const material of this.pulsingOutlines) {
      material.uniforms[OUTLINE_ALPHA_UNIFORM]!.value = alpha;
    }
  }

  /**
   * {@link overlaySpecKey}, plus the one thing about a tile's *appearance* that
   * belongs in it.
   *
   * That key deliberately holds nothing about how a tile looks, because an
   * outline follows the mesh it was cut around. A heap breaks the deliberate
   * part: its outline is one ring per thing in it, so eating a berry out of a
   * pile somebody is pointing at changes how many rings are correct while every
   * other word in the key stays the same. Absent for anything that is not a
   * pile, so no key in the game but a heap's changes by a character.
   */
  private overlayKey(spec: OverlaySpec): string {
    const key = overlaySpecKey(spec);
    if (spec.kind === "ghost") return key;
    const map = this.view?.map;
    const placed = map && getStack(map, spec.x, spec.y, spec.z)[spec.stackIndex];
    const count = placed ? countOf(placed) : 1;
    return count > 1 ? `${key}x${count}` : key;
  }

  /** The placed tile an overlay refers to, plus the elevation it is drawn at. */
  private overlaySubject(key: TileInstanceKey) {
    const map = this.view?.map;
    if (!map) return null;
    const stack = getStack(map, key.x, key.y, key.z);
    const placed = stack[key.stackIndex];
    const def = placed && this.tilesById[placed.tileId];
    if (!placed || !def) return null;
    return {
      map,
      placed,
      def,
      elevation: stackHeight(stack.slice(0, key.stackIndex), this.tilesById),
    };
  }

  private addOverlay(spec: OverlaySpec) {
    if (spec.kind === "ghost") {
      this.addGhost(spec);
      return;
    }
    for (const outline of this.outlinesFor(spec)) {
      if (spec.pulse) {
        this.pulsingOutlines.push(outline.material as THREE.ShaderMaterial);
      }
      this.overlays.add(outline);
    }
  }

  /**
   * An outline around one placed tile, cut from whatever the world is drawing it
   * with.
   *
   * A tile that animates or can move owns its mesh, and the outline borrows it:
   * the frame, the pose and the walk lerp are then facts the two share rather
   * than facts the chrome has to be told about. That is the whole of keeping an
   * outline in step — every other tile is in a merged batch precisely because
   * nothing about it can change, so cutting it a quad of its own is exact too.
   *
   * **A list, because a heap is one placement drawn several times.** Outlining
   * only the quad the placement would have drawn on its own put a ring around a
   * single berry in the middle of a dozen — which reads as "that one", where
   * what a press actually takes is all of them. One ring per sprite says the
   * true thing, and it says it in the same offsets the sprites were drawn at, so
   * the chrome cannot disagree with the art about where the berries are. See
   * `./pileLayout`.
   */
  private outlinesFor(spec: ObjectOutlineOverlay): THREE.Mesh[] {
    const key = this.tileKey(spec);
    const source = this.movableMeshes.get(key);
    if (source) {
      const outline = makeFollowingSpriteOutline(
        source,
        spec.color,
        this.outlineMaterials,
      );
      if (!outline) return [];
      this.followingOutlines.push({ outline, source });
      return [outline];
    }

    const subject = this.overlaySubject(spec);
    if (!subject) return [];
    const quad = spriteQuadFor(
      this.quadAssets(),
      subject.map,
      { x: spec.x, y: spec.y, z: spec.z, elevation: subject.elevation },
      subject.placed,
      subject.def,
    );
    if (!quad) return [];
    // The borrowed branch above has already taken every tile with a mesh of its
    // own, which is every tile a pile is not — so the count is read straight
    // off the placement here, exactly as `cellItems` reads it.
    //
    // One ring per sprite, at the offset that sprite was drawn at, each told
    // where the others are so the heap comes out with one silhouette around the
    // whole of it rather than a dozen rings crossing through it. See
    // `./pileLayout`'s `pileRings` and `./overlayMeshes`' `OutlinePeers`.
    return pileRings(countOf(subject.placed)).map(({ at, peers }) =>
      makeSpriteOutline(
        { ...quad, x: quad.x + at.dx, y: quad.y + at.dy },
        spec.color,
        this.outlineMaterials,
        peers,
      ),
    );
  }


  /**
   * Draw a tile that is not there, on top of the cell it would land in.
   *
   * The elevation is the *whole* stack's height rather than a slice of it,
   * which is the one difference from an outline: an outline is cut around
   * something already in the stack, and this is drawn above everything in it.
   */
  private addGhost(spec: TileGhostOverlay) {
    const map = this.view?.map;
    const def = this.tilesById[spec.tileId];
    if (!map || !def) return;

    const stack = getStack(map, spec.x, spec.y, spec.z);
    const quad = spriteQuadFor(
      this.quadAssets(),
      map,
      {
        x: spec.x,
        y: spec.y,
        z: spec.z,
        elevation: stackHeight(stack, this.tilesById),
      },
      { tileId: spec.tileId },
      def,
    );
    if (!quad) return;
    this.overlays.add(makeSpriteGhost(quad, spec.alpha));
  }

  /**
   * Hand the frame's cut to the geometry. No mesh rebuild, ever.
   *
   * **Two mechanisms, because the cut has two shapes.** A whole-storey cut is a
   * level threshold and stays what it always was: `group.visible = false`, which
   * skips the floor's draw calls outright. A structure cut is a set of cells
   * inside a level whose static geometry is merged into one draw call per
   * texture, so there is no object to hide — that one is a mask the fragment
   * shader reads (see {@link writeCutMask}).
   *
   * Rebuilding the merged geometry instead was the obvious alternative and is
   * the one thing that must not happen here: rebuilding walks every coordinate
   * of a chunk, and the cut changes every time the player takes a step.
   *
   * Skipped when the cut is the same object as last frame, which is the usual
   * case — `GameRenderer` caches it on the map and the anchor, so it is a new
   * object only when one of those moved. Level groups made after this point read
   * {@link roofCut} for themselves.
   */
  private applyRoofCut(cut: RoofCut | undefined) {
    if (cut === this.roofCut) return;
    this.roofCut = cut;
    for (const [z, group] of this.levelGroups) {
      group.visible = !cutHidesWholeLevel(cut, z);
    }
    for (const z of this.cutUniformsByZ.keys()) this.writeCutMask(z);
  }

  /**
   * Upload one level's cut as a mask in cell space, or switch it off.
   *
   * The layout is `./cutMask`'s; what is left here is the one thing that needs a
   * renderer. A fresh texture per change rather than a resized one: the cut
   * changes when the player steps or the world is edited, which is a few times a
   * second at most, and a few hundred bytes uploaded then is not worth a pool.
   */
  private writeCutMask(z: number) {
    const u = this.cutUniformsByZ.get(z);
    if (!u) return;

    const cut = this.roofCut;
    const mask =
      cut && cut.cells !== null && z > cut.floor
        ? cutMaskFor(cut.cells.get(z))
        : null;
    if (!mask) {
      u.uCutEnabled.value = 0;
      return;
    }

    const texture = new THREE.DataTexture(
      mask.data,
      mask.w,
      mask.h,
      THREE.RedFormat,
    );
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    // A row of a single-channel mask is `w` bytes and `w` is whatever the roof
    // measures, so the default four-byte row alignment would read the wrong
    // pixels for three widths in four.
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;

    this.cutTextures.get(z)?.dispose();
    this.cutTextures.set(z, texture);
    u.uCutMask.value = texture;
    u.uCutOrigin.value.set(mask.x0, mask.y0);
    u.uCutSize.value.set(mask.w, mask.h);
    u.uCutEnabled.value = 1;
  }

  /**
   * The clock every animation is read against, in milliseconds.
   *
   * Exposed because emission is authored per frame, and a light resolved
   * anywhere else — a lantern in a bag, which is on no cell for the bake to
   * find — has to be read against the same clock as the sprite it belongs to,
   * or the two tell different stories about the same object.
   */
  get animTimeMs(): number {
    return this.animClock;
  }

  /** Advance sprite animations; call from the host rAF loop. */
  tick(dt: number) {
    // Before the early return: a breathing outline is the one thing on screen
    // that moves while the world is perfectly still, which is exactly the case
    // `updateAnimations` says there is nothing to do in.
    if (this.pulsingOutlines.length > 0) {
      this.pulseElapsedMs += dt;
      this.applyPulse();
      this.needsRender = true;
    }
    // Kept outside `updateAnimations`, which has nothing to do — and used to
    // return before advancing this — when no animated sprite is on screen. The
    // light bake reads the same clock, and an emitter can sit outside the built
    // geometry while its light still reaches inside the window.
    this.animClock += dt;
    // Before the animation check, for the reason the pulse is: a plume is a
    // thing that moves while the world is perfectly still, which is exactly the
    // case `updateAnimations` reports nothing to do in.
    if (this.particles.active) {
      this.particles.update(dt, this.roofCut);
      this.needsRender = true;
    }
    if (!this.updateAnimations()) return;
    this.needsRender = true;
  }

  start() {
    if (this.looping || this.disposed) return;
    this.looping = true;
    this.lastAnimTime = performance.now();
    const loop = () => {
      if (!this.looping || this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(100, now - this.lastAnimTime);
      this.lastAnimTime = now;
      this.tick(dt);
      if (!this.needsRender) return;
      this.needsRender = false;
      this.renderOnce();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.looping = false;
    cancelAnimationFrame(this.raf);
  }

  /**
   * Called the first time a frame reaches the canvas, so whoever owns the page
   * can take its loading screen down against the world appearing rather than
   * against a guess at when it will.
   */
  setOnFirstFrame(cb: (() => void) | null) {
    this.onFirstFrame = cb;
  }

  renderOnce() {
    if (this.disposed) return;
    // Not one pixel until every tileset is on the GPU. A material whose texture
    // has not arrived draws `magentaTex`, so painting early means a frame or
    // more of magenta over the whole world — the placeholder is there to make a
    // *missing* tileset obvious, and a tileset that is merely still in flight is
    // not missing. `setAssets` flips this and asks for a frame.
    if (!this.assetsReady) return;
    this.updateCanvasSize();
    if (this.view) {
      this.applyCamera(this.view.camera.x, this.view.camera.y, this.view.zoom);
    }
    const r = this.renderer;

    // PROTOTYPE — always palettise play frames.
    const target = this.palettePass.sceneTarget(r);
    r.setRenderTarget(target);
    r.setClearColor(VOID_BACKGROUND, 1);
    r.clear();
    r.render(this.scene, this.camera);
    this.palettePass.blitToCanvas(r);

    // Quantise before chrome so hover outlines and target squares keep their
    // exact colour instead of snapping to the nearest palette entry.
    if (this.overlays.children.length > 0) {
      this.syncFollowingOutlines();
      r.autoClear = false;
      r.render(this.overlayScene, this.camera);
      r.autoClear = true;
    }

    // After the draw, never before: the callback's whole job is to say that
    // there is something on the canvas now.
    const first = this.onFirstFrame;
    this.onFirstFrame = null;
    first?.();
  }

  isReady(): boolean {
    return !this.disposed && this.assetsReady && this.prevMap !== null;
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.palettePass.dispose();
    this.particles.dispose();
    this.tintedMeshes.clear();
    disposeGroupChildren(this.overlays, this.outlineMaterials);
    this.outlineMaterials.dispose();
    disposeGroupChildren(this.projectileGroup);
    this.projectileMeshes.clear();
    // Dropped with the meshes they belong to: a disposed material written to on
    // a stray tick is a use-after-free as far as WebGL is concerned.
    this.pulsingOutlines = [];
    this.followingOutlines = [];
    this.renderer.dispose();
    this.lightBaker?.dispose();
    this.lightBaker = null;
    for (const tex of this.textures.values()) tex.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    for (const tex of this.lightTextures.values()) tex.dispose();
    for (const tex of this.cutTextures.values()) tex.dispose();
    for (const table of this.animTablesByZ.values()) table.dispose();
    this.magentaTex.dispose();
    this.whiteTex.dispose();
  }

  private tileKey(k: TileInstanceKey): string {
    return tileInstanceKey(k);
  }

  private applyTileMotions(motions: TileMotion[] | undefined) {
    const byKey = new Map<string, TileMotion>();
    for (const m of motions ?? []) byKey.set(this.tileKey(m), m);

    const activeGhosts = new Set<string>();

    for (const [key, mesh] of this.movableMeshes) {
      const base = this.movableBasePos.get(key);
      const baseBox = this.movableBaseBox.get(key);
      if (!base || !baseBox) continue;

      // Sprite offset and depth box come from the same motion, so what is drawn
      // and where it sorts can never disagree for a frame.
      const motion = byKey.get(key);
      mesh.position.x = base.x + (motion?.ox ?? 0);
      mesh.position.y = base.y + (motion?.oy ?? 0);
      writeBoxAttr(
        mesh.geometry,
        motion
          ? depthBox(motion.box.x, motion.box.y, motion.box.foot, motion.box.top)
          : baseBox.box,
        motion ? motion.box.stackBias : baseBox.stackBias,
      );
      // Scene has matrixWorldAutoUpdate=false — must push local → world or the
      // mesh never moves on screen despite position changing.
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);

      // Descending movers: also draw under the destination level so roof-cut can
      // hide the origin group without the sprite vanishing mid-lerp. Hide the
      // origin mesh while the dest copy is up so we never double-draw.
      if (motion?.alsoDrawAtZ != null) {
        activeGhosts.add(key);
        const ghost = this.ensureMotionGhost(key, mesh, motion.alsoDrawAtZ);
        this.syncMotionGhost(ghost, mesh);
        ghost.visible = true;
        mesh.visible = false;
      } else {
        mesh.visible = true;
      }
    }

    for (const key of [...this.motionGhosts.keys()]) {
      if (!activeGhosts.has(key)) this.disposeMotionGhost(key);
    }
  }

  /**
   * Draw this frame's arrows.
   *
   * A mesh per flight, made once and moved ever after. Everything that varies
   * frame to frame — where it is, what it sorts against, which cell's light it
   * takes — is an attribute write on geometry that already exists; the sprite's
   * footprint is fixed, because a flight's bearing never changes and the frames
   * of one sprite share a rect.
   *
   * A flight whose tile the catalogue has lost, or whose art is unauthored on
   * the bearing it is travelling, simply draws nothing. That is the same answer
   * every other id in a kit gets when the world has moved on underneath it: the
   * fact is out of date, not corrupt, and a fight is not worth refusing over the
   * art.
   */
  private applyProjectiles(views: ProjectileView[] | undefined) {
    if (views === undefined && this.projectileMeshes.size === 0) return;

    const live = new Set<string>();
    for (const view of views ?? []) {
      const entry = this.projectileMesh(view);
      if (!entry) continue;
      live.add(view.id);
      this.placeProjectile(entry, view);
    }

    for (const [id, entry] of this.projectileMeshes) {
      if (live.has(id)) continue;
      this.projectileGroup.remove(entry.mesh);
      disposeObject3D(entry.mesh);
      this.projectileMeshes.delete(id);
    }
  }

  /**
   * The mesh for one flight, made on the frame it first appears.
   *
   * Null when there is nothing to draw with, and null every frame after that
   * too — the lookups are all off a catalogue that does not change mid-flight,
   * so a miss on the first frame is a miss for the whole flight.
   */
  private projectileMesh(view: ProjectileView): ProjectileMesh | null {
    const existing = this.projectileMeshes.get(view.id);
    if (existing) return existing;

    const def = this.tilesById[view.tileId];
    if (!def) return null;
    const frames = getFrames(def, { direction: view.direction });
    if (!frames?.length) return null;
    const tileset = this.tilesetById.get(frames[0]!.sprite.tilesetId);
    if (!tileset) return null;

    const texture = this.textures.get(tileset.id) ?? this.magentaTex;
    const { rect } = frames[0]!.sprite;
    const quad: Omit<Quad, "x" | "y"> = {
      w: rect.w * CELL_SIZE,
      h: rect.h * CELL_SIZE,
      ...frameUvs(frames[0]!, tileset),
      // Placeholders. Every one of these is rewritten by `placeProjectile`
      // before the frame is drawn, and they exist here only because a geometry
      // has to be built with something in its attributes.
      box: depthBox(view.x, view.y, view.elevAbs, view.elevAbs),
      stackBias: 0,
      lightX0: view.x,
      lightY0: view.y,
      lightX1: view.x + 1,
      lightY1: view.y + 1,
      unlit: tileCanEmitLight(def),
    };

    const mesh = new THREE.Mesh(
      buildSingleQuadGeometry(quad),
      this.materialFor(texture, view.z),
    );
    // Never culled, for the reason every other single-quad mesh here is not: the
    // bounding sphere is computed once and the thing moves every frame.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.projectileGroup.add(mesh);

    const entry: ProjectileMesh = {
      mesh,
      def,
      frames,
      tileset,
      texture,
      frameIdx: -1,
      z: view.z,
      w: quad.w,
      h: quad.h,
    };
    this.projectileMeshes.set(view.id, entry);
    return entry;
  }

  /** Put one arrow where this frame says it is. */
  private placeProjectile(entry: ProjectileMesh, view: ProjectileView) {
    const frameIdx = frameIndexAtTime(entry.frames, this.animClock);
    const frame = entry.frames[frameIdx]!;
    if (frameIdx !== entry.frameIdx) {
      entry.frameIdx = frameIdx;
      writeFrameUvs(entry.mesh, frame, entry.tileset);
    }

    // The level's own light and the level's own roof-cut, both re-asked every
    // frame because an arrow can cross a storey mid-flight — a shot from a
    // balcony passes through the boundary on its way down, and a material fixed
    // at launch would light the whole descent by the room it left.
    if (view.z !== entry.z) {
      entry.z = view.z;
      entry.mesh.material = this.materialFor(entry.texture, view.z);
    }
    // An arrow is parented to `world` rather than to a level group, so the group
    // toggle does not reach it — and neither can the shader mask, whose cell
    // comes from the box, which for a flight is where the arrow *is* rather than
    // a cell the fill ever claimed.
    entry.mesh.visible = !cutHides(this.roofCut, view.x, view.y, view.z);

    const localElev = view.elevAbs - view.z * HEIGHT_PER_LEVEL;
    const baseOrigin = baseCellWorldOrigin(view.x, view.y, view.z, localElev);
    const origin = spriteWorldOrigin(baseOrigin, frame.sprite.base);
    entry.mesh.position.set(origin.x + entry.w / 2, origin.y + entry.h / 2, 0);
    entry.mesh.updateMatrix();
    entry.mesh.updateMatrixWorld(true);

    writeBoxAttr(
      entry.mesh.geometry,
      depthBox(view.x, view.y, view.elevAbs, view.elevAbs + entry.def.height),
      depthStackBias(view.z, PROJECTILE_STACK_BIAS),
    );
    writeLightUvAttr(
      entry.mesh.geometry,
      view.x,
      view.y,
      view.x + 1,
      view.y + 1,
    );
  }

  /** Level group for z, creating an empty one when the dest floor has no tiles yet. */
  private ensureLevelGroup(z: number): THREE.Group {
    let group = this.levelGroups.get(z);
    if (group) return group;
    group = new THREE.Group();
    group.name = `level:${z}`;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    group.visible = !cutHidesWholeLevel(this.roofCut, z);
    this.world.add(group);
    this.levelGroups.set(z, group);
    return group;
  }

  private ensureMotionGhost(
    key: string,
    source: THREE.Mesh,
    z: number,
  ): THREE.Mesh {
    const existing = this.motionGhosts.get(key);
    if (existing && existing.userData.drawOnZ === z) return existing;
    this.disposeMotionGhost(key);

    const mat = source.material as THREE.MeshBasicMaterial;
    const texture = mat.map ?? this.magentaTex;
    const ghost = new THREE.Mesh(
      source.geometry.clone(),
      this.materialFor(texture, z),
    );
    ghost.frustumCulled = false;
    ghost.matrixAutoUpdate = false;
    ghost.userData.drawOnZ = z;
    this.ensureLevelGroup(z).add(ghost);
    this.motionGhosts.set(key, ghost);
    return ghost;
  }

  private syncMotionGhost(ghost: THREE.Mesh, source: THREE.Mesh) {
    ghost.position.copy(source.position);
    const srcAttrs = source.geometry.attributes;
    const dstAttrs = ghost.geometry.attributes;
    for (const name of Object.keys(srcAttrs)) {
      const src = srcAttrs[name];
      const dst = dstAttrs[name];
      if (!src?.array || !dst?.array) continue;
      (dst.array as Float32Array).set(src.array as Float32Array);
      dst.needsUpdate = true;
    }
    ghost.updateMatrix();
    ghost.updateMatrixWorld(true);
  }

  private disposeMotionGhost(key: string) {
    const ghost = this.motionGhosts.get(key);
    if (!ghost) return;
    ghost.parent?.remove(ghost);
    ghost.geometry.dispose();
    this.motionGhosts.delete(key);
  }

  private clearMotionGhosts() {
    for (const key of [...this.motionGhosts.keys()]) {
      this.disposeMotionGhost(key);
    }
  }

  /**
   * Bring the built geometry into line with this map, seen from this window.
   *
   * Two things can make it out of date and they are not the same thing. The
   * *map* changing is an edit, and costs the chunks it touched. The *window*
   * moving is a walk, and costs the chunks that have come into range and the
   * ones that have left. A frame where neither moved is the common one and
   * costs the comparison below and nothing else.
   */
  private applyMap(map: MapFile, window: WorldRect, force: boolean) {
    const mapMoved = force || map !== this.prevMap;
    if (!mapMoved && sameRect(this.meshedWindow, window)) return;
    // Stacks moved under the chrome — whatever it was anchored to may be gone.
    // Only for an edit: panning does not move anything the chrome is anchored
    // to, and clearing this on every step would rebuild the overlays for a
    // camera that merely scrolled.
    if (mapMoved) this.overlaySig = null;
    if (force || !this.prevMap) this.discardGeometry();
    this.syncChunks(map, window);
  }

  private bindResize() {
    this.resizeObserver = new ResizeObserver(() => {
      this.updateCanvasSize();
      this.needsRender = true;
    });
    this.resizeObserver.observe(this.canvas);
    this.updateCanvasSize();
  }

  /**
   * Draw into a square buffer of `px`, ignoring the element's CSS box.
   *
   * Play mode fixes the buffer so the world renders at a whole number of pixels
   * per world pixel and the element is then stretched over its pane — see
   * `./viewport`. Left unset, the buffer tracks the element, which is what the
   * editor wants: there the pane *is* the view.
   */
  setBufferSize(px: number) {
    this.fixedBufferPx = Math.max(1, Math.floor(px));
    this.updateCanvasSize();
  }

  private updateCanvasSize() {
    const fixed = this.fixedBufferPx;
    const w = fixed ?? Math.max(1, this.canvas.clientWidth);
    const h = fixed ?? Math.max(1, this.canvas.clientHeight);
    if (w === this.canvasW && h === this.canvasH) return;
    this.canvasW = w;
    this.canvasH = h;
    // `false`: the CSS box is the layout's business, and under a fixed buffer
    // it is deliberately not the buffer's size.
    this.renderer.setSize(w, h, false);
  }

  /**
   * Every tileset onto the GPU, and a failure is one tileset's problem.
   *
   * Each load is caught on its own because the frame loop now waits on this
   * whole pass finishing (@see renderOnce). Left to reject, a single 404 would
   * mean `assetsReady` never flips and the world is never drawn at all —
   * trading a magenta wall, which is the placeholder doing its job, for a black
   * screen, which is the game not starting.
   */
  private async preloadTextures() {
    await Promise.all(
      this.tilesets.map(async (ts) => {
        if (this.textures.has(ts.id)) return;
        const loader = new THREE.TextureLoader();
        try {
          const tex = await loader.loadAsync(tilesetUrl(ts.file));
          tex.magFilter = THREE.NearestFilter;
          tex.minFilter = THREE.NearestFilter;
          tex.generateMipmaps = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.flipY = true;
          tex.needsUpdate = true;
          this.textures.set(ts.id, tex);
        } catch (err) {
          console.warn(`tileset failed to load: ${ts.file}`, err);
        }
      }),
    );
  }

  private applyCamera(camX: number, camY: number, zoom: number) {
    this.updateCanvasSize();
    const viewW = this.canvasW / zoom;
    const viewH = this.canvasH / zoom;
    this.camera.left = camX;
    this.camera.right = camX + viewW;
    this.camera.top = camY;
    this.camera.bottom = camY + viewH;
    this.camera.scale.set(1, 1, 1);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  /** This level's cut uniforms, with the mask already written into them. */
  /**
   * This level's animation uniforms, inert until the level is built.
   *
   * Held by reference the way the light and cut ones are: a material binds the
   * object once when its program compiles, so a rebuild must replace what is
   * *inside* it rather than hand out a new object nothing is looking at.
   */
  private ensureAnimUniforms(z: number): LevelAnimUniforms {
    let u = this.animUniformsByZ.get(z);
    if (!u) {
      u = noAnimUniforms(this.whiteTex);
      this.animUniformsByZ.set(z, u);
    }
    return u;
  }

  /**
   * This level's animation table, which outlives any one chunk of it.
   *
   * Level-scoped because materials are: `materialFor` keys on (texture, level),
   * so every chunk on a floor draws through one set of uniforms and therefore
   * one table. It only ever grows — a chunk streaming out does not take its rows
   * with it — which is what keeps the rows the surviving chunks point at valid,
   * and costs a texel per frame per animation that floor has ever shown.
   */
  private ensureAnimTable(z: number): AnimationTable {
    let table = this.animTablesByZ.get(z);
    if (!table) {
      table = new AnimationTable();
      this.animTablesByZ.set(z, table);
    }
    return table;
  }

  /** Point this level's materials at its table, after a chunk may have grown it. */
  private publishAnimTable(z: number) {
    const table = this.animTablesByZ.get(z);
    const u = this.ensureAnimUniforms(z);
    if (!table || table.empty) {
      u.uAnimEnabled.value = 0;
      return;
    }
    // `bake` is cached until a row is added, so re-publishing per chunk is a
    // map lookup on the overwhelmingly common chunk that brought no new
    // animation with it.
    u.uAnimTable.value = table.bake();
    u.uAnimSize.value.set(table.width, table.height);
    u.uAnimClockMs.value = this.animClock;
    u.uAnimEnabled.value = 1;
  }

  private ensureCutUniforms(z: number): LevelCutUniforms {
    let u = this.cutUniformsByZ.get(z);
    if (!u) {
      u = noCutUniforms(this.whiteTex);
      this.cutUniformsByZ.set(z, u);
      // A level whose first material appears while a cut is already standing has
      // to arrive cut, or it is the one floor still drawing its roof.
      this.writeCutMask(z);
    }
    return u;
  }

  private ensureLightUniforms(z: number): LevelLightUniforms {
    let u = this.lightUniformsByZ.get(z);
    if (!u) {
      u = {
        uLightMap: { value: this.whiteTex },
        uLightOrigin: { value: new THREE.Vector2(0, 0) },
        uLightSize: { value: new THREE.Vector2(1, 1) },
        // A level whose materials appear while the toggle is off must arrive
        // unlit too, or it would be the one floor still shaded.
        uLightingEnabled: { value: this.lightingEnabled ? 1 : 0 },
        uAmbient: { value: new THREE.Vector3(0, 0, 0) },
      };
      this.lightUniformsByZ.set(z, u);
    }
    return u;
  }

  /**
   * The material for a texture on a level, optionally wearing a status's colour.
   *
   * Cached on all three, because a tint is a property of the *material* rather
   * than of the geometry — see `./spriteTint` for why it is a uniform and what
   * that costs. The cache therefore grows by one entry per (sheet, level, tint)
   * actually seen, and the tint population is the authored status catalogue, so
   * in practice it grows by a handful and then stops.
   */
  private materialFor(
    texture: THREE.Texture,
    z: number,
    tint: StatusTint | null = null,
  ): THREE.MeshBasicMaterial {
    const key = `${texture.uuid}:${z}:${tintCacheKey(tint)}`;
    let mat = this.materials.get(key);
    if (!mat) {
      const lightUniforms = this.ensureLightUniforms(z);
      const cutUniforms = this.ensureCutUniforms(z);
      // Resolved once, here, rather than per frame: the uniforms are the tint,
      // so a material that has one never needs telling about it again.
      const tintU = tint && tint.strength > 0 ? tintUniforms(tint) : noTintUniforms();
      mat = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
      });
      mat.onBeforeCompile = (shader) => {
        injectWorldShader(
          shader,
          lightUniforms,
          tintU,
          cutUniforms,
          this.ensureAnimUniforms(z),
        );
      };
      mat.customProgramCacheKey = () => WORLD_SHADER_CACHE_KEY;
      this.materials.set(key, mat);
    }
    mat.alphaTest = 0.5;
    mat.transparent = true;
    mat.opacity = 1;
    mat.depthTest = true;
    mat.depthWrite = true;
    mat.needsUpdate = true;
    return mat;
  }

  /**
   * Cells the camera can reach at any level.
   *
   * The projection is axis-aligned in world pixels — level `z` shifts a cell by
   * `CELL_SIZE * z` (see {@link screenToCoord}) — so the visible region is a
   * plain rect per level, and the union across levels is the same rect grown by
   * the level span. Cheap enough to redo every frame.
   */
  private lightWindow(view: WorldView): WorldRect {
    const base = this.cameraWindow(view);
    return {
      x0: base.x0 + MIN_LEVEL - LIGHT_WINDOW_MARGIN,
      y0: base.y0 + MIN_LEVEL - LIGHT_WINDOW_MARGIN,
      x1: base.x1 + MAX_LEVEL + LIGHT_WINDOW_MARGIN,
      y1: base.y1 + MAX_LEVEL + LIGHT_WINDOW_MARGIN,
    };
  }

  /**
   * The cells the camera covers **on level 0**, with no apron and no level span.
   *
   * The one honest primitive under both windows: the projection shifts level `z`
   * by exactly `z` cells, so every consumer's rect is this one plus whatever
   * slack that consumer actually needs. {@link lightWindow} unions the whole
   * level span onto it because a light on any storey can reach here; a plume is
   * on one known level and takes that level's own shift instead — see
   * `./tileEmitters`.
   */
  private cameraWindow(view: WorldView): WorldRect {
    const viewW = this.canvasW / view.zoom;
    const viewH = this.canvasH / view.zoom;
    return {
      x0: Math.floor(view.camera.x / CELL_SIZE),
      y0: Math.floor(view.camera.y / CELL_SIZE),
      x1: Math.floor((view.camera.x + viewW) / CELL_SIZE),
      y1: Math.floor((view.camera.y + viewH) / CELL_SIZE),
    };
  }

  private updateLighting(view: WorldView) {
    if (view.tilesById !== this.lightingTilesById) {
      const dynamicIds = dynamicLightTileIds(view.tilesById);
      this.lighting = new ChunkedLighting(view.tilesById, dynamicIds);
      this.flickeringDynamicDefs = [...dynamicIds]
        .map((id) => view.tilesById[id])
        .filter((def): def is TileDef => def != null && tileLightVaries(def));
      this.lightingTilesById = view.tilesById;
      this.staticLightGrid = null;
      // The worker holds the catalogue it bakes against, so a new catalogue is
      // a new worker rather than a message — there is no correct light to make
      // from the old one while the new one is being adopted.
      this.lightBaker?.dispose();
      this.lightBaker = null;
      if (canBakeOffThread()) {
        this.lightBaker = new WorkerChunkBaker(
          Object.values(view.tilesById),
          dynamicIds,
          view.map,
        );
        this.lighting.setBaker(this.lightBaker);
      }
    }

    // Before anything can ask for a bake, and that order is the whole of the
    // consistency argument: messages are delivered in order, so a map the
    // worker is told about here cannot be older than a request sent below.
    this.lightBaker?.syncMap(view.map);

    // Ambient is a uniform, not a bake input. Moving the clock now costs one
    // vector write per level — no re-tint, no re-upload, nothing invalidated.
    const ambient = sampleIllumination(view.minutesOfDay).ambient;
    for (const u of this.lightUniformsByZ.values()) {
      u.uAmbient.value.set(ambient[0], ambient[1], ambient[2]);
    }
    this.pendingAmbient = ambient;

    // Bakes only the chunks in view that are missing, and hands back the same
    // grid object while nothing has changed — so identity, not a content hash,
    // is what decides whether the textures need rewriting. This is what
    // replaced hashing every cell in the map on every frame.
    //
    // The animation clock is a bake input: a torch that flickers emits what its
    // live frame says it does, not what frame 0 said. Chunks no flicker reaches
    // are unaffected by it, so the clock alone never causes a bake.
    const base = this.lighting.packedGridFor(
      view.map,
      this.lightWindow(view),
      this.animClock,
    );

    // The dynamic emitters' own phase belongs in the key as well as the static
    // one. Their light is painted, not baked, so nothing about the grid or the
    // override positions would change as their frames tick over.
    const overridesKey = [
      emitterOverridesKey(view.emitterOverrides),
      ...this.flickeringDynamicDefs.map((def) =>
        tileEmissionPhase(def, this.animClock),
      ),
    ].join("|");
    if (base === this.staticLightGrid && overridesKey === this.lightingKey) {
      return;
    }
    this.staticLightGrid = base;
    this.lightingKey = overridesKey;

    const overrides = view.emitterOverrides;
    if (!overrides?.length) {
      this.uploadPackedGrid(base);
      return;
    }

    this.uploadPackedGrid(
      overlayEmitterOverridesPacked(
        base,
        view.map,
        view.tilesById,
        overrides,
        this.animClock,
      ),
    );
  }

  private uploadPackedGrid(grid: PackedLightGrid) {
    const seen = new Set<number>();
    for (const [z, level] of grid.levels) {
      seen.add(z);
      this.uploadPackedLevel(z, level);
    }
    for (const z of this.lightUniformsByZ.keys()) {
      if (seen.has(z)) continue;
      this.uploadDarkLevel(z);
    }
  }

  /**
   * No grid for this level, so it draws unlit. Alpha 0 as well as RGB 0 — with
   * ambient applied in the shader, a leftover alpha would tint this to the sky
   * colour instead of leaving it dark.
   */
  private uploadDarkLevel(z: number) {
    const u = this.ensureLightUniforms(z);
    const data = new Uint8Array([0, 0, 0, 0]);
    let tex = this.lightTextures.get(z);
    if (!tex || tex.image.width !== 1) {
      tex?.dispose();
      tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this.lightTextures.set(z, tex);
    } else {
      (tex.image.data as Uint8Array).set(data);
      tex.needsUpdate = true;
    }
    u.uLightMap.value = tex;
    u.uLightOrigin.value.set(0, 0);
    u.uLightSize.value.set(1, 1);
  }

  /** Hand the packed plane straight to the GPU — it is already in texture layout. */
  private uploadPackedLevel(z: number, level: PackedLevelLight) {
    const u = this.ensureLightUniforms(z);
    if (this.pendingAmbient) {
      const a = this.pendingAmbient;
      u.uAmbient.value.set(a[0], a[1], a[2]);
    }
    u.uLightOrigin.value.set(
      level.x0 - LIGHT_MAP_CELL_OFFSET,
      level.y0 - LIGHT_MAP_CELL_OFFSET,
    );
    u.uLightSize.value.set(level.w, level.h);

    let tex = this.lightTextures.get(z);
    if (!tex || tex.image.width !== level.w || tex.image.height !== level.h) {
      tex?.dispose();
      tex = new THREE.DataTexture(level.rgba, level.w, level.h, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this.lightTextures.set(z, tex);
    } else {
      (tex.image as { data: Uint8Array }).data.set(level.rgba);
      tex.needsUpdate = true;
    }
    u.uLightMap.value = tex;
  }


  /**
   * Throw away every mesh this class owns, so the next sync builds from nothing.
   *
   * **Anything parented to `world` that this does not own has to be named
   * here**, and the failure when it is not is total rather than subtle: the
   * child is removed *and disposed*, so its geometry is freed underneath a
   * renderer that goes on thinking it is drawing. The particle mesh is built
   * once in the constructor and the first map build ate it, which looked
   * exactly like a particle system that had never been wired up at all.
   * @see projectileGroup
   *
   * Arrows and plumes survive on purpose: a new tile catalogue is not a reason
   * for a shot already in the air to vanish or a fire to go out, and neither is
   * keyed by cell, so there is nothing in either that a rebuilt board
   * invalidates.
   */
  private discardGeometry() {
    this.clearMotionGhosts();
    for (const child of [...this.world.children]) {
      if (child === this.projectileGroup || child === this.particles.mesh) {
        continue;
      }
      this.world.remove(child);
      disposeObject3D(child);
    }
    this.levelGroups.clear();
    this.chunkGeometry.clear();
    // The rows only mean anything to the geometry that carried them, and that
    // has just gone. Kept across a *chunk* being dropped, cleared when the whole
    // world is.
    for (const table of this.animTablesByZ.values()) table.dispose();
    this.animTablesByZ.clear();
    for (const u of this.animUniformsByZ.values()) u.uAnimEnabled.value = 0;
    this.meshedWindow = null;
    this.tileEmittersByLevel.clear();
    this.tileEmittersStale = false;
    this.animated = [];
    this.animatedByKey.clear();
    this.movableMeshes.clear();
    this.movableBasePos.clear();
    this.movableBaseBox.clear();
  }

  /**
   * Build what has come into range, drop what has left, patch what changed.
   *
   * The three arms are deliberately separate rather than "drop everything
   * outside and rebuild everything inside": a chunk that is both still wanted
   * and unchanged is the overwhelming majority on every frame, and it must cost
   * a set lookup and a reference compare. That compare is the map's own
   * copy-on-write identity — a step rewrites the one chunk it crossed and
   * leaves every other chunk the same object.
   */
  private syncChunks(next: MapFile, window: WorldRect) {
    const prev = this.prevMap;
    const wanted = visibleChunkKeys(next, window);
    const dirty = prev ? this.dirtyChunks(prev, next, wanted) : wanted;

    for (const key of [...this.chunkGeometry.keys()]) {
      if (!wanted.has(key)) this.dropChunk(key);
    }

    let meshesChanged = false;
    for (const key of wanted) {
      const { z, chunk } = parseChunkAddress(key);
      const built = this.chunkGeometry.get(key);
      if (built && dirty.has(key)) {
        this.dropChunk(key);
        this.buildChunk(next, z, chunk);
        meshesChanged = true;
        continue;
      }
      if (!built) {
        this.buildChunk(next, z, chunk);
        meshesChanged = true;
        continue;
      }
      // Unchanged merged geometry, by {@link dirtyChunks}. What is left is
      // whatever moved *through* the chunk, which is a mesh of its own and can
      // be swapped without touching the batch.
      if (prev && getChunk(prev, z, chunk) === getChunk(next, z, chunk)) continue;
      this.patchChunkSeparates(prev!, next, built);
      meshesChanged = true;
    }

    // Dropping a chunk changes the animated index as much as building one does,
    // so this is not gated on `meshesChanged`: a chunk that only scrolled off
    // has taken its animated instances with it.
    this.rebuildAnimatedIndex();
    if (meshesChanged) this.world.updateMatrixWorld(true);
    this.prevMap = next;
    this.meshedWindow = window;
  }

  /**
   * The built chunks whose **merged** geometry this edit moved.
   *
   * The one question worth asking carefully, because the answer decides between
   * rebuilding a chunk and swapping one sprite. A changed *cell* is not a
   * changed batch: a creature stepping rewrites two cells and neither is in the
   * merged batch at all, which is the case every frame of ordinary play. So the
   * test is the cell's merged contribution before and after, through the same
   * {@link cellItems} the build uses.
   *
   * **The ring is why this is not asked chunk by chunk.** An autotile reads its
   * eight neighbours, so a wall placed at the edge of one chunk restyles cells
   * in the chunk next door without those cells changing. When geometry was one
   * batch per floor that fell out for free — the whole floor was rebuilt. Per
   * chunk it has to be said out loud, and the failure it prevents is a visible
   * seam at a chunk boundary that nothing later would repair.
   *
   * A cell outside the built set is skipped before its signature is computed,
   * so an edit in an unwatched corner of the world costs the walk and nothing
   * else.
   */
  private dirtyChunks(
    prev: MapFile,
    next: MapFile,
    wanted: ReadonlySet<string>,
  ): Set<string> {
    const dirty = new Set<string>();
    if (prev === next) return dirty;

    for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
      if (prev.levels[levelKey(z)] === next.levels[levelKey(z)]) continue;
      const changed = changedCellsOnLevel(prev, next, z);
      if (changed.size === 0) continue;

      // Past a paint stroke's worth, stop asking one cell at a time and dirty
      // everything the edit and its ring could possibly have restyled. The
      // comparison is two `cellItems` builds a cell, so at this size it costs
      // more than the rebuilds it is trying to avoid — and an edit that large
      // is somebody in the editor rather than the world going about its
      // business.
      if (changed.size > MAX_ANALYSED_CELLS) {
        for (const key of withNeighbourRing(changed)) {
          const { x, y } = parseCoordKey(key);
          const addr = chunkAddressKey(z, chunkKeyFor(x, y));
          if (wanted.has(addr)) dirty.add(addr);
        }
        continue;
      }

      // **The ring is only owed to a cell that could restyle its neighbours**,
      // and what a tick actually changes is where creatures are standing. A rat
      // is in no autotile's vocabulary, so its step is asked about on its own
      // cell and nowhere else — which turns the common frame from nine
      // signature comparisons per changed cell into one.
      for (const key of this.restyled(prev, next, z, changed)) {
        const { x, y } = parseCoordKey(key);
        const addr = chunkAddressKey(z, chunkKeyFor(x, y));
        if (!wanted.has(addr) || dirty.has(addr)) continue;
        if (
          this.mergedSignatureAt(prev, z, x, y) !==
          this.mergedSignatureAt(next, z, x, y)
        ) {
          dirty.add(addr);
        }
      }
    }
    return dirty;
  }

  /**
   * The cells whose merged contribution has to be compared, given what changed.
   *
   * Every changed cell, plus the eight around any of them that touched a tile
   * an autotile reads — see {@link autotileVocabulary}. A creature stepping
   * therefore costs its own two cells and nothing else, while placing a wall
   * costs the ring that wall can restyle.
   */
  private restyled(
    prev: MapFile,
    next: MapFile,
    z: number,
    changed: ReadonlySet<string>,
  ): Set<string> {
    if (this.autotileVocabFor !== this.tilesById) {
      this.autotileVocab = autotileVocabulary(this.tilesById);
      this.autotileVocabFor = this.tilesById;
    }
    const vocabulary = this.autotileVocab;
    // Nothing in the catalogue autotiles, so nothing has neighbours to notice.
    if (vocabulary.size === 0) return new Set(changed);

    const out = new Set(changed);
    const restyling: string[] = [];
    for (const key of changed) {
      const { x, y } = parseCoordKey(key);
      const before = autotileInputOf(getStack(prev, x, y, z), vocabulary);
      const after = autotileInputOf(getStack(next, x, y, z), vocabulary);
      if (before !== after) restyling.push(key);
    }
    if (restyling.length === 0) return out;
    for (const key of withNeighbourRing(restyling)) out.add(key);
    return out;
  }

  /**
   * Swap the own-mesh tiles of a chunk whose merged batch did not move.
   *
   * Everything a tick of ordinary play produces lands here: a creature is a
   * mobile tile, a mobile tile is never merged, and so a step is a mesh
   * replaced inside a group that is otherwise untouched. That the batch really
   * is unchanged is {@link dirtyChunks}'s finding, not an assumption made here.
   *
   * Ordering inside the group is not a concern: depth comes from the box
   * attribute each quad carries, resolved per fragment, so a mesh appended late
   * still sorts where it belongs.
   */
  private patchChunkSeparates(
    prev: MapFile,
    next: MapFile,
    entry: ChunkGeometry,
  ) {
    const { z, chunk } = entry;
    const changed = changedCellsInChunk(prev, next, z, chunk);
    for (const key of changed) {
      const { x, y } = parseCoordKey(key);
      this.removeSeparatesAt(entry, x, y);
      this.removeTileEmittersAt(entry, x, y);
    }
    for (const key of changed) {
      const { x, y } = parseCoordKey(key);
      for (const item of this.cellItems(next, z, x, y, getStack(next, x, y, z))) {
        // Ahead of the separates filter, and that placement is the whole reason
        // this is not inside it: the merged tiles this loop skips are exactly
        // the still, unanimated ones a chimney is.
        if (item.emitter) {
          entry.emitters.push(item.emitter);
          this.tileEmittersStale = true;
        }
        if (!item.anim && !item.tileKey) continue;
        this.installSeparate(entry, item);
      }
    }
  }

  /**
   * Every mesh and index entry one chunk owns, gone.
   *
   * Ordinary on every walk, which is what makes the bookkeeping worth being
   * exact about: a leftover key in {@link movableMeshes} points at geometry
   * that has been disposed, and the next motion frame writes attributes into
   * freed buffers.
   */
  private dropChunk(key: string) {
    const entry = this.chunkGeometry.get(key);
    if (!entry) return;

    for (const movableKey of entry.movableKeys) {
      this.movableMeshes.delete(movableKey);
      this.movableBasePos.delete(movableKey);
      this.movableBaseBox.delete(movableKey);
      this.disposeMotionGhost(movableKey);
    }
    entry.group.parent?.remove(entry.group);
    disposeObject3D(entry.group);
    this.chunkGeometry.delete(key);
    if (entry.emitters.length > 0) this.tileEmittersStale = true;
  }

  /**
   * Turn one chunk of one level into geometry.
   *
   * The same split the level build always made — merged batches per texture for
   * everything still, a mesh of its own for anything animated or mobile — with
   * the floor replaced by the chunk. Which is the whole change: the merged
   * batch an edit used to invalidate was 4,565 cells of ground on level 0 and
   * is now at most `CHUNK_SIZE` squared.
   */
  private buildChunk(map: MapFile, z: number, chunk: string) {
    const cells = getChunk(map, z, chunk);
    if (!cells) return;

    const items: BuildItem[] = [];
    for (const cellKey in cells) {
      const { x, y } = parseCoordKey(cellKey);
      for (const item of this.cellItems(map, z, x, y, cells[cellKey]!)) {
        items.push(item);
      }
    }
    if (items.length === 0) return;

    const group = new THREE.Group();
    group.name = `chunk:${z}:${chunk}`;
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    this.ensureLevelGroup(z).add(group);

    const entry: ChunkGeometry = {
      group,
      z,
      chunk,
      animated: [],
      emitters: [],
      movableKeys: new Set(),
    };
    this.chunkGeometry.set(chunkAddressKey(z, chunk), entry);

    // The table is the *level's*, not this chunk's: materials are keyed by
    // level, so every chunk on a floor reads one table. Rows are append-only, so
    // a chunk streaming in can add to it without renumbering the rows the
    // chunks already built are pointing at.
    const animTable = this.ensureAnimTable(z);
    const staticByTex = new Map<THREE.Texture, Quad[]>();
    for (const item of items) {
      // Before the split, because an emitting tile is as likely to be merged
      // into the floor's batch as to have a mesh of its own: a chimney does not
      // move and does not animate, and a plume is drawn by the particle layer
      // either way.
      if (item.emitter) entry.emitters.push(item.emitter);
      if (item.anim || item.tileKey) {
        this.installSeparate(entry, item);
      } else {
        if (item.mergedAnim) {
          item.animRow = animTable.add(
            item.mergedAnim.frames,
            item.mergedAnim.tileset,
          );
          item.animPhaseMs = item.mergedAnim.phaseMs;
        }
        let list = staticByTex.get(item.texture);
        if (!list) {
          list = [];
          staticByTex.set(item.texture, list);
        }
        list.push(item);
      }
    }

    this.publishAnimTable(z);

    for (const [tex, quads] of staticByTex) {
      const geo = buildMergedQuadGeometry(quads);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.materialFor(tex, z));
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }

    if (entry.emitters.length > 0) this.tileEmittersStale = true;
  }

  /** The merged-batch contribution of one cell, as a comparable string. */
  private mergedSignatureAt(
    map: MapFile,
    z: number,
    x: number,
    y: number,
  ): string {
    let sig = "";
    for (const item of this.cellItems(map, z, x, y, getStack(map, x, y, z))) {
      if (item.anim || item.tileKey) continue;
      const b = item.box;
      // The animation is part of the merged contribution now, so an edit that
      // changes which cycle a cell plays — or how far into it that cell starts —
      // has to fall through to a full rebuild rather than be read as unchanged.
      const a = item.mergedAnim;
      sig += `${item.x},${item.y},${item.w},${item.h}|${item.u0},${item.v0},${item.u1},${item.v1}|${b.eastPx},${b.southPx},${b.foot},${b.top}|${item.stackBias}|${item.unlit ? 1 : 0}|${item.texture.uuid}|${a ? `${a.frames.length},${a.phaseMs}` : ""}~`;
    }
    return sig;
  }

  /** Drop every own-mesh tile at a cell, so the cell can be rebuilt from scratch. */
  private removeSeparatesAt(entry: ChunkGeometry, x: number, y: number) {
    const prefix = `${entry.z}:${x},${y}:`;
    for (const key of entry.movableKeys) {
      if (!key.startsWith(prefix)) continue;
      const mesh = this.movableMeshes.get(key);
      if (mesh) {
        mesh.parent?.remove(mesh);
        mesh.geometry.dispose();
      }
      this.movableMeshes.delete(key);
      this.movableBasePos.delete(key);
      this.movableBaseBox.delete(key);
      this.disposeMotionGhost(key);
      entry.movableKeys.delete(key);
    }
    const kept = entry.animated.filter((inst) => !inst.key.startsWith(prefix));
    if (kept.length !== entry.animated.length) entry.animated = kept;
  }

  /**
   * Drop every plume a cell was giving off, so the cell can be rebuilt.
   *
   * Filtered by id prefix rather than by coordinate fields, on the terms
   * {@link removeSeparatesAt} does it: the id *is* the instance key, so one
   * spelling of "this cell" serves both indexes and there is no second parse of
   * the same string to get out of step.
   */
  private removeTileEmittersAt(entry: ChunkGeometry, x: number, y: number) {
    const prefix = tileEmitterPrefix(entry.z, x, y);
    const kept = entry.emitters.filter((spec) => !spec.id.startsWith(prefix));
    if (kept.length === entry.emitters.length) return;
    entry.emitters = kept;
    this.tileEmittersStale = true;
  }

  /**
   * Every built chunk's plumes, gathered by level for the frame's culling.
   *
   * Rebuilt outright rather than kept in step, and only when something has said
   * it is out of date: the whole world holds a handful of emitting placements,
   * so walking the built chunks costs less than maintaining a second index
   * through every drop, build and patch.
   */
  private refreshTileEmitters() {
    this.tileEmittersStale = false;
    this.tileEmittersByLevel.clear();
    for (const entry of this.chunkGeometry.values()) {
      if (entry.emitters.length === 0) continue;
      let list = this.tileEmittersByLevel.get(entry.z);
      if (!list) {
        list = [];
        this.tileEmittersByLevel.set(entry.z, list);
      }
      for (const spec of entry.emitters) list.push(spec);
    }
  }

  private rebuildAnimatedIndex() {
    this.animated = [];
    for (const entry of this.chunkGeometry.values()) {
      for (const inst of entry.animated) this.animated.push(inst);
    }
    this.animatedByKey.clear();
    for (const inst of this.animated) {
      let list = this.animatedByKey.get(inst.animKey);
      if (!list) {
        list = [];
        this.animatedByKey.set(inst.animKey, list);
      }
      list.push(inst);
    }
  }

  /**
   * Quads for one cell's stack.
   *
   * The single place a placed tile becomes geometry. Both the full level build
   * and the incremental one go through it, so the cheap path cannot silently
   * disagree with the expensive one about what a cell should look like — which
   * is the failure mode that makes incremental rendering hard to trust.
   */
  private cellItems(
    map: MapFile,
    z: number,
    x: number,
    y: number,
    stack: PlacedTile[],
  ): BuildItem[] {
    const items: BuildItem[] = [];
    // What sorts a slot is its *clump*, not its own volume — see `./depthClump`.
    // Computed once for the stack rather than per placement, because this runs
    // over every cell of a floor.
    const extents = clumpExtents(stack, this.tilesById);
    let elev = 0;

    stack.forEach((placed, stackIndex) => {
      const def = this.tilesById[placed.tileId];
      if (!def) return;

      const instanceKey = this.tileKey({ x, y, z, stackIndex });
      // The state is read at build time so a cell rebuilt while a creature is
      // mid-step comes back walking, rather than snapping to standing and
      // waiting for the next state pass to notice.
      const state = this.spriteStates?.get(instanceKey) ?? "idle";
      const sprite = resolveTileSprite(def, {
        state,
        direction: placed.direction,
        variant: placed.variant,
        map,
        x,
        y,
        z,
      });
      const frames = sprite?.frames;
      // The phase the shared clock is at, not frame 0. A rebuild happens on
      // whatever frame the world happened to change on — every step, for a
      // walker — and a mesh born at frame 0 would sit there until the clock
      // crossed into the *next* index, which is a walk cycle that restarts
      // several times a second. See `updateAnimations`.
      const frameIdx = frames ? frameIndexAtTime(frames, this.animClock) : 0;
      const live = frames?.[frameIdx];
      if (!live || !frames) return;

      const tileset = this.tilesetById.get(live.sprite.tilesetId);
      if (!tileset) return;

      const animates = frames.length > 1;
      // Own mesh only when the tile can *move* — not merely when it animates.
      // Animation used to be a reason too, because the only way to change a
      // frame was to rewrite the UVs of a mesh nobody else shared; the shader
      // reads the frame off a table now, so a still animated tile merges like
      // any other scenery. That is what makes a pond affordable: water is
      // terrain and arrives in hundreds, and hundreds of meshes is hundreds of
      // draw calls. See `./animTable`.
      //
      // Keying this on the live motion set was the older bug: a tile changed
      // batch membership the instant it started and stopped, and changing
      // membership rebuilds the whole floor — a full rebuild per step.
      //
      // `isMobileTile` also covers every tile that can change sprite state,
      // because `moving` is the only state and `availableStates` gates it on
      // exactly this predicate. A state that a still tile can be in — an opened
      // chest — would need its own term here; see plans/stateful-sprites.md.
      const separate = isMobileTile(def);
      // The shader moves a merged quad, so it is built at frame 0 and the table's
      // offsets are measured from there. A separate one is built at the frame the
      // clock is on and moved by `updateAnimations`. Mixing the two would shift a
      // sprite by however far the clock had run when its level was last rebuilt.
      const mergedAnim =
        !separate && animates && tableCanHold(frames)
          ? {
              frames,
              tileset,
              phaseMs: sprite ? cellPhaseMs(sprite, x, y) : 0,
            }
          : undefined;
      const art = mergedAnim ? frames[0]! : live;

      const foot = absoluteElevation(z, elev);
      const baseOrigin = baseCellWorldOrigin(x, y, z, elev);
      const origin = spriteWorldOrigin(baseOrigin, art.sprite.base);
      const { rect } = art.sprite;
      const w = rect.w * CELL_SIZE;
      const h = rect.h * CELL_SIZE;
      const u0 = (rect.x * CELL_SIZE) / tileset.width;
      const u1 = ((rect.x + rect.w) * CELL_SIZE) / tileset.width;
      const v1 = 1 - (rect.y * CELL_SIZE) / tileset.height;
      const v0 = 1 - ((rect.y + rect.h) * CELL_SIZE) / tileset.height;
      const texture = this.textures.get(tileset.id) ?? this.magentaTex;
      const animKey = animationKey(def, placed, x, y, z, state);

      // **A pile draws once per thing in it**, laid out like the pips on a die —
      // see `./pileLayout`. Everything else in the world is a pile of one and
      // takes the single centred offset, so this loop runs once and moves
      // nothing for all but a handful of cells.
      //
      // A tile with a mesh of its own draws once whatever its count says, and
      // the reason is `tileKey` and `anim` below: both name *one* mesh, and a
      // second copy carrying either would collide in `movableMeshes` or leave a
      // stale entry in the animated list. Nothing that piles is animated or
      // mobile — only food piles — so this is a rule that keeps the invariant
      // rather than one anybody trips over.
      const offsets = separate ? NO_PILE_OFFSET : pileOffsets(countOf(placed));
      const stackBias = depthStackBias(z, stackIndex);
      // **A heap declares a body, however flat the tile it is made of.**
      //
      // A pile's sprites are spread across their cell, so the southern ones hang
      // over the cell in front — and `../lib/geometry`'s `boxSurface` rescues
      // that art only for a box with volume, on the grounds that a *flat* tile's
      // art past its own foot is more floor and two coplanar floors keep painter
      // order. That is right about a floor and wrong about a heap of berries,
      // which is an object lying on the ground: without this the bottom of every
      // pile is drawn under the floor of the cell in front of it.
      //
      // A hair of one, not a real height — see {@link DEPTH_LEAST_BODY}. What
      // the tile declares still wins where it declares anything, and the height
      // that decides stacking and gravity is untouched: this is a fact about
      // sorting, and it lives here rather than on the tile because that is all
      // it is.
      const extent = extents[stackIndex] ?? { foot: elev, top: elev };
      const boxFoot = absoluteElevation(z, extent.foot);
      const boxTop = absoluteElevation(z, extent.top);
      const box = depthBox(
        x,
        y,
        boxFoot,
        offsets.length > 1
          ? Math.max(boxTop, boxFoot + DEPTH_LEAST_BODY)
          : boxTop,
      );

      // Anchored to the cell and sorted with the placement, which is the rule
      // `./particles` states and the reason it is built here: a plume takes the
      // depth box of the thing it comes off, so a chimney's smoke is in front of
      // the chimney at every pixel they share and behind whatever is nearer.
      //
      // Its foot is the placement's own, so an author's spawn elevation is
      // measured from the tile the plume belongs to rather than from the floor
      // of the cell — smoke leaves the pot on top of the stack, not the bricks
      // under it.
      const emitter: ParticleEmitterSpec | undefined = def.particles
        ? {
            id: tileEmitterId(instanceKey),
            config: def.particles,
            cx: x + CELL_CENTRE,
            cy: y + CELL_CENTRE,
            footElev: foot,
            z,
            box,
            stackBias,
            // A tile is never winding down: a taper is what is left of a status,
            // and a chimney has nothing left to run.
            taper: 1,
          }
        : undefined;

      // An indexed loop rather than `forEach`: this runs once per placement on a
      // floor — thousands of them per rebuild — and a callback here is a closure
      // allocated per tile to walk a list that is one long for all but a handful
      // of them.
      for (let i = 0; i < offsets.length; i++) {
        const offset = offsets[i]!;
        items.push({
          x: origin.x + offset.dx,
          y: origin.y + offset.dy,
          w,
          h,
          u0,
          v0,
          u1,
          v1,
          box,
          // Inside one stack index, so the sprites of a heap overlap front to
          // back without the heap moving relative to anything above or below it
          // in the stack. See `pileDepthNudge`.
          stackBias: stackBias + pileDepthNudge(i, offsets.length),
          texture,
          lightX0: x,
          lightY0: y,
          lightX1: x + 1,
          lightY1: y + 1,
          unlit: tileCanEmitLight(def),
          tileKey: separate ? instanceKey : undefined,
          mergedAnim,
          // On the first quad only — a heap of six berries is one placement and
          // gives off one plume, not six.
          emitter: i === 0 ? emitter : undefined,
          // Registered when it merely *can* change state, not only when it
          // animates: a creature standing still on one frame becomes a four-frame
          // walk cycle the moment it steps, and the registry is what the state
          // pass reaches it through.
          // Only a tile with a mesh of its own: everything else animates in the
          // shader, and an entry here would hand it a mesh to rewrite.
          anim:
            separate && (animates || hasSpriteStates(def))
              ? {
                  frames,
                  tileset,
                  animKey,
                  def,
                  placed,
                  cell: { x, y, z },
                  state,
                  frameIdx,
                }
              : undefined,
        });
      }

      // Through `terrainHeight` and never `physicalHeight`: a body adds nothing
      // to what is drawn above it, and summing two people in a cell puts the
      // second one's feet on the first one's head.
      elev += terrainHeight(placed, this.tilesById);
    });

    return items;
  }

  /** Give an item its own mesh and register it in whichever indexes claim it. */
  private installSeparate(entry: ChunkGeometry, item: BuildItem) {
    const mesh = this.addQuadMesh(entry.group, item, item.texture, entry.z);
    if (item.tileKey) {
      entry.movableKeys.add(item.tileKey);
      this.movableMeshes.set(item.tileKey, mesh);
      this.movableBasePos.set(item.tileKey, {
        x: mesh.position.x,
        y: mesh.position.y,
      });
      this.movableBaseBox.set(item.tileKey, {
        box: item.box,
        stackBias: item.stackBias,
      });
    }
    if (item.anim) {
      entry.animated.push({ mesh, key: item.tileKey ?? "", ...item.anim });
    }
  }

  private addQuadMesh(
    parent: THREE.Object3D,
    quad: Quad,
    texture: THREE.Texture,
    z: number,
  ): THREE.Mesh {
    const geo = buildSingleQuadGeometry(quad);
    const mesh = new THREE.Mesh(geo, this.materialFor(texture, z));
    mesh.position.set(quad.x + quad.w / 2, quad.y + quad.h / 2, 0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    parent.add(mesh);
    return mesh;
  }

  /**
   * Point every animated mesh at the frame {@link animClock} says is live.
   *
   * The index is a pure function of the shared clock, so two placements of one
   * sprite are on the same frame by construction rather than by having started
   * together — and a sprite's cadence is the cadence its frames are authored
   * with, whatever the frame rate.
   *
   * The skip is per instance, not per key. Keying it off the shared index was
   * the bug that made walking look erratic: a step rebuilds the walker's mesh
   * at build-time UVs, and a shared index that already read `2` said "nothing
   * to write" about a mesh that was showing something else entirely.
   */
  private updateAnimations(): boolean {
    // The merged batch's animations are a function of this one number, so a
    // pond costs a uniform write per level rather than a UV rewrite per cell.
    // Whether it *looks* different is the separate question `crossedFrame`
    // answers, so a world sitting between two frames still stops rendering.
    let changed = false;
    for (const [z, u] of this.animUniformsByZ) {
      if (u.uAnimEnabled.value === 0) continue;
      const table = this.animTablesByZ.get(z);
      if (table?.crossedFrame(u.uAnimClockMs.value, this.animClock)) {
        changed = true;
      }
      u.uAnimClockMs.value = this.animClock;
    }
    if (this.animatedByKey.size === 0) return changed;

    for (const [key, instances] of this.animatedByKey) {
      const sample = instances[0]!;
      const idx = frameIndexAtTime(sample.frames, this.animClock);
      this.frameIndices.set(key, idx);

      const frame = sample.frames[idx];
      if (!frame) continue;
      for (const inst of instances) {
        if (inst.frameIdx === idx) continue;
        inst.frameIdx = idx;
        writeFrameUvs(inst.mesh, frame, sample.tileset);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Point every stateful mesh at the sprite its current {@link SpriteState}
   * resolves to.
   *
   * A sibling of {@link applyTileMotions} rather than part of the map build, for
   * the reason that pass is separate too: a state changes on a frame where the
   * map has not, so routing it through the rebuild would mean inventing a map
   * edit to trigger one. Here it costs a walk of the registry, which holds only
   * the handful of meshes that can change at all.
   *
   * Only the frame *list* is replaced. The mesh's geometry keeps the footprint it
   * was built with, which is why a state's sprites must match idle's `rect` and
   * `base` — the same constraint the animation path has always had between the
   * frames of one sprite, applied one level up. See `validateStateFootprints`.
   */
  /**
   * Put each placement in the colour its statuses say it is wearing, and take
   * the colour off anything that has stopped wearing one.
   *
   * Reaches only placements with their own mesh, which is every actor — see
   * {@link WorldView.spriteTints}. A key naming a merged tile finds nothing in
   * {@link movableMeshes} and is dropped; that is the documented limit rather
   * than a miss, and it is why the status editor draws its subject as a mesh of
   * its own.
   *
   * The whole pass is skipped on the overwhelmingly common frame where nobody is
   * tinted and nobody was tinted last frame, which is every frame of a world
   * where nothing has been poisoned.
   */
  private applySpriteTints(tints: ReadonlyMap<string, StatusTint> | undefined) {
    if (!tints?.size && this.tintedMeshes.size === 0) return;

    for (const [key, worn] of this.tintedMeshes) {
      if (tints?.has(key)) continue;
      // A level rebuilt under a tinted placement hands back a fresh, untinted
      // mesh, and the one held here is off the graph. Restoring onto it would
      // write to a mesh nobody draws.
      if (this.movableMeshes.get(key) === worn.mesh) {
        worn.mesh.material = this.materialFor(worn.texture, worn.z, null);
      }
      this.tintedMeshes.delete(key);
    }

    for (const [key, tint] of tints ?? EMPTY_TINTS) {
      const mesh = this.movableMeshes.get(key);
      if (!mesh) continue;
      const tintKey = tintCacheKey(tint);
      const held = this.tintedMeshes.get(key);
      // Nothing to do for a placement already wearing this exact colour on this
      // exact mesh, which is every frame after the first. It is not merely a
      // saving: `materialFor` marks the material it hands back as needing an
      // update, and doing that per frame asks the driver to revisit the program
      // sixty times a second for a uniform that has not moved.
      if (held && held.mesh === mesh && held.tintKey === tintKey) continue;

      const texture = held?.texture ?? (mesh.material as THREE.MeshBasicMaterial).map;
      if (!texture) continue;
      const z = tileInstanceLevel(key);
      mesh.material = this.materialFor(texture, z, tint);
      this.tintedMeshes.set(key, { mesh, texture, z, tintKey });
    }
  }

  private applySpriteStates(states: ReadonlyMap<string, SpriteState> | undefined) {
    if (this.animated.length === 0) return;
    let swapped = false;

    for (const inst of this.animated) {
      const next = states?.get(inst.key) ?? "idle";
      if (next === inst.state) continue;

      const { x, y, z } = inst.cell;
      const frames = getFrames(inst.def, {
        state: next,
        direction: inst.placed.direction,
        variant: inst.placed.variant,
        map: this.prevMap ?? undefined,
        x,
        y,
        z,
      });
      // A state with nothing authored resolves to idle's frames, so this is only
      // empty for a tile with no sprite at all — leave the mesh as it is rather
      // than blanking it.
      if (!frames?.length) continue;

      const idx = frameIndexAtTime(frames, this.animClock);
      inst.state = next;
      inst.frames = frames;
      inst.animKey = animationKey(inst.def, inst.placed, x, y, z, next);
      inst.frameIdx = idx;
      writeFrameUvs(inst.mesh, frames[idx]!, inst.tileset);
      swapped = true;
    }

    if (!swapped) return;
    this.rebuildAnimatedIndex();
    this.needsRender = true;
  }
}

/** Point one quad at a frame's slice of its atlas. */
/**
 * A frame's slice of its atlas, in texture coordinates.
 *
 * Written down once because three places need it — the level build, the
 * animation pass and the projectile pass — and the v axis is flipped, which is
 * exactly the kind of arithmetic that gets copied slightly wrong.
 */
function frameUvs(
  frame: Frame,
  tileset: TilesetDef,
): { u0: number; v0: number; u1: number; v1: number } {
  const { rect } = frame.sprite;
  return {
    u0: (rect.x * CELL_SIZE) / tileset.width,
    u1: ((rect.x + rect.w) * CELL_SIZE) / tileset.width,
    v1: 1 - (rect.y * CELL_SIZE) / tileset.height,
    v0: 1 - ((rect.y + rect.h) * CELL_SIZE) / tileset.height,
  };
}

function writeFrameUvs(
  mesh: THREE.Mesh,
  frame: Frame,
  tileset: TilesetDef,
): void {
  const { u0, v0, u1, v1 } = frameUvs(frame, tileset);
  const uvs = mesh.geometry.attributes.uv!;
  uvs.setXY(0, u0, v0);
  uvs.setXY(1, u1, v0);
  uvs.setXY(2, u0, v1);
  uvs.setXY(3, u1, v1);
  uvs.needsUpdate = true;
}
