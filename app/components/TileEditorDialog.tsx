import { useEffect, useState } from "react";
import { WALK_DURATION_MS } from "../game/constants";
import type {
  AutotileSlice,
  Direction,
  Frame,
  LightDef,
  SpriteRef,
  OverrideSpriteState,
  SpriteState,
  StateSprites,
  TileDef,
  TileHeight,
  TileSprite,
  TileType,
  TilesetDef,
  VariantKey,
} from "../lib/types";
import {
  AUTOTILE_SLICE_COUNT,
  DIRECTIONS,
  climbFromForSave,
  defaultBase,
  isAnimated,
  isDirectional,
  resolveClimbFrom,
  resolveIntangible,
  resolveLightPassing,
  resolveWalkable,
} from "../lib/types";
import { SpriteSelector } from "./SpriteSelector";
import { TilePreview } from "./TilePreview";
import {
  AutotileSlicePreview,
  autotileSliceTitle,
} from "./AutotileSlicePreview";
import { InteractiveTab } from "./InteractiveTab";
import { BattleTab } from "./BattleTab";
import { ItemTab } from "./ItemTab";
import { RespawnTab } from "./RespawnTab";
import { BrainEditor } from "./BrainEditor";
import {
  availableStates,
  hasAnyInteraction,
  interactionsForSave,
} from "../lib/interactions";
import { validateBrain, type BrainDef } from "../lib/brain";
import { Button, Dialog, Input, Segmented, Select, TabPanel, Tabs } from "../ui";

function emptyFrame(tilesetId: string): Frame {
  const rect = { x: 0, y: 0, w: 1, h: 1 };
  return {
    sprite: { tilesetId, rect, base: defaultBase(rect) },
    durationMs: 200,
  };
}

function emptySprite(tilesetId: string): TileSprite {
  return { frames: [emptyFrame(tilesetId)] };
}

const DEFAULT_LIGHT: LightDef = {
  radius: 5,
  intensity: 1,
  color: "#ffcc88",
};

function blankTile(tilesets: TilesetDef[]): TileDef {
  const ts = tilesets[0]?.id ?? "";
  return {
    id: "",
    name: "New Tile",
    height: 0,
    type: "simple",
    // Scenery until somebody says otherwise: the overwhelming majority of tiles
    // are, and it is the one kind that opens no extra tab to be dismissed.
    kind: "prop",
    attributes: {},
    lightPassing: false,
    intangible: false,
    walkable: true,
    climbFrom: { default: { n: true, e: true, s: true, w: true } },
    sprite: emptySprite(ts),
  };
}

function expandClimbFrom(tile: TileDef): NonNullable<TileDef["climbFrom"]> {
  const keys: VariantKey[] = isDirectional(tile) ? [...DIRECTIONS] : ["default"];
  const out: NonNullable<TileDef["climbFrom"]> = {};
  for (const key of keys) {
    out[key] = resolveClimbFrom(tile, key);
  }
  return out;
}

/** Normalise optional lighting / traversal fields for the editor draft. */
function withLightingDefaults(tile: TileDef): TileDef {
  const { blocksLight: _deprecated, ...rest } = tile;
  return {
    ...rest,
    lightPassing: resolveLightPassing(tile),
    intangible: resolveIntangible(tile),
    walkable: resolveWalkable(tile),
    climbFrom: expandClimbFrom(tile),
  };
}

/**
 * The sprite holder the editor is currently writing into.
 *
 * `idle` is the draft itself, because that is where the idle sprites live — see
 * {@link TileDef.states}. Any other state is its entry, which the state selector
 * guarantees exists before it is selected.
 */
function spriteHolder(draft: TileDef, state: SpriteState): StateSprites {
  return state === "idle" ? draft : (draft.states?.[state] ?? {});
}

function currentSprite(
  draft: TileDef,
  state: SpriteState,
  dir: Direction,
  slice: AutotileSlice,
): TileSprite | undefined {
  const from = spriteHolder(draft, state);
  if (draft.type === "simple") return from.sprite;
  if (draft.type === "directional") return from.sprites?.[dir];
  return from.slices?.[slice];
}

/** The one sprite field this tile's {@link TileType} uses, patched. */
function patchHolder(
  draft: TileDef,
  state: SpriteState,
  dir: Direction,
  slice: AutotileSlice,
  sprite: TileSprite,
): StateSprites {
  const from = spriteHolder(draft, state);
  if (draft.type === "simple") return { sprite };
  if (draft.type === "directional") {
    return { sprites: { ...from.sprites, [dir]: sprite } };
  }
  return { slices: { ...from.slices, [slice]: sprite } };
}

function setCurrentSprite(
  draft: TileDef,
  state: SpriteState,
  dir: Direction,
  slice: AutotileSlice,
  sprite: TileSprite,
): TileDef {
  const patch = patchHolder(draft, state, dir, slice, sprite);
  if (state === "idle") return { ...draft, ...patch };
  return { ...draft, states: { ...draft.states, [state]: patch } };
}

/**
 * Idle's sprites alone, on this tile's own axis.
 *
 * Narrowed to the one field the type uses rather than handed over as the draft,
 * which is structurally a {@link StateSprites} but carries the id, the name and
 * every behaviour flag with it. A state override holding those would be a second
 * copy of the tile inside the tile.
 */
function idleSprites(draft: TileDef): StateSprites {
  if (draft.type === "simple") return { sprite: draft.sprite };
  if (draft.type === "directional") return { sprites: draft.sprites };
  return { slices: draft.slices };
}

/** Every sprite a {@link StateSprites} holds, on this tile's own axis. */
function stateSpriteList(
  draft: TileDef,
  from: StateSprites,
): TileSprite[] {
  if (draft.type === "simple") return from.sprite ? [from.sprite] : [];
  if (draft.type === "directional") {
    return DIRECTIONS.map((d) => from.sprites?.[d]).filter(
      (s): s is TileSprite => s != null,
    );
  }
  return Object.values(from.slices ?? {}).filter(
    (s): s is TileSprite => s != null,
  );
}

/**
 * The footprint a sprite draws at — its size in cells and where its base sits.
 *
 * Compared rather than the whole sprite because this is the one thing a state
 * may *not* differ from idle in: a separate mesh's geometry is built once from
 * frame 0 and only its UVs are rewritten afterwards, so a state of another size
 * would draw the new art stretched over the old quad. It is the same constraint
 * the frames of a single sprite have always had between them, one level up.
 */
function footprintOf(sprite: TileSprite | undefined): string | null {
  const first = sprite?.frames[0];
  if (!first) return null;
  const { rect, base } = first.sprite;
  return `${rect.w}x${rect.h}@${base.x},${base.y}`;
}

/**
 * Whether every sprite in `state` draws at the footprint idle does.
 *
 * Reported as a message rather than repaired, because there is no honest repair:
 * the author drew a sprite at a size, and silently cropping or re-basing it would
 * make their art wrong in a way that only shows up in the world.
 */
function footprintMismatch(
  draft: TileDef,
  state: OverrideSpriteState,
  override: StateSprites,
): string | null {
  const idle = idleSprites(draft);
  const check = (label: string, a: TileSprite | undefined, b: TileSprite | undefined) => {
    const want = footprintOf(a);
    const got = footprintOf(b);
    if (want == null || got == null || want === got) return null;
    return `${state} ${label}: sprite is ${got} but idle is ${want} — a state must draw at idle's size and base`;
  };

  if (draft.type === "simple") return check("sprite", idle.sprite, override.sprite);
  if (draft.type === "directional") {
    for (const d of DIRECTIONS) {
      const err = check(d.toUpperCase(), idle.sprites?.[d], override.sprites?.[d]);
      if (err) return err;
    }
    return null;
  }
  for (const key of Object.keys(override.slices ?? {})) {
    const i = Number(key);
    const err = check(`slice ${i}`, idle.slices?.[i], override.slices?.[i]);
    if (err) return err;
  }
  return null;
}

/**
 * The states worth persisting: those a tile can actually be in, and that
 * actually differ from idle.
 *
 * Dropping a state equal to idle is what lets the selector seed a new state from
 * idle without that act *being* an edit — clicking through the rail to look at
 * `moving` leaves the file alone. Dropping a state the tile cannot be in keeps a
 * stale override from sitting in the data after a `kind` change made it
 * unreachable, on the same terms `interactionsForSave` drops a blank block.
 */
function statesForSave(draft: TileDef): TileDef["states"] {
  const allowed = new Set(availableStates(draft));
  const idle = JSON.stringify(idleSprites(draft));
  const out: NonNullable<TileDef["states"]> = {};
  let any = false;

  for (const [key, sprites] of Object.entries(draft.states ?? {})) {
    const state = key as OverrideSpriteState;
    if (!sprites || !allowed.has(state)) continue;
    if (JSON.stringify(sprites) === idle) continue;
    out[state] = sprites;
    any = true;
  }
  return any ? out : undefined;
}

function validateFrameLights(frames: Frame[]): string | null {
  for (let i = 0; i < frames.length; i++) {
    const light = frames[i]?.light;
    if (!light) continue;
    if (!(light.radius > 0) || !Number.isFinite(light.radius)) {
      return `Frame ${i + 1}: light radius must be a positive number`;
    }
    if (
      !(light.intensity >= 0) ||
      !(light.intensity <= 1) ||
      !Number.isFinite(light.intensity)
    ) {
      return `Frame ${i + 1}: light intensity must be between 0 and 1`;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(light.color)) {
      return `Frame ${i + 1}: light colour must be a hex like #ffcc88`;
    }
  }
  return null;
}

function sanitizeSprite(sprite: TileSprite): TileSprite {
  return {
    frames: sprite.frames.map((f) => {
      if (!f.light) return f;
      return {
        ...f,
        light: {
          radius: f.light.radius,
          intensity: f.light.intensity,
          color: f.light.color.toLowerCase(),
        },
      };
    }),
  };
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tile: TileDef | null;
  /** Whole library — the interactive tab picks tile ids out of it. */
  tiles: TileDef[];
  tilesets: TilesetDef[];
  isNew: boolean;
  onSave: (tile: TileDef) => void;
  onDelete?: () => void;
};

/**
 * What each state means, and — for the two nothing drives yet — that it is not
 * wired up.
 *
 * Saying so in the dialog rather than only in a plan, because a sprite that is
 * authored and never drawn is otherwise indistinguishable from a bug, and the
 * person who would report it is the person reading this line.
 */
const STATE_HINTS: Record<SpriteState, string> = {
  idle: "How this looks at rest. Every other state falls back to it, per direction.",
  moving: "While it is crossing a cell or falling.",
  attacking: "Mid-swing. Not drawn yet — no swing reaches the client.",
  open: "A container somebody has open, or a reward you have taken. Not drawn yet.",
};

const TAB_TILE = "tile";
const TAB_INTERACTIVE = "interactive";
const TAB_BRAIN = "brain";
const TAB_BATTLE = "battle";
const TAB_ITEM = "item";
const TAB_RESPAWN = "respawn";

export function TileEditorDialog({
  open,
  onOpenChange,
  tile,
  tiles,
  tilesets,
  isNew,
  onSave,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<TileDef>(() =>
    withLightingDefaults(tile ?? blankTile(tilesets)),
  );
  const [tab, setTab] = useState(TAB_TILE);
  const [dir, setDir] = useState<Direction>("n");
  const [slice, setSlice] = useState<AutotileSlice>(0);
  const [state, setState] = useState<SpriteState>("idle");
  const [frameIndex, setFrameIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const next = withLightingDefaults(tile ?? blankTile(tilesets));
    setDraft(next);
    setTab(TAB_TILE);
    setDir("n");
    setSlice(0);
    setState("idle");
    setFrameIndex(0);
    setError(null);
  }, [open, tile, tilesets]);

  const sprite = currentSprite(draft, state, dir, slice);
  const frames = sprite?.frames ?? [];
  const frame = frames[frameIndex] ?? frames[0];
  const definedSlice =
    draft.type === "autotile"
      ? Boolean(spriteHolder(draft, state).slices?.[slice])
      : true;
  const tileset =
    tilesets.find((t) => t.id === frame?.sprite.tilesetId) ?? tilesets[0] ?? null;

  const setSprite = (next: TileSprite) => {
    setDraft((d) => setCurrentSprite(d, state, dir, slice, next));
  };

  const states = availableStates(draft);

  /**
   * Move to a state, seeding it from idle the first time.
   *
   * Cloning rather than starting blank, on the same grounds the autotile grid
   * clones slice 0 when you click an empty cell: a walk cycle is idle plus
   * changes, and an empty canvas throws away the frame you would have started
   * from. Save drops a state that still equals idle, so looking is not
   * authoring — see `statesForSave`.
   */
  const changeState = (next: SpriteState) => {
    setState(next);
    setFrameIndex(0);
    if (next === "idle" || draft.states?.[next]) return;
    setDraft((d) => ({
      ...d,
      states: { ...d.states, [next]: structuredClone(idleSprites(d)) },
    }));
  };

  const setFrames = (next: Frame[]) => {
    setSprite({ frames: next });
  };

  const updateFrame = (patch: Partial<Frame>) => {
    if (!frame) return;
    setFrames(
      frames.map((f, i) => (i === frameIndex ? { ...f, ...patch } : f)),
    );
  };

  const setFrameSprite = (s: SpriteRef) => {
    updateFrame({ sprite: s });
  };

  const changeType = (type: TileType) => {
    if (type === draft.type) return;
    // Every state keys its sprites on the axis the *type* chooses, so overrides
    // authored against the old one describe nothing after the swap. Dropped
    // rather than carried across as copies of the new idle, which is what they
    // would collapse to on save anyway.
    setState("idle");
    const ts = tilesets[0]?.id ?? "";
    const from =
      draft.sprite ??
      draft.sprites?.n ??
      draft.sprites?.s ??
      draft.slices?.[0] ??
      emptySprite(ts);

    if (type === "simple") {
      if (
        draft.type !== "simple" &&
        !confirm("Convert to simple? Keeping current sprite as default.")
      ) {
        return;
      }
      setDraft({
        ...draft,
        type: "simple",
        sprite: structuredClone(from),
        sprites: undefined,
        slices: undefined,
        states: undefined,
        climbFrom: { default: resolveClimbFrom(draft, isDirectional(draft) ? dir : "default") },
      });
    } else if (type === "directional") {
      const sprites: Partial<Record<Direction, TileSprite>> = {};
      const climbBase = resolveClimbFrom(draft, "default");
      const climbFrom: NonNullable<TileDef["climbFrom"]> = {};
      for (const d of DIRECTIONS) {
        sprites[d] = structuredClone(
          draft.sprites?.[d] ?? draft.sprite ?? from,
        );
        climbFrom[d] = { ...climbBase };
      }
      setDraft({
        ...draft,
        type: "directional",
        sprite: undefined,
        sprites,
        slices: undefined,
        states: undefined,
        climbFrom,
      });
      setDir("n");
    } else {
      setDraft({
        ...draft,
        type: "autotile",
        sprite: undefined,
        sprites: undefined,
        slices: { 0: structuredClone(from) },
        states: undefined,
        climbFrom: { default: resolveClimbFrom(draft, "default") },
      });
      setSlice(0);
    }
    setFrameIndex(0);
  };

  // A brain implies actorhood, so the Tile tab reflects that rather than letting
  // the checkbox and the Interactive tab disagree — see `resolveActor`.
  const impliedByBrain = draft.interactions?.brain != null;
  const isActor = draft.actor === true || impliedByBrain;

  const setBrain = (next: BrainDef | undefined) => {
    const merged = { ...draft.interactions };
    if (next == null) delete merged.brain;
    else merged.brain = next;
    setDraft({
      ...draft,
      interactions: hasAnyInteraction(merged) ? merged : undefined,
    });
  };

  // Whether the Interactive tab has anything, brain aside — its own tab now.
  const i = draft.interactions;
  const hasNonBrainInteraction = Boolean(
    i?.push || i?.switch || i?.decay || i?.pressurePlate || i?.emit || i?.receive,
  );

  const climbVariant: VariantKey = isDirectional(draft) ? dir : "default";
  const climbFlags = resolveClimbFrom(draft, climbVariant);

  const setClimbSide = (side: Direction, value: boolean) => {
    setDraft({
      ...draft,
      climbFrom: {
        ...draft.climbFrom,
        [climbVariant]: { ...climbFlags, [side]: value },
      },
    });
  };

  const handleSave = () => {
    if (!draft.id.trim()) {
      setError("Id is required");
      return;
    }
    if (!/^[a-z0-9-]+$/.test(draft.id)) {
      setError("Id must be lowercase letters, numbers, and hyphens");
      return;
    }
    if (!draft.name.trim()) {
      setError("Name is required");
      return;
    }

    // A brain that would load inert is caught here, where it is actionable,
    // rather than as a creature that silently never moves once online.
    const brain = draft.interactions?.brain;
    if (brain) {
      const fatal = validateBrain(brain).find((i) => i.severity === "error");
      if (fatal) {
        setError(`Brain: ${fatal.message}`);
        return;
      }
    }

    if (draft.type === "simple") {
      if (!draft.sprite?.frames.length) {
        setError("At least one frame is required");
        return;
      }
      const err = validateFrameLights(draft.sprite.frames);
      if (err) {
        setError(err);
        return;
      }
    } else if (draft.type === "directional") {
      for (const d of DIRECTIONS) {
        if (!draft.sprites?.[d]?.frames.length) {
          setError(`Missing frames for direction ${d.toUpperCase()}`);
          return;
        }
        const err = validateFrameLights(draft.sprites[d]!.frames);
        if (err) {
          setError(`${d.toUpperCase()}: ${err}`);
          return;
        }
      }
    } else {
      const defined = Object.values(draft.slices ?? {}).filter(Boolean);
      if (!defined.length) {
        setError("Define at least one autotile slice");
        return;
      }
      for (const [k, s] of Object.entries(draft.slices ?? {})) {
        if (!s?.frames.length) continue;
        const err = validateFrameLights(s.frames);
        if (err) {
          setError(`Slice ${k}: ${err}`);
          return;
        }
      }
    }

    // After the per-type frame checks above, so "you have no frames at all" is
    // reported before "your states disagree about their size".
    const savedStates = statesForSave(draft);
    for (const [key, sprites] of Object.entries(savedStates ?? {})) {
      if (!sprites) continue;
      const mismatch = footprintMismatch(
        draft,
        key as OverrideSpriteState,
        sprites,
      );
      if (mismatch) {
        setError(mismatch);
        return;
      }
      for (const s of stateSpriteList(draft, sprites)) {
        const err = validateFrameLights(s.frames);
        if (err) {
          setError(`${key}: ${err}`);
          return;
        }
      }
    }

    setError(null);
    const climbByVariant: Partial<
      Record<VariantKey, Record<Direction, boolean>>
    > = {};
    const keys: VariantKey[] = isDirectional(draft) ? [...DIRECTIONS] : ["default"];
    for (const key of keys) {
      climbByVariant[key] = resolveClimbFrom(draft, key);
    }

    const saved: TileDef = {
      id: draft.id,
      name: draft.name,
      height: draft.height,
      type: draft.type,
      kind: draft.kind,
      attributes: {},
      lightPassing: draft.lightPassing ? true : undefined,
      intangible: draft.intangible ? true : undefined,
      affectedByGravity: draft.affectedByGravity ? true : undefined,
      walkable: draft.walkable === false ? false : undefined,
      // Only the explicit flag is persisted: a tile whose brain implies
      // actorhood needs no redundant `actor: true` alongside it.
      actor: draft.actor ? true : undefined,
      walkDurationMs: isActor ? draft.walkDurationMs : undefined,
      climbFrom: climbFromForSave(draft, climbByVariant),
      interactions: interactionsForSave(draft.interactions),
      states: savedStates,
    };

    if (draft.type === "simple" && draft.sprite) {
      saved.sprite = sanitizeSprite(draft.sprite);
    } else if (draft.type === "directional" && draft.sprites) {
      const sprites: Partial<Record<Direction, TileSprite>> = {};
      for (const d of DIRECTIONS) {
        if (draft.sprites[d]) sprites[d] = sanitizeSprite(draft.sprites[d]!);
      }
      saved.sprites = sprites;
    } else if (draft.type === "autotile" && draft.slices) {
      const slices: Partial<Record<AutotileSlice, TileSprite>> = {};
      for (const [k, s] of Object.entries(draft.slices)) {
        if (s) slices[Number(k)] = sanitizeSprite(s);
      }
      saved.slices = slices;
    }

    onSave(saved);
  };

  const dirTabs = DIRECTIONS.map((d) => ({ value: d, label: d.toUpperCase() }));

  const frameTabs = [
    ...frames.map((_, i) => ({ value: String(i), label: `Frame ${i + 1}` })),
    { value: "add", label: "+" },
  ];

  const lightOpen = Boolean(frame?.light);

  const climbPad = (
    <div className="flex items-center gap-3 pt-1">
      <span className="text-xs font-bold uppercase text-muted">Climb up from</span>
      <div
        className="grid w-fit grid-cols-3 gap-1"
        role="group"
        aria-label="Climb-from directions"
      >
        <span />
        <ClimbFromToggle
          label="N"
          checked={climbFlags.n}
          onChange={(n) => setClimbSide("n", n)}
        />
        <span />
        <ClimbFromToggle
          label="W"
          checked={climbFlags.w}
          onChange={(w) => setClimbSide("w", w)}
        />
        <span className="flex h-8 w-8 items-center justify-center text-[10px] text-muted">
          ·
        </span>
        <ClimbFromToggle
          label="E"
          checked={climbFlags.e}
          onChange={(e) => setClimbSide("e", e)}
        />
        <span />
        <ClimbFromToggle
          label="S"
          checked={climbFlags.s}
          onChange={(s) => setClimbSide("s", s)}
        />
        <span />
      </div>
    </div>
  );

  /**
   * Which state the sprite editor below is editing.
   *
   * Flat rather than another tab level, which is the whole reason it fits in this
   * dialog as it stands: the direction tabs and the 47-slice grid are unchanged
   * and simply edit whichever state is selected. Hidden entirely for the many
   * tiles that can only ever be idle, so a wall gains no control it cannot use.
   */
  const statePicker =
    states.length > 1 ? (
      <div className="flex flex-col gap-1 pt-1">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold uppercase text-muted">State</span>
          <Segmented<SpriteState>
            value={state}
            onChange={changeState}
            options={states.map((s) => ({
              value: s,
              label:
                s === "idle"
                  ? "Idle"
                  : `${s[0]!.toUpperCase()}${s.slice(1)}${draft.states?.[s as OverrideSpriteState] ? " •" : ""}`,
            }))}
            size="sm"
          />
        </div>
        <p className="text-[11px] leading-snug text-muted">
          {STATE_HINTS[state]}
        </p>
      </div>
    ) : null;

  const frameEditor = (
    <Tabs
      value={String(frameIndex)}
      onValueChange={(v) => {
        if (v === "add") {
          const clone = structuredClone(
            frames[frames.length - 1] ?? emptyFrame(tilesets[0]?.id ?? ""),
          );
          setFrames([...frames, clone]);
          setFrameIndex(frames.length);
          return;
        }
        setFrameIndex(Number(v));
      }}
      items={frameTabs}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          <span className="font-bold uppercase text-muted">Duration ms</span>
          <Input
            type="number"
            className="w-24"
            value={frame?.durationMs ?? 200}
            onChange={(e) =>
              updateFrame({ durationMs: Number(e.target.value) || 200 })
            }
          />
        </label>
        {frames.length > 1 ? (
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              const next = frames.filter((_, i) => i !== frameIndex);
              setFrames(next);
              setFrameIndex(Math.max(0, frameIndex - 1));
            }}
          >
            Remove frame
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={() => {
            if (!frame) return;
            setFrames([
              ...frames.slice(0, frameIndex + 1),
              structuredClone(frame),
              ...frames.slice(frameIndex + 1),
            ]);
            setFrameIndex(frameIndex + 1);
          }}
        >
          Duplicate frame
        </Button>
      </div>

      <div className="mt-2 flex flex-col gap-2 border-2 border-border p-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={lightOpen}
            onChange={(e) => {
              const on = e.target.checked;
              updateFrame({
                light: on ? (frame?.light ?? { ...DEFAULT_LIGHT }) : undefined,
              });
            }}
            className="hard-checkbox"
          />
          Emits light
        </label>
        {lightOpen && frame?.light ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Radius</span>
              <Input
                type="number"
                min={1}
                step={1}
                className="w-20"
                value={frame.light.radius}
                onChange={(e) =>
                  updateFrame({
                    light: {
                      ...frame.light!,
                      radius: Number(e.target.value) || 1,
                    },
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Intensity</span>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                className="w-20"
                value={frame.light.intensity}
                onChange={(e) =>
                  updateFrame({
                    light: {
                      ...frame.light!,
                      intensity: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-bold uppercase text-muted">Colour</span>
              <input
                type="color"
                value={frame.light.color}
                onChange={(e) =>
                  updateFrame({
                    light: { ...frame.light!, color: e.target.value },
                  })
                }
                className="h-8 w-12 cursor-pointer border-2 border-border bg-panel p-0"
              />
            </label>
          </div>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_180px]">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase text-muted">Tileset</span>
            <Select
              value={tileset?.id ?? null}
              onValueChange={(id) => {
                if (!id || !frame) return;
                setFrameSprite({
                  tilesetId: id,
                  rect: { ...frame.sprite.rect },
                  base: frame.sprite.base,
                });
              }}
              options={tilesets.map((t) => ({
                value: t.id,
                label: t.name,
              }))}
            />
          </div>
          <SpriteSelector
            tileset={tileset}
            value={frame?.sprite ?? null}
            onChange={setFrameSprite}
          />
        </div>
        <div className="flex flex-col items-center gap-2">
          <span className="text-xs font-bold uppercase text-muted">Preview</span>
          <TilePreview
            tile={draft}
            tilesets={tilesets}
            size={96}
            state={state}
            direction={draft.type === "directional" ? dir : undefined}
            autotileSlice={draft.type === "autotile" ? slice : undefined}
          />
        </div>
      </div>
    </Tabs>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? "New Tile" : `Edit ${tile?.name ?? ""}`}
      wide
      footer={
        <>
          {!isNew && onDelete ? (
            <Button variant="danger" onClick={onDelete} className="mr-auto">
              Delete
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <div className="border-2 border-danger bg-danger/10 px-2 py-1 text-sm text-danger">
            {error}
          </div>
        ) : null}

        <Tabs
          value={tab}
          onValueChange={setTab}
          items={[
            { value: TAB_TILE, label: "Tile" },
            {
              value: TAB_INTERACTIVE,
              // The brain has its own tab now, so it no longer lights this dot.
              label: hasNonBrainInteraction ? "Interactive •" : "Interactive",
            },
            {
              value: TAB_BRAIN,
              label: impliedByBrain ? "Brain •" : "Brain",
            },
            // Battle and Item are shown by the kind rather than by their block,
            // so neither carries the "•" the others use to say it is configured:
            // the tab being there at all is already that statement. Only the
            // kind can add or remove them, which is why the select lives on the
            // tab that is always present.
            ...(draft.kind === "battler"
              ? [{ value: TAB_BATTLE, label: "Battle" }]
              : []),
            ...(draft.kind === "item"
              ? [{ value: TAB_ITEM, label: "Item" }]
              : []),
            {
              value: TAB_RESPAWN,
              label: draft.interactions?.respawn ? "Respawn •" : "Respawn",
            },
          ]}
        >
          <TabPanel value={TAB_INTERACTIVE}>
            <InteractiveTab
              draft={draft}
              onChange={setDraft}
              tiles={tiles}
              tilesets={tilesets}
            />
          </TabPanel>

          <TabPanel value={TAB_BRAIN} className="flex flex-col gap-3">
            <p className="text-[11px] leading-snug text-muted">
              What drives this body when nobody is connected to it — an authored
              state machine. Authoring one makes the tile an{" "}
              <strong>Actor</strong>; a malformed brain leaves the creature
              standing still.
            </p>
            <BrainEditor
              brain={draft.interactions?.brain}
              tiles={tiles}
              onChange={setBrain}
            />
          </TabPanel>

          <TabPanel value={TAB_BATTLE}>
            <BattleTab draft={draft} onChange={setDraft} />
          </TabPanel>

          <TabPanel value={TAB_ITEM}>
            <ItemTab draft={draft} onChange={setDraft} />
          </TabPanel>

          <TabPanel value={TAB_RESPAWN}>
            <RespawnTab draft={draft} onChange={setDraft} />
          </TabPanel>

          <TabPanel value={TAB_TILE} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Id</span>
            <Input
              value={draft.id}
              disabled={!isNew}
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              placeholder="grass"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Name</span>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Height</span>
            <Segmented<TileHeight>
              value={draft.height}
              onChange={(height) => setDraft({ ...draft, height })}
              options={[
                { value: 0, label: "0 flat" },
                { value: 1, label: "1 half" },
                { value: 2, label: "2 full" },
              ]}
              size="sm"
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span className="font-bold uppercase text-muted">Type</span>
            <Segmented<TileType>
              value={draft.type}
              onChange={changeType}
              options={[
                { value: "simple", label: "Simple" },
                { value: "directional", label: "Directional" },
                { value: "autotile", label: "Autotile" },
              ]}
              size="sm"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.lightPassing ?? false}
              onChange={(e) =>
                setDraft({ ...draft, lightPassing: e.target.checked })
              }
              className="hard-checkbox"
            />
            Passes light
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.intangible ?? false}
              onChange={(e) =>
                setDraft({ ...draft, intangible: e.target.checked })
              }
              className="hard-checkbox"
            />
            Intangible
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.affectedByGravity ?? false}
              onChange={(e) =>
                setDraft({ ...draft, affectedByGravity: e.target.checked })
              }
              className="hard-checkbox"
            />
            Affected by gravity
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.walkable !== false}
              onChange={(e) =>
                setDraft({ ...draft, walkable: e.target.checked })
              }
              className="hard-checkbox"
            />
            Walkable
          </label>
          <label
            className="flex items-center gap-2 text-sm"
            title={
              impliedByBrain
                ? "A brain makes this an actor — set on the Interactive tab."
                : "Every placement of this tile comes alive as its own actor when the world loads."
            }
          >
            <input
              type="checkbox"
              // A brain already makes it an actor, so the box reads on and locks
              // rather than pretending the flag is what decides.
              checked={isActor}
              disabled={impliedByBrain}
              onChange={(e) => setDraft({ ...draft, actor: e.target.checked })}
              className="hard-checkbox"
            />
            Actor{impliedByBrain ? " — from brain" : ""}
          </label>
        </div>

        {isActor ? (
          <label className="flex items-center gap-2 text-sm">
            Step duration
            <input
              type="number"
              min={1}
              step={10}
              // Blank means "the player's pace", which is a different thing from
              // zero and has to survive a round trip through the field.
              value={draft.walkDurationMs ?? ""}
              placeholder={String(WALK_DURATION_MS)}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  walkDurationMs:
                    e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className="w-24"
            />
            <span className="text-xs text-ink/60">
              ms per cell — larger is slower
            </span>
          </label>
        ) : null}

        {draft.type === "simple" ? climbPad : null}

        {statePicker}

        {draft.type === "simple" ? (
          frameEditor
        ) : draft.type === "directional" ? (
          <Tabs
            value={dir}
            onValueChange={(v) => {
              setDir(v as Direction);
              setFrameIndex(0);
            }}
            items={dirTabs}
          >
            {climbPad}
            {frameEditor}
          </Tabs>
        ) : (
          <div className="flex flex-col gap-3">
            {climbPad}
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-bold uppercase text-muted">
                  Autotile slices (47)
                </span>
                <p className="text-[11px] leading-snug text-muted">
                  Each icon is a neighborhood: dark green = this tile, light
                  green = matching neighbors. Rendering picks the slice from
                  nearby same-id tiles. Sparse — only define the shapes you
                  need (missing falls back to isolated).
                </p>
              </div>
              <div
                className="grid w-fit gap-1"
                style={{ gridTemplateColumns: "repeat(8, minmax(0, 1fr))" }}
                role="listbox"
                aria-label="Autotile slices"
              >
                {Array.from({ length: AUTOTILE_SLICE_COUNT }, (_, i) => {
                  const defined = Boolean(draft.slices?.[i]);
                  const selected = slice === i;
                  return (
                    <button
                      key={i}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-label={autotileSliceTitle(i)}
                      title={`${autotileSliceTitle(i)}${defined ? "" : " — empty"}`}
                      onClick={() => {
                        setSlice(i);
                        setFrameIndex(0);
                        if (!draft.slices?.[i]) {
                          const base =
                            draft.slices?.[0] ??
                            emptySprite(tilesets[0]?.id ?? "");
                          setDraft({
                            ...draft,
                            slices: {
                              ...draft.slices,
                              [i]: structuredClone(base),
                            },
                          });
                        }
                      }}
                      className={[
                        "relative rounded-sm border-2 p-0.5",
                        selected
                          ? "border-accent bg-paper"
                          : defined
                            ? "border-border bg-panel hover:border-ink"
                            : "border-dashed border-muted opacity-55 hover:opacity-100",
                      ].join(" ")}
                    >
                      <AutotileSlicePreview slice={i} size={32} />
                      <span
                        className={[
                          "pointer-events-none absolute right-0 bottom-0 px-0.5 font-mono text-[9px] leading-none",
                          selected
                            ? "bg-accent text-paper"
                            : "bg-paper/90 text-ink",
                        ].join(" ")}
                      >
                        {i}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <AutotileSlicePreview slice={slice} size={20} />
                <span>{autotileSliceTitle(slice)}</span>
                {definedSlice ? (
                  <span className="text-ink">· sprite defined</span>
                ) : (
                  <span>· using fallback</span>
                )}
              </div>
              {draft.slices?.[slice] && slice !== 0 ? (
                <Button
                  size="sm"
                  variant="danger"
                  className="w-fit"
                  onClick={() => {
                    const next = { ...draft.slices };
                    delete next[slice];
                    setDraft({ ...draft, slices: next });
                    setSlice(0);
                    setFrameIndex(0);
                  }}
                >
                  Clear this slice
                </Button>
              ) : null}
            </div>
            {frameEditor}
          </div>
        )}
          </TabPanel>
        </Tabs>
      </div>
    </Dialog>
  );
}

function ClimbFromToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={checked ? "primary" : "secondary"}
      aria-pressed={checked}
      aria-label={`Climb from ${label}`}
      onClick={() => onChange(!checked)}
      className="h-8 w-8 px-0"
    >
      {label}
    </Button>
  );
}

export function tileIsAnimated(tile: TileDef) {
  return isAnimated(tile);
}
