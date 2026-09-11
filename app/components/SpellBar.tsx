import { useLayoutEffect, useRef } from "react";
import {
  CAST_REFUSAL_NOTES,
  type Castability,
  type CastSquare,
  COOLDOWN_STEP_MS,
  type SpellButton,
} from "../game/casting";
import { castKeyLabel } from "../game/heldDirections";
import type { TileDef, TilesetDef } from "../lib/types";
import { Tooltip } from "../ui/Tooltip";
import { useTap } from "./useTap";
import { TilePreview } from "./TilePreview";

/**
 * The stones a body is carrying, as a row of things to press.
 *
 * ## It is a row of stones, not a spell bar
 *
 * There are no slots to fill and nothing to drag onto it. A button exists
 * because a stone is in a hand or on a charm, and it stops existing when the
 * stone does — so a player who has never picked one up has no row at all, and a
 * profession they do not play costs them none of their screen. That is the whole
 * reason casting could be added to a phone layout already carrying a mode strip,
 * an interaction list, a chat bar and a direction pad: the control is *absent*
 * for almost everybody.
 *
 * Two hands and a charm is three, which is the whole of a caster's loadout and
 * the reason the keyboard binding stops at `3`. Passives get no button, because
 * there is nothing to press — see `../game/casting`'s `castableStones`.
 *
 * ## Three appearances, and the middle one is the point
 *
 * A button once had two: lit, or dimmed for every reason at once. Dimming is
 * right for a stone you cannot use, and it was wrong for the commonest reason a
 * stone will not fire — nobody is targeted — because that is not a fact about
 * the stone at all. A player looking at a greyed row concluded the spell was
 * broken, or on cooldown, and went to stand somewhere else. So:
 *
 * - **Ready.** Solid ring, full brightness. Pressing it casts.
 * - **Cooling.** Dimmed, with an arc around the rim counting down. It is the
 *   one refusal that ends by itself, and the only one worth drawing a picture
 *   of: the picture *is* how long is left.
 * - **Unavailable.** Dashed and faint — not learnt yet, out of range, nothing in
 *   the square. These stay collapsed into one appearance, because a player can
 *   do nothing about any of them from where they are standing, and the tooltip
 *   and the accessible name say which.
 *
 * **A stone with nobody targeted looks ready and presses**, and the refusal is
 * said in words at the foot of the view — see `../game/notices`'
 * `castRefusalNotice`. That is the trade this makes: one sentence when you press
 * it, rather than a control that looks broken for as long as you are not in a
 * fight.
 *
 * ## The ring is the cooldown and nothing else
 *
 * The session winds a cooldown in whole steps of {@link COOLDOWN_STEP_MS}, and
 * the wire carries it at that grain, so the page is told a new figure once a
 * second. Drawn at that grain, the arc jumped once a second too. Instead, every
 * figure starts an animation towards the *next* one — one step lower, one step
 * from now — from wherever the arc is at that moment. The browser plays it on
 * the SVG with the Web Animations API, so React still renders once a second and
 * never once a frame.
 *
 * Starting from where the arc *is*, rather than from the figure just received,
 * is what keeps it continuous. The session's clock is shared by every stone in
 * the world, so the first step after a cast lands anywhere up to a second in,
 * and a figure can arrive a little early or late off the wire. Either way the
 * arc bends towards the new target rather than jumping back to meet it.
 */

/** Where in the disc the sprite sits, leaving the rim to the ring. */
const SPRITE_SHARE = 0.55;

/** Which sprite stands for a stone in a button — the one facing the reader. */
const FRONT: "s" = "s";

/**
 * The size the sprite is drawn against, in pixels.
 *
 * A constant rather than a measurement, because the button itself is fluid — it
 * takes a third of whatever width the row was given. `drawSprite` snaps to an
 * integer scale internally and centres the remainder, so a sprite drawn at a
 * nominal size and scaled by the box stays chunky rather than interpolated; this
 * is the same trick `./ItemSlot` plays with its share.
 */
const SPRITE_SIZE_PX = 44;

/**
 * What the whole row is worth in width, as a share of a phone's control column.
 *
 * The row sits directly above the direction pad and shares its column, so a
 * button is a third of the pad's width and the three of them come out exactly as
 * wide as the thing they sit on. That is what makes them read as one cluster
 * with the pad rather than as a strip that happens to be near it — and it is
 * what keeps them under the thumb that is *not* steering, since the pad is on
 * the walking side and a spell is pressed with the other hand.
 */
const BUTTONS_PER_ROW = 3;

/**
 * The box the countdown ring is drawn in, in its own units.
 *
 * The ring is an SVG laid over the disc at whatever size the row came out at, so
 * everything below is a share of this rather than a pixel: the button is fluid
 * and the arc has to be the same weight on a phone and in a desktop column.
 */
const RING_BOX = 100;

/** Where the middle of the stroke runs, measured from the centre. */
const RING_RADIUS = 44;

/** How heavy the stroke is, in the same units. Spans 40 to 48 of the box. */
const RING_WIDTH = 8;

/** How far round the ring is, which is what a dash pattern is stated in. */
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The dash offset that leaves `share` of the ring showing. */
function arcOffset(share: number): number {
  return RING_LENGTH * (1 - share);
}

/**
 * Which of the three appearances a stone wears. @see SpellBar
 *
 * Exported because it is the whole of the decision and it is worth asserting
 * without a browser: the one that surprises people is `noTarget`, which reads as
 * ready.
 */
export type SpellAppearance = "ready" | "cooling" | "unavailable";

/** @see SpellAppearance */
export function spellAppearance(castability: Castability): SpellAppearance {
  if (castability.ok) return "ready";
  if (castability.reason === "cooling") return "cooling";
  // Not a fact about the stone but about who you are pointing at, so the button
  // says nothing about it and the press does. @see `../game/notices`
  if (castability.reason === "noTarget") return "ready";
  return "unavailable";
}

/**
 * Whether pressing this button sends a cast at all.
 *
 * Wider than "would it fire", and deliberately: a stone refused for want of a
 * target is sent, refused by the session, and answered with a sentence. Every
 * other refusal is stopped here, because there is nothing to say that the
 * dimming has not already said.
 */
export function spellPressable(castability: Castability): boolean {
  return castability.ok || castability.reason === "noTarget";
}

/**
 * How much of the ring a cooldown fills, from nothing to a whole circle.
 *
 * Clamped at both ends because the ring asks it about a figure one step below
 * the last one it was given, which on the final step of a stone whose cooldown
 * is not a whole number of seconds is below zero.
 */
export function cooldownShare(remainingMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.min(1, Math.max(0, remainingMs / totalMs));
}

export function SpellBar({
  spells,
  onCast,
  tilesById,
  tilesets,
  className = "",
}: {
  /**
   * Every stone that can be pressed, in square order, with why each can or
   * cannot be right now — see `../game/casting`'s `castableStones`, which is the
   * same function the server honours a cast with.
   */
  spells: SpellButton[];
  onCast: (square: CastSquare) => void;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  className?: string;
}) {
  // Absent rather than empty. A row of nothing is still a row: it takes its
  // height out of the pad below it and leaves a player wondering what belongs
  // there, which is exactly the cost this feature promised not to charge
  // somebody who never picks a stone up.
  if (spells.length === 0) return null;

  return (
    <div
      // A list rather than a group, because what it is *is* an ordered set of
      // things, and the order is load-bearing: the second button and the `2` key
      // are the same stone by construction.
      role="list"
      aria-label="Spells"
      // How the row sits in its column is the caller's, because the two places it
      // appears want different answers: above the pad it is centred on the thing
      // it belongs to, and in a desktop column it lines up with the buttons
      // above it. See the two call sites in `./GameViewport`.
      className={["flex w-full items-stretch gap-1", className]
        .filter(Boolean)
        .join(" ")}
    >
      {spells.map((spell, index) => (
        <SpellSquare
          // By the stone rather than by position: a player who swaps their two
          // stones between hands has the same two buttons holding different
          // things, and a list keyed by square would animate one into the other.
          key={spell.itemId}
          spell={spell}
          index={index}
          onCast={onCast}
          tile={tilesById[spell.tileId]}
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
  tile,
  tilesets,
}: {
  spell: SpellButton;
  index: number;
  onCast: (square: CastSquare) => void;
  tile: TileDef | undefined;
  tilesets: TilesetDef[];
}) {
  const verdict = spell.castability;
  const appearance = spellAppearance(verdict);
  const pressable = spellPressable(verdict);
  const key = castKeyLabel(index);

  // Pointer-driven rather than click-driven, so a spell still answers a thumb
  // that is already holding the direction pad down with its other hand. The
  // same reason the mode switch is. See `./useTap`.
  const tap = useTap(() => {
    // Refused here as well as by the session, and the session as well as the
    // server: a dimmed button that quietly sent anyway would be spending a
    // player's cooldown on a cast that was never going to land. A stone with
    // nobody targeted is the exception and goes through — see
    // {@link spellPressable}.
    if (pressable) onCast(spell.square);
  });

  // What it is, then whether it can be used and why not — in that order, because
  // the name is what identifies the button and the rest is its state. A refusal
  // is spelled out rather than collapsed into "unavailable": the picture no
  // longer says which, and for a stone with nothing targeted it does not even
  // say that there is a which.
  const state = verdict.ok
    ? key
      ? `ready, key ${key}`
      : "ready"
    : CAST_REFUSAL_NOTES[verdict.reason];

  return (
    <Tooltip content={`${spell.name}${key ? ` (${key})` : ""} — ${state}`}>
      <button
        type="button"
        role="listitem"
        aria-label={`${spell.name}: ${state}`}
        // Not removed from the tab order and not `disabled`: a stone that cannot
        // be cast is still a thing a player wants to read, and a button that
        // vanished from the keyboard's reach whenever it was cooling would be
        // unreachable exactly when somebody wants to know how long is left.
        // Pressing it does nothing, which is what the dimming promises.
        aria-disabled={!pressable}
        {...tap}
        className={[
          // Round, which is an exception to the house rectangle and says so at
          // the same weight the direction pad's does — see `spell-disc` in
          // `../app.css`. A stone is a disc in the hand, and the countdown it
          // wears is an arc around its rim, which a corner has nowhere to go.
          "spell-disc relative flex aspect-square min-w-0 flex-1 flex-col items-center justify-center border-2",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          APPEARANCE_CLASSES[appearance],
        ].join(" ")}
        style={{ maxWidth: `calc(100% / ${BUTTONS_PER_ROW})` }}
      >
        {tile ? (
          // The stone's own sprite, so what is in your hand and what is on the
          // button are recognisably one thing. A tile the catalogue has lost
          // draws nothing, on the terms every other id in a kit is honoured.
          <TilePreview
            tile={tile}
            tilesets={tilesets}
            size={Math.round(SPRITE_SIZE_PX * SPRITE_SHARE)}
            direction={FRONT}
            still
            chrome={false}
            background={null}
          />
        ) : null}

        {/* The number that presses it, at the foot of the disc rather than in a
            corner the circle has cut off. Drawn on both devices rather than
            hidden behind a media query: a phone with a keyboard attached is a
            real thing, and the glyph costs a few pixels of a button nobody is
            reading closely. Announced by the label above instead of here, so it
            is not read out twice. */}
        {key ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[6%] left-1/2 -translate-x-1/2 text-[10px] leading-none text-paper/50"
          >
            {key}
          </span>
        ) : null}

        {spell.cooldownMs > 0 ? (
          <CooldownRing
            remainingMs={spell.cooldownMs}
            totalMs={spell.cooldownTotalMs}
          />
        ) : null}
      </button>
    </Tooltip>
  );
}

/**
 * How each of the three states is drawn. @see SpellAppearance
 *
 * A table rather than a chain of ternaries, so adding a fourth appearance is a
 * missing key rather than a branch somebody forgot.
 */
const APPEARANCE_CLASSES: Record<SpellAppearance, string> = {
  ready: "border-paper/60 bg-paper/10 text-paper hover:border-paper",
  // Solid, unlike the state below it, because the ring around the rim is the
  // thing to read and a dashed border competes with it for the same pixels.
  cooling: "border-paper/30 bg-transparent text-paper/40 opacity-60",
  // Dashed as well as faint, so the state survives being looked at on a bright
  // phone outdoors.
  unavailable: "border-dashed border-paper/25 bg-transparent text-paper/40 opacity-50",
};

/**
 * How long is left, as an arc around the rim.
 *
 * It empties clockwise from the top as the stone comes ready, so a full ring is
 * a spell just cast and no ring at all is one waiting to be. Absent entirely
 * when there is nothing to count down, track and all, rather than drawn empty: a
 * permanent hairline around every ready spell would read as part of the button.
 *
 * A dash pattern on one circle rather than a wedge path, because the length that
 * is showing is then a single number that changes — no arc endpoints to
 * trigonometry out, and no large-arc flag to get wrong at half a cooldown. The
 * whole thing is turned a quarter so that zero degrees is noon rather than three
 * o'clock, which is where a countdown is read from.
 *
 * The dash offset attribute is the figure the session gave; the animation
 * layered over it is what is on screen. @see SpellBar for why it aims one step
 * ahead.
 */
function CooldownRing({
  remainingMs,
  totalMs,
}: {
  remainingMs: number;
  totalMs: number;
}) {
  const arcRef = useRef<SVGCircleElement>(null);
  const animationRef = useRef<Animation | null>(null);

  // Layout rather than passive, so the new animation is in place before the
  // browser paints a frame of the arc sitting at the attribute's figure.
  useLayoutEffect(() => {
    const arc = arcRef.current;
    if (!arc) return;
    // Read before cancelling, so it is the position the running animation has
    // reached rather than the figure the attribute was just set to.
    const fromOffset = getComputedStyle(arc).strokeDashoffset;
    animationRef.current?.cancel();
    const toOffset = arcOffset(
      cooldownShare(remainingMs - COOLDOWN_STEP_MS, totalMs),
    );
    animationRef.current = arc.animate(
      [{ strokeDashoffset: fromOffset }, { strokeDashoffset: `${toOffset}` }],
      // Held at the target when it finishes, so a figure that arrives late
      // leaves the arc waiting where it should be rather than snapping back.
      { duration: COOLDOWN_STEP_MS, easing: "linear", fill: "forwards" },
    );
  }, [remainingMs, totalMs]);

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${RING_BOX} ${RING_BOX}`}
      className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
    >
      {/* The part already served, so the arc is read against a whole circle
          rather than against the dark behind the button. */}
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
