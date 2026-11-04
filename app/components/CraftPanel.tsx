import { useEffect, useMemo, useRef } from "react";
import type { CraftingWindow } from "../game/craft";
import { bindNumberKeys, numberKeyLabel } from "../game/heldDirections";
import { craftRecipeName, type CraftInput, type CraftOutput } from "../lib/interactions";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import { TITLE_SPRITE_SIZE_PX } from "./ContainerPanel";
import { LABEL_CLASS, PanelButton } from "./ConversationPanel";
import { HudWindow } from "./HudWindow";
import { KeyHint } from "./KeyHint";
import { Tooltip } from "../ui";
import { TilePreview } from "./TilePreview";

const INPUT_SPRITE_SIZE_PX = 16;
const OUTPUT_SPRITE_SIZE_PX = 16;
const CERTAIN_CHANCE = 100;

const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });

const NO_RECIPES_TEXT = "No recipes available";

type Props = {
  crafting: CraftingWindow;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  onCraft: (recipeIndex: number) => void;
  onClose: () => void;
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
    <HudWindow
      label={name}
      title={name}
      icon={
        def ? (
          <TilePreview
            tile={def}
            tilesets={tilesets}
            size={TITLE_SPRITE_SIZE_PX}
            direction="s"
            still
            chrome={false}
            background={null}
          />
        ) : null
      }
      onClose={onClose}
      closeLabel={`Close ${name}`}
      grows
      flush
      className={className}
    >
      <div className="relative flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-1">
        {recipes.length === 0 ? (
          <p className="px-1 py-2 text-center text-detail text-paper/60">{NO_RECIPES_TEXT}</p>
        ) : null}
        {recipes.map(({ index, recipe }, position) => (
          <PanelButton key={index} onPress={() => onCraft(index)}>
            {hotkeys ? <KeyHint label={numberKeyLabel(position)} /> : null}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1">
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
              </span>
              <RecipeOutputs output={recipe.output} tilesById={tilesById} tilesets={tilesets} />
            </span>
          </PanelButton>
        ))}
      </div>
    </HudWindow>
  );
}

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
    <span className="flex items-center text-2xs text-paper/70" title={label}>
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

type OutputOdds = { tileId: string; odds: number };

/**
 * An "all" item rolls its own chance out of 100; a "one" item is picked by its
 * share of the summed weights, so both read as a probability of getting it.
 */
function outputOdds(output: CraftOutput): OutputOdds[] {
  if (output.kind === "all") {
    return output.items.map((item) => ({
      tileId: item.tileId,
      odds: item.chance / CERTAIN_CHANCE,
    }));
  }
  const totalWeight = output.items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return [];
  return output.items.map((item) => ({ tileId: item.tileId, odds: item.weight / totalWeight }));
}

function RecipeOutputs({
  output,
  tilesById,
  tilesets,
}: {
  output: CraftOutput;
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
}) {
  const items = outputOdds(output);
  if (items.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs tabular-nums text-paper/70">
      <span className="sr-only">{output.kind === "one" ? "Makes one of:" : "Makes:"}</span>
      {items.map(({ tileId, odds }, i) => (
        <RecipeOutputItem
          key={i}
          name={tilesById[tileId]?.name ?? tileId}
          def={tilesById[tileId]}
          odds={odds}
          tilesets={tilesets}
        />
      ))}
    </span>
  );
}

function RecipeOutputItem({
  name,
  def,
  odds,
  tilesets,
}: {
  name: string;
  def: TileDef | undefined;
  odds: number;
  tilesets: TilesetDef[];
}) {
  const oddsText = odds < 1 ? percent.format(odds) : null;
  return (
    <Tooltip content={name}>
      <span className="flex items-center">
        <span className="sr-only">
          {name}
          {oddsText ? `, ${oddsText}` : ""}.
        </span>
        {def ? (
          <TilePreview
            tile={def}
            tilesets={tilesets}
            size={OUTPUT_SPRITE_SIZE_PX}
            still
            chrome={false}
            background={null}
          />
        ) : null}
        {oddsText ? <span aria-hidden="true">{oddsText}</span> : null}
      </span>
    </Tooltip>
  );
}
