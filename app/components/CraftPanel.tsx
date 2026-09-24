import { IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef } from "react";
import type { CraftingWindow } from "../game/craft";
import { bindNumberKeys, numberKeyLabel } from "../game/heldDirections";
import { craftRecipeName, craftVerb, type CraftInput } from "../lib/interactions";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";
import {
  CLOSE_BUTTON_CLASS,
  CLOSE_ICON_SIZE_PX,
  LABEL_CLASS,
  PanelButton,
} from "./ConversationPanel";
import { KeyHint } from "./KeyHint";
import { TilePreview } from "./TilePreview";

/**
 * A crafter's recipes, as a panel: every one the viewer can afford right now,
 * and nothing else.
 *
 * Takes the interaction list's place on a conversation's terms — same walls,
 * same buttons, same close — because it is the same kind of thing: what is in
 * reach, said longer. The list it draws is worked out by the render loop from
 * the kit this side already holds (see `../game/craft`'s `offeredRecipes`), so
 * a recipe drops out of the window the moment its inputs run out and the
 * window closes itself when none are left.
 *
 * What a recipe *gives* is deliberately not drawn. The name is the author's
 * whole say in how a recipe reads, and the odds are part of the game.
 */

const INPUT_SPRITE_SIZE_PX = 16;

type Props = {
  crafting: CraftingWindow;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /** Run the recipe at this position in the crafter's authored list. */
  onCraft: (recipeIndex: number) => void;
  onClose: () => void;
  /** Bind the digit row to the recipes, and draw each one's key. */
  hotkeys?: boolean;
  className?: string;
};

export function CraftPanel({
  crafting,
  tiles,
  tilesets,
  onCraft,
  onClose,
  hotkeys = false,
  className = "",
}: Props) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const def = tilesById[crafting.tileId];
  const name = def?.name ?? crafting.tileId;
  const title = `${craftVerb(crafting.craft)} · ${name}`;

  // Through a ref, because the keys are bound once per list of recipes and
  // `onCraft` is an inline arrow upstream.
  const onCraftRef = useRef(onCraft);
  onCraftRef.current = onCraft;
  const recipes = crafting.recipes;
  useEffect(() => {
    if (!hotkeys) return;
    return bindNumberKeys((position) => {
      const offered = recipes[position];
      if (offered) onCraftRef.current(offered.index);
    });
  }, [hotkeys, recipes]);

  return (
    <section
      aria-label={title}
      className={`flex flex-col gap-1 border-2 border-paper/25 bg-paper/5 p-1.5 ${className}`}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        {def ? (
          <TilePreview
            tile={def}
            tilesets={tilesets}
            size={TITLE_SPRITE_SIZE_PX}
            direction="s"
            still
            chrome={false}
            background={null}
          />
        ) : null}
        <h2 className="text-[11px] font-bold uppercase tracking-wide text-paper/50">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${name}`}
          className={CLOSE_BUTTON_CLASS}
        >
          <IconX size={CLOSE_ICON_SIZE_PX} stroke={3} aria-hidden="true" />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain">
        {recipes.map(({ index, recipe }, position) => (
          <PanelButton key={index} onPress={() => onCraft(index)}>
            {hotkeys ? <KeyHint label={numberKeyLabel(position)} /> : null}
            <span className={LABEL_CLASS}>{craftRecipeName(crafting.craft, recipe)}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {recipe.inputs.map((input, i) => (
                <RecipeInput
                  key={i}
                  input={input}
                  def={tilesById[input.tileId]}
                  tilesets={tilesets}
                />
              ))}
            </span>
          </PanelButton>
        ))}
      </div>
    </section>
  );
}

/** One thing a recipe spends: its sprite, and how many when it is more than one. */
function RecipeInput({
  input,
  def,
  tilesets,
}: {
  input: CraftInput;
  def: TileDef | undefined;
  tilesets: TilesetDef[];
}) {
  const label = `${input.count} ${def?.name ?? input.tileId}`;
  return (
    <span className="flex items-center text-[10px] text-paper/70" title={label}>
      <span className="sr-only">{label}</span>
      {input.count > 1 ? <span aria-hidden="true">{input.count}×</span> : null}
      {def ? (
        <TilePreview
          tile={def}
          tilesets={tilesets}
          size={INPUT_SPRITE_SIZE_PX}
          still
          chrome={false}
          background={null}
        />
      ) : null}
    </span>
  );
}
