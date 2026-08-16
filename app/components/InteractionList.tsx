import {
  IconApple,
  IconBoxSeam,
  IconHandGrab,
  IconHandMove,
  IconSwitch,
  IconTarget,
} from "@tabler/icons-react";
import { useMemo } from "react";
import type {
  InteractionAction,
  InteractionOption,
} from "../game/interactionOptions";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  HEALTH_BAR_BRICKS,
  healthBarColor,
  healthBarFillBricks,
  healthFraction,
} from "../render/healthBar";
import { TilePreview } from "./TilePreview";

/**
 * Everything within reach, as a list you can act from.
 *
 * The world has always been able to answer "can I do something to that" — the
 * outline under the cursor is exactly that answer — but only one object at a
 * time and only once you have aimed at it. With a thumb there is no aiming
 * beforehand: you tap, and either something happens or you have just walked
 * somewhere. So the same answer is read out here instead, for every reachable
 * thing at once, which turns an affordance you had to go looking for into one
 * you can see. It earns its place on a desktop for the same reason a quest log
 * does — knowing what is *possible* is a different question from doing it.
 *
 * Each row is one action and the whole row is its button: the sprite says what,
 * the top line says what you would be doing, the bottom line says which one it
 * is. A body you can both shove and fight is two rows, because the verb is what
 * is being scanned for and there is nothing to be gained by making the reader
 * find it inside a group.
 *
 * A row about a body carries its health under the name, on the same ramp the
 * bar over its head is drawn on. Two rats read as two identical rows otherwise,
 * and the one thing you want to know before swinging is which of them is the
 * one you have nearly finished and which just walked into view.
 *
 * Rows carry the option and nothing else; {@link onAct} hands it back to
 * whoever owns the session. Nothing in here knows what a push is.
 */

/** Which sprite stands for a tile in a list — the one facing the reader. */
const FRONT: "s" = "s";

const ICONS: Record<InteractionAction, typeof IconTarget> = {
  target: IconTarget,
  open: IconBoxSeam,
  // A closing hand against push's sliding one: both are hands, and the
  // difference between taking a thing and shoving it is what the shape says.
  pickUp: IconHandGrab,
  push: IconHandMove,
  switch: IconSwitch,
  // An apple for every consumable, drink included: the icon says "this gets
  // used up", and the authored verb beside it says how.
  consume: IconApple,
};

const SPRITE_SIZE_PX = 32;

export function InteractionList({
  options,
  tiles,
  tilesets,
  attacking = false,
  onAct,
  onHover,
  className = "",
}: {
  options: InteractionOption[];
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /**
   * Whether a target is a fight, which is what colours the chosen row.
   *
   * The row wears whatever its subject is wearing out in the world — red in
   * attack mode, white otherwise — so the list and the canvas are never two
   * separate things to learn. It is the only thing in here that knows about
   * attack mode at all: what a row *does* is unchanged by it.
   */
  attacking?: boolean;
  onAct: (option: InteractionOption) => void;
  /**
   * The row being pointed at, so the world can outline what it is talking
   * about. By id rather than by option, because the thing moves and the
   * renderer has to resolve it against the list as it stands — see
   * `GameRenderer.setListHover`.
   *
   * Absent where there is no hover to have. Given by keyboard focus as well as
   * by the mouse: tabbing through the list and watching the world light up is
   * the same question being asked the same way.
   */
  onHover?: (optionId: string | null) => void;
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);

  return (
    <div
      className={[
        "flex flex-col gap-1 overflow-y-auto overscroll-contain",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      // Announced, because it changes without the player having touched it:
      // walking up to a crate is what puts the row there. Polite so it waits
      // for a gap rather than talking over a fight.
      role="log"
      aria-live="polite"
      aria-label="Within reach"
    >
      {options.length === 0 ? (
        // A word rather than an empty box. The list is always on screen — it
        // reserves its width so the game does not resize as you walk — and an
        // empty frame reads as something failing to load.
        <p className="px-1 py-2 text-xs text-paper/50">Nothing in reach.</p>
      ) : (
        options.map((option) => (
          <InteractionRow
            key={option.id}
            option={option}
            tile={tilesById[option.tileId] ?? null}
            tilesets={tilesets}
            attacking={attacking}
            onAct={onAct}
            onHover={onHover}
          />
        ))
      )}
    </div>
  );
}

/**
 * What a lit row wears, and it is the colour its subject wears in the world.
 *
 * The vocabulary is four colours and each one means one thing: **yellow acts on
 * something, red fights it, white singles it out, blue looks at it.** A row and
 * the outline under the cursor are two ways of pointing at one thing, so the row
 * cannot invent a fifth or borrow one of the other four.
 *
 * Which is why an open box is not red. The red belongs to a *fight*, and it is
 * worn by a target once attack mode has turned pointing at somebody into
 * swinging at them; a chest you have open has nothing to do with that mode, and
 * a panel that went red the moment you drew your sword would be saying so.
 */
function litClass(option: InteractionOption, attacking: boolean): string {
  if (option.action === "open") {
    return "border-interact bg-interact/20 text-paper";
  }
  if (attacking) return "border-danger bg-danger/20 text-paper";
  return "border-paper bg-paper/15 text-paper";
}

function InteractionRow({
  option,
  tile,
  tilesets,
  attacking,
  onAct,
  onHover,
}: {
  option: InteractionOption;
  tile: TileDef | null;
  tilesets: TilesetDef[];
  attacking: boolean;
  onAct: (option: InteractionOption) => void;
  onHover?: (optionId: string | null) => void;
}) {
  const Icon = ICONS[option.action];

  return (
    <button
      type="button"
      onClick={() => onAct(option)}
      onMouseEnter={() => onHover?.(option.id)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(option.id)}
      onBlur={() => onHover?.(null)}
      // Pointing at somebody and having a box open are states you are in, and
      // both rows toggle out of them; a push happens and is over, and a button
      // that claimed otherwise would be announced as stuck on.
      aria-pressed={
        option.action === "target" || option.action === "open"
          ? option.active
          : undefined
      }
      className={[
        "flex w-full shrink-0 items-center gap-2 border-2 p-1 text-left",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        option.active
          ? litClass(option, attacking)
          : "border-paper/40 bg-ink text-paper hover:border-paper",
      ].join(" ")}
    >
      <TilePreview
        tile={tile}
        tilesets={tilesets}
        size={SPRITE_SIZE_PX}
        direction={FRONT}
        still
        chrome={false}
        background={null}
        className="shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1 text-xs font-medium uppercase">
          <Icon size={14} stroke={2} aria-hidden="true" />
          {option.label}
        </span>
        <span className="truncate text-xs text-paper/70">{option.name}</span>
        {option.health ? <RowHealth health={option.health} /> : null}
      </span>
    </button>
  );
}

/**
 * How much of a body is left, under the name of it.
 *
 * The reading and its colour come from `../render/healthBar`, which is the same
 * arithmetic the bar over the creature's head runs: a row that went red at a
 * different moment than the world did would be two gauges to learn instead of
 * one. The fill is stated in that module's bricks and turned into a percentage
 * here — what the bricks are buying is the rounding, not the pixels. A creature
 * on its last hit point keeps a visible sliver, and one that has taken a
 * scratch never rounds back up to a full track.
 *
 * Named for a screen reader rather than left as decoration, because the bar is
 * the only place this number appears. It is a label rather than text on purpose:
 * the list around it is a live region, and a reading that changed as text would
 * have every blow in a fight read out over the fight.
 */
function RowHealth({ health }: { health: { hp: number; maxHp: number } }) {
  const fraction = healthFraction(health.hp, health.maxHp);

  return (
    <span
      role="img"
      aria-label={`${health.hp} of ${health.maxHp} health`}
      className="mt-1 flex h-1 w-full border border-paper/40 bg-ink"
    >
      <span
        style={{
          width: `${(healthBarFillBricks(fraction) / HEALTH_BAR_BRICKS) * 100}%`,
          backgroundColor: healthBarColor(fraction),
        }}
      />
    </span>
  );
}
