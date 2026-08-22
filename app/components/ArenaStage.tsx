import { DAMAGE_NUMBER_LIFETIME_MS, STRIKE_DURATION_MS } from "../game/constants";
import type { Side } from "../game/duel";
import type { TileDef, TilesetDef } from "../lib/types";
import { TilePreview } from "./TilePreview";

/**
 * Two bodies and what is happening to them, and nothing else.
 *
 * **Deliberately not the world renderer.** A fight in the Arena has no floor, no
 * light and no camera, because none of those are things a balance question is
 * asked about — and reaching for `WorldRenderer` would mean a map, a level bake
 * and a WebGL context in service of drawing two sprites facing each other. What
 * a tuner needs to see is which body swung, which one got out of the way, and
 * what came off whom, so that is exactly what is drawn.
 *
 * The three motions here are the session's own, on the session's own clock:
 * a swing throws the attacker forward, a dodge throws the defender back, and a
 * number floats off whoever it happened to. They are read straight off the
 * shared constants rather than picked to look right, so a fight watched here
 * lasts as long as the same fight in the world.
 */

/** One number on its way up off somebody's head. */
export type Floater = {
  id: number;
  side: Side;
  text: string;
  /** Which of the four things a swing can come to, for the colour. */
  tone: "damage" | "miss" | "ailment" | "heal";
  /** On the simulation's clock, so slow motion slows the numbers too. */
  bornAtMs: number;
};

/** What one side looks like at this instant. */
export type StageSide = {
  tile: TileDef | null;
  name: string;
  hp: number;
  maxHp: number;
  /** Names of what is running on this body, for the strip under the bar. */
  ailments: string[];
  /**
   * When this body last threw itself somewhere, and which way.
   *
   * A moment rather than a progress, on the terms `ActorRuntime.strike` is split
   * from `strikeProgress`: the lean is a fact about when, and how far through it
   * is falls out of the clock.
   */
  leanAtMs: number | null;
  leanKind: "swing" | "dodge";
};

/** How far a body throws itself, in pixels of this stage rather than of a map. */
const LEAN_PX = 18;

/** How far a number climbs over its life. */
const FLOAT_RISE_PX = 34;

/**
 * Big enough to read the sprite's shape at, on a page that is mostly numbers,
 * and small enough that two of them plus their bars fit a phone side by side.
 *
 * Fixed rather than measured: the alternative is a media query, and the server
 * answers every one of those with false — so a phone would draw the desktop size
 * and jump on hydration, for a sprite that is legible at either.
 */
const SPRITE_PX = 96;

const TONE_CLASS: Record<Floater["tone"], string> = {
  damage: "text-danger",
  miss: "text-muted",
  ailment: "text-reward",
  heal: "text-accent",
};

export function ArenaStage({
  a,
  b,
  tilesets,
  floaters,
  elapsedMs,
  winner,
}: {
  a: StageSide;
  b: StageSide;
  tilesets: TilesetDef[];
  floaters: readonly Floater[];
  /** The simulation's clock, which every motion here is measured against. */
  elapsedMs: number;
  winner: Side | null;
}) {
  return (
    <div className="flex items-stretch justify-center gap-4 border-2 border-border bg-panel px-4 py-6">
      <Fighter
        side="a"
        state={a}
        tilesets={tilesets}
        floaters={floaters}
        elapsedMs={elapsedMs}
        won={winner === "a"}
      />
      <div className="flex min-w-12 flex-col items-center justify-center gap-1">
        <span className="text-xs font-bold uppercase text-muted">vs</span>
        <span className="tabular-nums text-xs text-muted">
          {(elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>
      <Fighter
        side="b"
        state={b}
        tilesets={tilesets}
        floaters={floaters}
        elapsedMs={elapsedMs}
        won={winner === "b"}
      />
    </div>
  );
}

function Fighter({
  side,
  state,
  tilesets,
  floaters,
  elapsedMs,
  won,
}: {
  side: Side;
  state: StageSide;
  tilesets: TilesetDef[];
  floaters: readonly Floater[];
  elapsedMs: number;
  won: boolean;
}) {
  const dead = state.hp <= 0;
  const mine = floaters.filter((floater) => floater.side === side);

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      {/* Centred by the flex row rather than by `left: 50%` and a −50%
          translate: the lean is an inline transform, and the two arrangements
          cannot share one `transform` property without one of them silently
          winning. Flex owns the position, the inline transform owns the motion,
          and neither has an opinion about the other. */}
      <div className="relative flex h-32 w-full items-end justify-center overflow-hidden">
        <div
          style={{
            transform: `translateX(${leanOffsetPx(state, elapsedMs, side)}px)`,
            opacity: dead ? 0.25 : 1,
            filter: dead ? "grayscale(1)" : undefined,
          }}
        >
          <TilePreview
            tile={state.tile}
            tilesets={tilesets}
            size={SPRITE_PX}
            // Turned to face the other one, rather than cycling: which way a
            // body is looking is the one thing that says who this fight is
            // between, and a sprite spinning through four bearings while it
            // fights reads as a bug.
            direction={side === "a" ? "e" : "w"}
            background={null}
            chrome={false}
          />
        </div>
        {mine.map((floater) => (
          <FloatingNumber key={floater.id} floater={floater} elapsedMs={elapsedMs} />
        ))}
      </div>

      <div className="w-full max-w-64">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate font-bold uppercase">{state.name}</span>
          <span className="tabular-nums text-muted">
            {state.hp}/{state.maxHp}
          </span>
        </div>
        <div
          className="mt-1 h-3 w-full border-2 border-border bg-paper"
          role="progressbar"
          aria-label={`${state.name} health`}
          aria-valuenow={state.hp}
          aria-valuemin={0}
          aria-valuemax={state.maxHp}
        >
          <div
            className={dead ? "h-full bg-muted" : "h-full bg-danger"}
            style={{ width: `${healthWidth(state)}%` }}
          />
        </div>
        <div className="mt-1 flex min-h-4 flex-wrap gap-1">
          {state.ailments.map((name) => (
            <span
              key={name}
              className="border border-border bg-reward/20 px-1 text-[10px] uppercase"
            >
              {name}
            </span>
          ))}
          {won ? (
            <span className="border border-border bg-accent px-1 text-[10px] uppercase text-paper">
              winner
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FloatingNumber({
  floater,
  elapsedMs,
}: {
  floater: Floater;
  elapsedMs: number;
}) {
  const life = Math.max(
    0,
    Math.min(1, (elapsedMs - floater.bornAtMs) / DAMAGE_NUMBER_LIFETIME_MS),
  );
  return (
    <span
      className={`pointer-events-none absolute inset-x-0 top-2 text-center text-sm font-bold tabular-nums ${TONE_CLASS[floater.tone]}`}
      style={{
        transform: `translateY(${-FLOAT_RISE_PX * life}px)`,
        opacity: 1 - life,
      }}
    >
      {floater.text}
    </span>
  );
}

/** Health as a share of the bar, floored at nothing rather than at a sliver. */
function healthWidth(state: StageSide): number {
  if (state.maxHp <= 0) return 0;
  return Math.max(0, Math.min(100, (state.hp / state.maxHp) * 100));
}

/**
 * How far this body is from where it stands, right now.
 *
 * Out and back on a half sine over {@link STRIKE_DURATION_MS}, so a body is home
 * before it can swing again — the same bargain `../game/constants` strikes
 * between the lean and the floor on an attack interval. A swing goes towards the
 * other one and a dodge goes away, which is the whole of what the two motions
 * say.
 */
function leanOffsetPx(state: StageSide, elapsedMs: number, side: Side): number {
  if (state.leanAtMs === null) return 0;
  const progress = (elapsedMs - state.leanAtMs) / STRIKE_DURATION_MS;
  if (progress < 0 || progress > 1) return 0;
  const towards = side === "a" ? 1 : -1;
  const away = state.leanKind === "dodge" ? -1 : 1;
  return towards * away * LEAN_PX * Math.sin(Math.PI * progress);
}
