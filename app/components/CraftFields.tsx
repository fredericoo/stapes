import {
  DEFAULT_CRAFT_RECIPE,
  MAX_CRAFT_CHANCE,
  MAX_CRAFT_INPUT_COUNT,
  MAX_CRAFT_INPUTS,
  MAX_CRAFT_OUTPUTS,
  MAX_CRAFT_RECIPES,
  MAX_CRAFT_WEIGHT,
  type CraftInput,
  type CraftInteraction,
  type CraftOutput,
  type CraftOutputKind,
  type CraftRecipe,
} from "../lib/interactions";
import type { TileDef, TilesetDef } from "../lib/types";
import { Button, FieldLabel, Input, NumberInput, Segmented } from "../ui";
import { TileIdMultiSelect } from "./TileIdMultiSelect";

const DEFAULT_WEIGHT = 1;

const OUTPUT_KIND_OPTIONS: { value: CraftOutputKind; label: string }[] = [
  { value: "all", label: "All of" },
  { value: "one", label: "One of" },
];

type Props = {
  craft: CraftInteraction;
  onChange: (next: CraftInteraction | undefined) => void;
  giveable: TileDef[];
  tilesets: TilesetDef[];
};

export function CraftFields({ craft, onChange, giveable, tilesets }: Props) {
  const patchRecipe = (index: number, next: CraftRecipe) => {
    onChange({ ...craft, recipes: craft.recipes.map((r, i) => (i === index ? next : r)) });
  };

  const addRecipe = () => {
    if (craft.recipes.length >= MAX_CRAFT_RECIPES) return;
    onChange({ ...craft, recipes: [...craft.recipes, DEFAULT_CRAFT_RECIPE] });
  };

  const removeRecipe = (index: number) => {
    const recipes = craft.recipes.filter((_, i) => i !== index);
    onChange(recipes.length > 0 ? { ...craft, recipes } : undefined);
  };

  return (
    <>
      {craft.recipes.map((recipe, index) => (
        <RecipeCard
          key={index}
          index={index}
          recipe={recipe}
          onChange={(next) => patchRecipe(index, next)}
          onRemove={() => removeRecipe(index)}
          giveable={giveable}
          tilesets={tilesets}
        />
      ))}

      {craft.recipes.length < MAX_CRAFT_RECIPES ? (
        <Button variant="secondary" size="sm" onClick={addRecipe}>
          Add recipe
        </Button>
      ) : (
        <span className="text-[11px] leading-snug text-muted">
          Up to {MAX_CRAFT_RECIPES} recipes.
        </span>
      )}
    </>
  );
}

function RecipeCard({
  index,
  recipe,
  onChange,
  onRemove,
  giveable,
  tilesets,
}: {
  index: number;
  recipe: CraftRecipe;
  onChange: (next: CraftRecipe) => void;
  onRemove: () => void;
  giveable: TileDef[];
  tilesets: TilesetDef[];
}) {
  return (
    <div className="flex flex-col gap-3 border-2 border-border bg-paper p-3">
      <div className="flex items-start justify-between gap-2">
        <FieldLabel>Recipe {index + 1}</FieldLabel>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <FieldLabel info="What the recipe is called in the crafting window — “Forge Pyre”. Blank reads as the action label.">
          Name
        </FieldLabel>
        <Input
          value={recipe.name}
          onChange={(e) => onChange({ ...recipe, name: e.target.value })}
          className="w-48"
        />
      </label>

      <InputsFields
        inputs={recipe.inputs}
        onChange={(inputs) => onChange({ ...recipe, inputs })}
        giveable={giveable}
        tilesets={tilesets}
      />

      <OutputFields
        output={recipe.output}
        onChange={(output) => onChange({ ...recipe, output })}
        giveable={giveable}
        tilesets={tilesets}
      />
    </div>
  );
}

function InputsFields({
  inputs,
  onChange,
  giveable,
  tilesets,
}: {
  inputs: CraftInput[];
  onChange: (next: CraftInput[]) => void;
  giveable: TileDef[];
  tilesets: TilesetDef[];
}) {
  const patch = (index: number, next: Partial<CraftInput>) =>
    onChange(inputs.map((input, i) => (i === index ? { ...input, ...next } : input)));

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel info="Everything spent, all at once. Counted across piles, from the hands first, then the bags. The recipe is only listed while the player carries all of it.">
        Spends
      </FieldLabel>
      {inputs.map((input, index) => (
        <div key={index} className="flex items-end gap-2">
          <NumberInput
            min={1}
            max={MAX_CRAFT_INPUT_COUNT}
            step={1}
            value={input.count}
            onChange={(count) => patch(index, { count })}
            className="w-16"
            aria-label="How many"
          />
          <div className="min-w-0 flex-1">
            <TileIdMultiSelect
              tiles={giveable}
              tilesets={tilesets}
              selectedIds={input.tileId ? [input.tileId] : []}
              onChange={(ids) => patch(index, { tileId: ids[0] ?? "" })}
              label={`Input ${index + 1}`}
              emptyHint="None — dropped on save."
              single
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(inputs.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      {inputs.length < MAX_CRAFT_INPUTS ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange([...inputs, { tileId: "", count: 1 }])}
        >
          Add input
        </Button>
      ) : null}
    </div>
  );
}

function OutputFields({
  output,
  onChange,
  giveable,
  tilesets,
}: {
  output: CraftOutput;
  onChange: (next: CraftOutput) => void;
  giveable: TileDef[];
  tilesets: TilesetDef[];
}) {
  const setKind = (kind: CraftOutputKind) => {
    if (kind === output.kind) return;
    const tileIds = output.items.map((item) => item.tileId);
    onChange(
      kind === "all"
        ? { kind, items: tileIds.map((tileId) => ({ tileId, chance: MAX_CRAFT_CHANCE })) }
        : { kind, items: tileIds.map((tileId) => ({ tileId, weight: DEFAULT_WEIGHT })) },
    );
  };

  const setTile = (index: number, tileId: string) => onChange(withItem(output, index, { tileId }));
  const setNumber = (index: number, value: number) =>
    onChange(
      withItem(output, index, output.kind === "all" ? { chance: value } : { weight: value }),
    );
  const remove = (index: number) =>
    onChange(
      output.kind === "all"
        ? { kind: "all", items: output.items.filter((_, i) => i !== index) }
        : { kind: "one", items: output.items.filter((_, i) => i !== index) },
    );
  const add = () =>
    onChange(
      output.kind === "all"
        ? { kind: "all", items: [...output.items, { tileId: "", chance: MAX_CRAFT_CHANCE }] }
        : { kind: "one", items: [...output.items, { tileId: "", weight: DEFAULT_WEIGHT }] },
    );

  const numberLabel = output.kind === "all" ? "Chance (%)" : "Weight";

  return (
    <div className="flex flex-col gap-2">
      <FieldLabel info="All of: every item rolls its own chance, and a recipe whose rolls all fail takes the inputs and gives nothing. One of: exactly one item comes back, picked by weight — 1, 3 and 2 are a sixth, a half and a third. The player needs room for the worst case either way.">
        Gives
      </FieldLabel>
      <div>
        <Segmented<CraftOutputKind>
          value={output.kind}
          onChange={setKind}
          options={OUTPUT_KIND_OPTIONS}
          size="sm"
          ariaLabel="Output kind"
        />
      </div>
      {output.items.map((item, index) => (
        <div key={index} className="flex items-end gap-2">
          <NumberInput
            min={1}
            max={output.kind === "all" ? MAX_CRAFT_CHANCE : MAX_CRAFT_WEIGHT}
            step={1}
            value={"chance" in item ? item.chance : item.weight}
            onChange={(value) => setNumber(index, value)}
            className="w-16"
            aria-label={numberLabel}
          />
          <div className="min-w-0 flex-1">
            <TileIdMultiSelect
              tiles={giveable}
              tilesets={tilesets}
              selectedIds={item.tileId ? [item.tileId] : []}
              onChange={(ids) => setTile(index, ids[0] ?? "")}
              label={`${numberLabel} · output ${index + 1}`}
              emptyHint="None — dropped on save."
              single
            />
          </div>
          <Button variant="ghost" size="sm" onClick={() => remove(index)}>
            Remove
          </Button>
        </div>
      ))}
      {output.items.length < MAX_CRAFT_OUTPUTS ? (
        <Button variant="secondary" size="sm" onClick={add}>
          Add output
        </Button>
      ) : null}
    </div>
  );
}

function withItem(
  output: CraftOutput,
  index: number,
  patch: { tileId?: string; chance?: number; weight?: number },
): CraftOutput {
  if (output.kind === "all") {
    const { weight: _weight, ...rest } = patch;
    return {
      kind: "all",
      items: output.items.map((item, i) => (i === index ? { ...item, ...rest } : item)),
    };
  }
  const { chance: _chance, ...rest } = patch;
  return {
    kind: "one",
    items: output.items.map((item, i) => (i === index ? { ...item, ...rest } : item)),
  };
}
