import { useLayoutEffect, useRef } from "react";
import {
  CAST_REFUSAL_NOTES,
  type Castability,
  type CastSlot,
  COOLDOWN_STEP_MS,
  type SpellButton,
  spellPress,
} from "../game/casting";
import { castKeyLabel } from "../game/heldDirections";
import type { TileDef, TilesetDef } from "../lib/types";
import { Tooltip } from "../ui/Tooltip";
import { KeyHint } from "./KeyHint";
import { useTap } from "./useTap";
import { SpritePreview, TilePreview } from "./TilePreview";

const MS_PER_SECOND = 1000;

const SPRITE_SHARE = 0.55;

const FRONT = "s" as const;

const SPRITE_SIZE_PX = 44;

const BUTTONS_PER_ROW = 3;

const RING_BOX = 100;

const RING_RADIUS = 44;

const RING_WIDTH = 8;

const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function arcOffset(share: number): number {
  return RING_LENGTH * (1 - share);
}

export type SpellAppearance = "ready" | "cooling" | "unavailable" | "casting";

export function spellAppearance(castability: Castability): SpellAppearance {
  if (castability.ok) return "ready";
  if (castability.reason === "cooling") return "cooling";
  if (castability.reason === "noTarget") return "ready";
  if (castability.reason === "underway") return "casting";
  return "unavailable";
}

export function cooldownShare(remainingMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.min(1, Math.max(0, remainingMs / totalMs));
}

export function castTimeNote(castTimeMs: number): string {
  if (castTimeMs <= 0) return "";
  const seconds = Math.round(castTimeMs / (MS_PER_SECOND / 10)) / 10;
  return `${seconds}s to cast`;
}

export function SpellBar({
  spells,
  onCast,
  onStopCast,
  tilesById,
  tilesets,
  className = "",
}: {
  spells: SpellButton[];
  onCast: (slot: CastSlot) => void;
  onStopCast: () => void;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  className?: string;
}) {
  if (spells.length === 0) return null;

  return (
    <div
      role="list"
      aria-label="Spells"
      className={["flex w-full items-stretch gap-1", className].filter(Boolean).join(" ")}
    >
      {spells.map((spell, index) => (
        <SpellSquare
          key={spell.key}
          spell={spell}
          index={index}
          onCast={onCast}
          onStopCast={onStopCast}
          tile={spell.tileId ? tilesById[spell.tileId] : undefined}
          tilesets={tilesets}
        />
      ))}
    </div>
  );
}

function SpellSquare({
  spell,
  index,
  onCast,
  onStopCast,
  tile,
  tilesets,
}: {
  spell: SpellButton;
  index: number;
  onCast: (slot: CastSlot) => void;
  onStopCast: () => void;
  tile: TileDef | undefined;
  tilesets: TilesetDef[];
}) {
  const verdict = spell.castability;
  const appearance = spellAppearance(verdict);
  const press = spellPress(verdict);
  const key = castKeyLabel(index);

  const tap = useTap(() => {
    if (press === "stop") onStopCast();
    else if (press === "cast") onCast(spell.slot);
  });

  const refusal = verdict.ok
    ? key
      ? `ready, key ${key}`
      : "ready"
    : CAST_REFUSAL_NOTES[verdict.reason];
  const cast = castTimeNote(spell.castTimeMs);
  const state = cast ? `${refusal}, ${cast}` : refusal;

  return (
    <Tooltip content={`${spell.name}${key ? ` (${key})` : ""} — ${state}`}>
      <button
        type="button"
        role="listitem"
        aria-label={`${spell.name}: ${state}`}
        aria-disabled={press === null}
        {...tap}
        className={[
          "spell-disc relative flex aspect-square min-w-0 flex-1 flex-col items-center justify-center border-2",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          APPEARANCE_CLASSES[appearance],
        ].join(" ")}
        style={{ maxWidth: `calc(100% / ${BUTTONS_PER_ROW})` }}
      >
        {tile ? (
          <TilePreview
            tile={tile}
            tilesets={tilesets}
            size={Math.round(SPRITE_SIZE_PX * SPRITE_SHARE)}
            direction={FRONT}
            still
            chrome={false}
            background={null}
          />
        ) : spell.icon ? (
          <SpritePreview
            sprite={spell.icon}
            tilesets={tilesets}
            size={Math.round(SPRITE_SIZE_PX * SPRITE_SHARE)}
          />
        ) : null}

        {key ? (
          <KeyHint
            label={key}
            className="pointer-events-none absolute -bottom-2 left-1/2 -translate-x-1/2"
          />
        ) : null}

        {appearance === "casting" ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="pointer-events-none absolute left-1/2 top-1/2 h-[36%] w-[36%] -translate-x-1/2 -translate-y-1/2"
          >
            <path
              d="M5 5 L19 19 M19 5 L5 19"
              className="stroke-ink"
              strokeWidth={7}
              strokeLinecap="square"
            />
            <path
              d="M5 5 L19 19 M19 5 L5 19"
              className="stroke-paper"
              strokeWidth={3.5}
              strokeLinecap="square"
            />
          </svg>
        ) : null}

        {spell.cooldownMs > 0 ? (
          <CooldownRing remainingMs={spell.cooldownMs} totalMs={spell.cooldownTotalMs} />
        ) : null}
      </button>
    </Tooltip>
  );
}

const APPEARANCE_CLASSES: Record<SpellAppearance, string> = {
  ready: "border-paper/60 bg-paper/10 text-paper hover:border-paper",
  casting: "animate-pulse border-accent bg-accent/15 text-paper hover:border-paper",
  cooling: "border-paper/30 bg-transparent text-paper/40 opacity-60",
  unavailable: "border-dashed border-paper/25 bg-transparent text-paper/40 opacity-50",
};

function CooldownRing({ remainingMs, totalMs }: { remainingMs: number; totalMs: number }) {
  const arcRef = useRef<SVGCircleElement>(null);
  const animationRef = useRef<Animation | null>(null);

  /**
   * Layout rather than passive, so the new animation is in place before the
   * browser paints a frame of the arc sitting at the previous cooldown's
   * figure.
   */
  useLayoutEffect(() => {
    const arc = arcRef.current;
    if (!arc) return;
    const fromOffset = getComputedStyle(arc).strokeDashoffset;
    animationRef.current?.cancel();
    const toOffset = arcOffset(cooldownShare(remainingMs - COOLDOWN_STEP_MS, totalMs));
    animationRef.current = arc.animate(
      [{ strokeDashoffset: fromOffset }, { strokeDashoffset: `${toOffset}` }],
      { duration: COOLDOWN_STEP_MS, easing: "linear", fill: "forwards" },
    );
  }, [remainingMs, totalMs]);

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
      className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
    >
      <circle
        cx={RING_BOX / 2}
        cy={RING_BOX / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_WIDTH}
        className="stroke-paper/15"
      />
      <circle
        ref={arcRef}
        cx={RING_BOX / 2}
        cy={RING_BOX / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_WIDTH}
        className="stroke-accent"
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={arcOffset(cooldownShare(remainingMs, totalMs))}
      />
    </svg>
  );
}
