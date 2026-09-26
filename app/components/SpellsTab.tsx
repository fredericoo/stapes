import type { BattlerDef, NaturalSpell } from "../lib/battler";
import { DEFAULT_BATTLER, DEFAULT_SPELL_NAME, MAX_SPELL_NAME_LENGTH } from "../lib/battler";
import { DEFAULT_STONE } from "../lib/item";
import { hasAnyInteraction, type TileInteractions } from "../lib/interactions";
import type { StatusDef } from "../lib/status";
import { type AnchoredSprite, defaultBase, type TileDef, type TilesetDef } from "../lib/types";
import { Button, FieldLabel, Input, SectionTitle, Select } from "../ui";
import { BattlerIssues } from "./BattlerIssues";
import { SpriteSelector } from "./SpriteSelector";
import { StoneFields } from "./StoneFields";
import { SpritePreview } from "./TilePreview";

type Props = {
  draft: TileDef;
  onChange: (next: TileDef) => void;
  tiles: TileDef[];
  tilesets: TilesetDef[];
  statusDefs?: Record<string, StatusDef>;
  battlerIssues: readonly string[];
};

function freshSpell(existing: readonly NaturalSpell[]): NaturalSpell {
  let name = DEFAULT_SPELL_NAME;
  const taken = new Set(existing.map((spell) => spell.name));
  for (let i = 2; taken.has(name); i++) name = `${DEFAULT_SPELL_NAME} ${i}`;
  return { ...DEFAULT_STONE, effect: { ...DEFAULT_STONE.effect }, name };
}

function IconField({
  icon,
  tilesets,
  onChange,
}: {
  icon: AnchoredSprite | null;
  tilesets: TilesetDef[];
  onChange: (icon: AnchoredSprite | undefined) => void;
}) {
  const tileset = tilesets.find((one) => one.id === icon?.tilesetId) ?? null;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <FieldLabel info="The picture on the button that casts it. A carried stone borrows its tile's sprite; this has no tile, so it carries one. Leave it unset for a spell only a creature ever casts — nobody sees a button for those.">
        Icon
      </FieldLabel>
      <div className="flex items-center gap-2">
        <SpritePreview sprite={icon} tilesets={tilesets} size={24} />
        <Select
          value={icon?.tilesetId || null}
          onValueChange={(id) => {
            if (!id) return;
            const rect = icon?.rect ?? { x: 0, y: 0, w: 1, h: 1 };
            onChange({ tilesetId: id, rect, base: defaultBase(rect) });
          }}
          options={tilesets.map((one) => ({ value: one.id, label: one.name }))}
          placeholder="Sheet…"
          ariaLabel="Icon sheet"
        />
        {icon ? (
          <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
            Clear
          </Button>
        ) : null}
      </div>
      {tileset ? (
        <SpriteSelector
          tileset={tileset}
          value={icon}
          onChange={(sprite) =>
            onChange({
              tilesetId: tileset.id,
              rect: sprite.rect,
              base: sprite.base ?? defaultBase(sprite.rect),
            })
          }
        />
      ) : null}
    </div>
  );
}

export function SpellsTab({
  draft,
  onChange,
  tiles,
  tilesets,
  statusDefs = {},
  battlerIssues,
}: Props) {
  const battler = draft.interactions?.battler ?? DEFAULT_BATTLER;
  const spells = battler.spells ?? [];

  const setBattler = (next: BattlerDef) => {
    const merged: TileInteractions = { ...draft.interactions, battler: next };
    onChange({
      ...draft,
      interactions: hasAnyInteraction(merged) ? merged : undefined,
    });
  };

  const setSpells = (next: NaturalSpell[]) =>
    setBattler({ ...battler, spells: next.length ? next : undefined });

  const patchSpell = (index: number, fields: Partial<NaturalSpell>) =>
    setSpells(spells.map((spell, i) => (i === index ? { ...spell, ...fields } : spell)));

  return (
    <div className="flex flex-col gap-4">
      <BattlerIssues issues={battlerIssues} />
      <section className="flex flex-col gap-3 border-2 border-border bg-panel p-3">
        <SectionTitle info="Spells this body has of its own, with nothing in its hands — the natural weapon's opposite number. They are arcane stones in every sense; what they are not is carried, so each one names itself. A brain casts one by that name, and on the player they sit in the spell row after the three squares.">
          Spells
        </SectionTitle>

        {spells.length === 0 ? (
          <p className="text-[11px] leading-snug text-muted">
            None. A body with no spells of its own casts only what it is holding.
          </p>
        ) : null}

        {spells.map((spell, index) => (
          <div key={index} className="flex flex-col gap-3 border-t-2 border-border pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <FieldLabel info="What it is called — on the button that casts it, on a skull it kills somebody with, and in the brain line that names it. Renaming one is renaming what a `cast` action points at, so a brain naming the old name stops firing.">
                  Name
                </FieldLabel>
                <Input
                  value={spell.name}
                  maxLength={MAX_SPELL_NAME_LENGTH}
                  onChange={(e) => patchSpell(index, { name: e.target.value })}
                />
              </label>

              <IconField
                icon={spell.icon ?? null}
                tilesets={tilesets}
                onChange={(icon) => patchSpell(index, { icon })}
              />

              <Button
                size="sm"
                variant="danger"
                className="ml-auto"
                onClick={() => setSpells(spells.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>

            <StoneFields
              stone={spell}
              onChange={(fields) => patchSpell(index, fields)}
              tiles={tiles}
              statusDefs={statusDefs}
            />
          </div>
        ))}

        <div className="border-t-2 border-border pt-3">
          <Button
            size="sm"
            className="w-fit"
            onClick={() => setSpells([...spells, freshSpell(spells)])}
          >
            Add spell
          </Button>
        </div>
      </section>
    </div>
  );
}
