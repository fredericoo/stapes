import type { ReactNode } from "react";
import type {
  ItemCard as ItemCardData,
  ItemCardEffect,
  ItemCardRequirement,
  ItemCardResist,
  ItemCardStat,
} from "../game/itemCard";
import { MASTERY_LABELS } from "../lib/mastery";
import { HEADINGS, termLabel } from "../lib/terms";
import type { TileDef, TilesetDef } from "../lib/types";
import { SpritePreview, TilePreview } from "./TilePreview";

/**
 * One item, drawn as a card.
 *
 * ## The layout follows the genre convention
 *
 * The order is the one RPG item tooltips have used for decades, and it works
 * for the same reason: a player comparing two swords reads top-down and stops
 * once they have their answer. Picture and name, kind, what is written on this
 * copy, the profile, what it resists, what it asks, and what a blow leaves
 * behind. The order never varies with the item.
 *
 * Sections with nothing to say are omitted, and the ones that remain keep their
 * positions. A weapon shows a profile and requirements; a breastplate shows a
 * profile and resistances; neither puts a row where the other put something
 * different.
 *
 * ## Light card over a dark game
 *
 * `bg-paper` with a hard border and shadow, matching every other popup here.
 * It also fixes a contrast problem the dark panels have: red and green carry
 * meaning on this card — met and unmet, better and worse — and on the near-black
 * panel background both sit near 1.8:1. On paper they are above 5:1.
 *
 * ## The drawing is not announced
 *
 * `aria-hidden` throughout. The trigger's `aria-label` already carries the card
 * as sentences — see `../game/itemCard`'s `speech` — and two copies in one
 * accessible name would read it twice.
 */

/** Big enough to read a 2×2 sprite at, and the size the slot draws it. */
const CARD_SPRITE_SIZE_PX = 32;

/** A mark beside a name, the size the strip and the panels use for one. */
const EFFECT_ICON_SIZE_PX = 14;

export function ItemCard({
  card,
  tile,
  tilesets,
}: {
  card: ItemCardData;
  tile: TileDef;
  tilesets: TilesetDef[];
}) {
  return (
    <div aria-hidden className="flex w-64 max-w-full flex-col gap-1.5 py-0.5">
      <header className="flex items-start gap-2">
        {/* The thing itself, at the size the square it came out of drew it — so
            the card reads as an expansion of that square rather than a
            separate window about it. */}
        <span
          className="grid shrink-0 place-items-center border-2 border-ink/20 bg-ink/5"
          style={{ width: CARD_SPRITE_SIZE_PX + 4, height: CARD_SPRITE_SIZE_PX + 4 }}
        >
          <TilePreview
            tile={tile}
            tilesets={tilesets}
            size={CARD_SPRITE_SIZE_PX}
            direction="s"
            still
            chrome={false}
            background={null}
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-bold leading-tight break-words">
            {card.name}
            {card.count === null ? null : (
              // Beside the name rather than as a row: it is part of what the
              // reader is looking at. The same multiplication sign the badge on
              // the square uses — see `../lib/piles`' `pileTally`.
              <span className="ml-1 tabular-nums text-ink/60">
                {"\u00d7"}
                {card.count}
              </span>
            )}
          </span>
          {card.kind ? (
            <span className="text-[10px] font-bold uppercase tracking-wide text-ink/70">
              {card.kind}
            </span>
          ) : null}
          {card.elements.length > 0 ? (
            <span className="mt-0.5 flex flex-wrap gap-1">
              {card.elements.map((element) => (
                <span
                  key={element}
                  className="border border-ink/30 px-1 text-[9px] font-bold uppercase tracking-wide text-ink/70"
                >
                  {element}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </header>

      {/* What is written on this one and what examining it says, set apart
          from the profile because they are the parts of the card that are not
          facts about every copy. One block, because a reader wants both at
          once and the difference between them is about who else gets to see
          them rather than about how they read. */}
      {card.inscription || card.description ? (
        <div className="flex flex-col gap-0.5 border-l-2 border-ink/20 pl-1.5 text-[11px] leading-snug text-ink/70 italic">
          {card.inscription ? <p>{card.inscription}</p> : null}
          {card.description ? <p>{card.description}</p> : null}
        </div>
      ) : null}

      {card.stats.length > 0 ? (
        <dl className="flex flex-col gap-0.5">
          {card.stats.map((stat) => (
            <StatRow key={stat.term} stat={stat} />
          ))}
        </dl>
      ) : null}

      {card.resists.length > 0 ? (
        <Section title={HEADINGS.resists}>
          <ul className="flex flex-col gap-0.5">
            {card.resists.map((row) => (
              <ResistRow key={row.mastery} row={row} />
            ))}
          </ul>
        </Section>
      ) : null}

      {card.requirements.length > 0 ? (
        <Section title={HEADINGS.requires}>
          <ul className="flex flex-col gap-0.5">
            {card.requirements.map((row) => (
              <RequirementRow key={row.mastery} row={row} />
            ))}
          </ul>
        </Section>
      ) : null}

      {card.effects.length > 0 ? (
        <Section title={card.effectsTitle}>
          <ul className="flex flex-col gap-1">
            {card.effects.map((effect) => (
              <EffectRow key={effect.id} effect={effect} tilesets={tilesets} />
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/**
 * A ruled-off block with a small heading over it.
 *
 * The rules keep the card scannable: a reader looking for what a weapon asks
 * finds the word "Requires" instead of counting rows.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5 border-t-2 border-ink/15 pt-1">
      <h4 className="text-[9px] font-bold uppercase tracking-widest text-ink/60">{title}</h4>
      {children}
    </section>
  );
}

/**
 * One figure: the caption on the left, the value on the right.
 *
 * What a just-qualified wielder gets appears beside it whenever the two differ.
 * That comparison is the main reason the card carries numbers: "Damage 6" says
 * nothing a sentence could not, while "Damage 6, and a fresh owner does 17" says
 * what is wrong and what fixing it is worth. Meeting a requirement exactly
 * leaves one figure, because there is then nobody to compare against.
 *
 * The caption comes out of `../lib/terms` rather than off the row, so the word
 * this card uses for a measurement and the word the stats panel uses for the
 * same one cannot come apart.
 */
function StatRow({ stat }: { stat: ItemCardStat }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-tight">
      <dt className="shrink-0 text-ink/70">{termLabel(stat.term)}</dt>
      {/* The leader lives inside the value rather than between the pair: a `dl`
          takes `dt` and `dd` and nothing else, and a loose span between them is
          markup no parser is obliged to keep where it was put. */}
      <dd className="flex min-w-0 flex-1 items-baseline gap-1 tabular-nums">
        <span className="min-w-0 flex-1 self-center border-b border-dotted border-ink/20" />
        {stat.base ? (
          // Struck through rather than merely dimmed: this is what the weapon
          // does for somebody who has just earned it, and a reader skimming has
          // to be able to tell in one glance which of the two is theirs.
          <span className="shrink-0 text-ink/50 line-through">{stat.base}</span>
        ) : null}
        <span className={`shrink-0 font-bold ${TONE_TEXT[stat.tone]}`}>{stat.value}</span>
      </dd>
    </div>
  );
}

/** The card's whole colour vocabulary: better, worse, and neither. */
const TONE_TEXT = {
  plain: "text-ink",
  good: "text-accent",
  bad: "text-danger",
} as const;

/**
 * One mastery a weapon asks for, and what the reader has.
 *
 * Both numbers, and this is the one place the old "spreadsheet" objection has
 * real force — `../lib/weaponFeel` argues at length that a figure is a thing to
 * compute against where a sentence is a thing to act on. What the pair of
 * numbers adds is *which* mastery and *how far*: a player short on Toughness for
 * an axe they have been training Blunt with cannot act on "you can hardly wield
 * it" at all, because it does not say where to go.
 *
 * **This block is the whole of what the card says about the gate now.** It used
 * to be followed by a bar reading "Accuracy & swing rate — 50%", and that bar
 * was the third telling of one fact: the red here says the gate is shut, the
 * struck-through `Swing` and `Hit` rows above say what it costs in the units a
 * blow is actually fought in, and the bar restated the cost as a pooled
 * percentage — the one form of it a player cannot work back to a mastery. See
 * `../game/itemCard`'s {@link ItemCardData.requirements}.
 */
function RequirementRow({ row }: { row: ItemCardRequirement }) {
  return (
    <li className="flex items-baseline gap-2 text-[11px] leading-tight">
      <span className={`shrink-0 font-bold ${row.met ? "text-accent" : "text-danger"}`}>
        {row.met ? "✓" : "✕"}
      </span>
      <span className="shrink-0 text-ink/80">{MASTERY_LABELS[row.mastery]}</span>
      <span className="min-w-0 flex-1 self-center border-b border-dotted border-ink/20" />
      <span className="shrink-0 tabular-nums text-ink/70">
        <span className={`font-bold ${row.met ? "text-accent" : "text-danger"}`}>{row.have}</span>
        {" / "}
        {row.required}
      </span>
    </li>
  );
}

/**
 * One kind of blow this piece is unusually good against.
 *
 * The total is bold and the flat number is struck through behind it, the same
 * shape the weapon rows use for yours-against-the-item's-own. It answers the
 * same question: this is what a blade loses, that is what everything else
 * loses. A bare "+3" would have to be added to a figure further up the card
 * before it meant anything.
 */
function ResistRow({ row }: { row: ItemCardResist }) {
  return (
    <li className="flex items-baseline gap-2 text-[11px] leading-tight">
      <span className="shrink-0 text-ink/80">{MASTERY_LABELS[row.mastery]}</span>
      <span className="min-w-0 flex-1 self-center border-b border-dotted border-ink/20" />
      <span className="shrink-0 tabular-nums text-ink/50 line-through">
        {row.total - row.extra}
      </span>
      <span className="shrink-0 font-bold tabular-nums text-accent">{row.total}</span>
    </li>
  );
}

/**
 * One thing an item leaves behind: what it is, how likely, how long, what it
 * does.
 *
 * The description sits under the name rather than in a tooltip of its own,
 * because this is already the tooltip. A status named here that needed a second
 * hover to explain would be unreachable.
 */
function EffectRow({ effect, tilesets }: { effect: ItemCardEffect; tilesets: TilesetDef[] }) {
  return (
    <li className="flex gap-1.5">
      <span
        className="mt-0.5 grid shrink-0 place-items-center"
        style={{ width: EFFECT_ICON_SIZE_PX, height: EFFECT_ICON_SIZE_PX }}
      >
        {effect.icon ? (
          <SpritePreview sprite={effect.icon} tilesets={tilesets} size={EFFECT_ICON_SIZE_PX} />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="flex flex-wrap items-baseline gap-x-1.5 text-[11px]">
          <span className={`font-bold ${effect.tone === "bad" ? "text-danger" : "text-accent"}`}>
            {effect.name}
          </span>
          <span className="tabular-nums text-ink/70">
            {effect.chance === null ? effect.duration : `${effect.chance}% · ${effect.duration}`}
          </span>
        </span>
        <span className="text-[10px] leading-snug text-ink/70">{effect.description}</span>
      </span>
    </li>
  );
}
