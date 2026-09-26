import { DAMAGE_NUMBER_LIFETIME_MS, STRIKE_DURATION_MS } from "../game/constants";
import type { Side } from "../game/duel";
import type { TileDef, TilesetDef } from "../lib/types";
import { TilePreview } from "./TilePreview";

export type Floater = {
  id: number;
  side: Side;
  text: string;
  tone: "damage" | "miss" | "ailment" | "heal";
  bornAtMs: number;
};

export type StageSide = {
  tile: TileDef | null;
  name: string;
  hp: number;
  maxHp: number;
  ailments: string[];
  leanAtMs: number | null;
  leanKind: "swing" | "dodge";
};

const LEAN_PX = 18;

const FLOAT_RISE_PX = 34;

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
        <span className="tabular-nums text-xs text-muted">{(elapsedMs / 1000).toFixed(1)}s</span>
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

function FloatingNumber({ floater, elapsedMs }: { floater: Floater; elapsedMs: number }) {
  const life = Math.max(0, Math.min(1, (elapsedMs - floater.bornAtMs) / DAMAGE_NUMBER_LIFETIME_MS));
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

function healthWidth(state: StageSide): number {
  if (state.maxHp <= 0) return 0;
  return Math.max(0, Math.min(100, (state.hp / state.maxHp) * 100));
}

function leanOffsetPx(state: StageSide, elapsedMs: number, side: Side): number {
  if (state.leanAtMs === null) return 0;
  const progress = (elapsedMs - state.leanAtMs) / STRIKE_DURATION_MS;
  if (progress < 0 || progress > 1) return 0;
  const towards = side === "a" ? 1 : -1;
  const away = state.leanKind === "dodge" ? -1 : 1;
  return towards * away * LEAN_PX * Math.sin(Math.PI * progress);
}
