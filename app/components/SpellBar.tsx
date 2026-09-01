import {
  CAST_REFUSAL_NOTES,
  type CastSquare,
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
 * ## One appearance for "no"
 *
 * A dimmed button means pressing it now will do nothing, and it means only that:
 * cooling, out of range, nothing targeted and not learnt yet all look identical,
 * because they are identical in the one respect a picture can carry. What
 * separates them is said in words instead — in the tooltip for a pointer, and in
 * the accessible name for anybody who is not looking at it — since a screen
 * reader hearing "unavailable" would be told less than a sighted player can see.
 *
 * ## The bar under the sprite is the cooldown and nothing else
 *
 * Drawn from the numbers the session was last given rather than from a timer of
 * this component's own: the countdown moves in whole seconds, which is the grain
 * the session keeps it at and the grain the wire carries it at. A smoother bar
 * would be this side inventing a precision the truth does not have.
 */

/** Where in the square the sprite sits, leaving room for the bar underneath. */
const SPRITE_SHARE = 0.6;

/** How tall the cooldown bar is, as a share of the button. */
const BAR_SHARE = 0.12;

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
  const ready = verdict.ok;
  const key = castKeyLabel(index);

  // Pointer-driven rather than click-driven, so a spell still answers a thumb
  // that is already holding the direction pad down with its other hand. The
  // same reason the mode switch is. See `./useTap`.
  const tap = useTap(() => {
    // Refused here as well as by the session, and the session as well as the
    // server: a dimmed button that quietly sent anyway would be spending a
    // player's cooldown on a cast that was never going to land.
    if (ready) onCast(spell.square);
  });

  const remaining = Math.max(0, spell.cooldownMs);
  const share =
    spell.cooldownTotalMs > 0
      ? Math.min(1, remaining / spell.cooldownTotalMs)
      : 0;

  // What it is, then whether it can be used and why not — in that order, because
  // the name is what identifies the button and the rest is its state. A refusal
  // is spelled out rather than collapsed into "unavailable": the picture already
  // says that much, and this is the half that says which.
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
        aria-disabled={!ready}
        {...tap}
        className={[
          "relative flex aspect-square min-w-0 flex-1 flex-col items-center justify-center border-2 shadow-hard",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          ready
            ? "border-paper/60 bg-paper/10 text-paper hover:border-paper"
            : // One appearance for every reason it cannot be used — see the
              // module note. Dashed as well as faint, so the state survives being
              // looked at on a bright phone outdoors.
              "border-dashed border-paper/25 bg-transparent text-paper/40 opacity-50",
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

        {/* The number that presses it, in the corner where a shortcut goes.
            Drawn on both devices rather than hidden behind a media query: a
            phone with a keyboard attached is a real thing, and the glyph costs
            one corner of a button nobody is reading closely. Announced by the
            label above instead of here, so it is not read out twice. */}
        {key ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-0.5 left-1 text-[10px] leading-none text-paper/50"
          >
            {key}
          </span>
        ) : null}

        {/* The cooldown, along the bottom edge. It empties from the right as the
            stone comes ready, so a full bar is a spell just cast and no bar at
            all is one waiting to be. Absent entirely when there is nothing to
            count down, rather than drawn empty: a permanent hairline under every
            ready spell would read as part of the button. */}
        {remaining > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-0 bg-accent"
            style={{ width: `${share * 100}%`, height: `${BAR_SHARE * 100}%` }}
          />
        ) : null}
      </button>
    </Tooltip>
  );
}
