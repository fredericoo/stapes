import { IconHandMove, IconSwitch, IconSword } from "@tabler/icons-react";
import { useMemo } from "react";
import type {
  InteractionAction,
  InteractionOption,
} from "../game/interactionOptions";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
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
 * Rows carry the option and nothing else; {@link onAct} hands it back to
 * whoever owns the session. Nothing in here knows what a push is.
 */

/** Which sprite stands for a tile in a list — the one facing the reader. */
const FRONT: "s" = "s";

const ICONS: Record<InteractionAction, typeof IconSword> = {
  attack: IconSword,
  push: IconHandMove,
  switch: IconSwitch,
};

const SPRITE_SIZE_PX = 32;

export function InteractionList({
  options,
  tiles,
  tilesets,
  onAct,
  onHover,
  className = "",
}: {
  options: InteractionOption[];
  tiles: TileDef[];
  tilesets: TilesetDef[];
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
            onAct={onAct}
            onHover={onHover}
          />
        ))
      )}
    </div>
  );
}

function InteractionRow({
  option,
  tile,
  tilesets,
  onAct,
  onHover,
}: {
  option: InteractionOption;
  tile: TileDef | null;
  tilesets: TilesetDef[];
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
      // Only a fight is a state you are in; a push happens and is over, and a
      // button that claimed otherwise would be announced as stuck on.
      aria-pressed={option.action === "attack" ? option.active : undefined}
      className={[
        "flex w-full shrink-0 items-center gap-2 border-2 p-1 text-left",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        // Red while it is the fight you are in, which is the colour its outline
        // is wearing out in the world — the same rule the look mode's blue
        // follows, so a row and the body it names are never separately learned.
        option.active
          ? "border-danger bg-danger/20 text-paper"
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
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1 text-xs font-medium uppercase">
          <Icon size={14} stroke={2} aria-hidden="true" />
          {option.label}
        </span>
        <span className="truncate text-xs text-paper/70">{option.name}</span>
      </span>
    </button>
  );
}
