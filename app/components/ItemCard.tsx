import type { ReactNode } from "react";
import type {
  ItemCard as ItemCardData,
  ItemCardEffect,
  ItemCardRequirement,
  ItemCardStat,
} from "../game/itemCard";

import type { TileDef, TilesetDef } from "../lib/types";
import { SpritePreview, TilePreview } from "./TilePreview";

/**
 * What one item is, drawn the way a game draws it.
 *
 * ## Borrowed from the genre on purpose
 *
 * The shape is the one every MMO settled on twenty years ago, and it is worth
 * copying because it was arrived at the same way: a player comparing two swords
 * reads top-down and stops as soon as they have their answer. So the order is
 * fixed and never conditional on content — picture and name, what kind of thing
 * it is, what is written on this one, the profile, what it asks, what you get
 * out of it, what it leaves behind, and the sentence about your hands last. A
 * card whose rows moved about depending on the item would have to be *read*
 * rather than scanned.
 *
 * ## Light, over a dark game
 *
 * `bg-paper` with a hard border and a hard shadow, which is every other popup in
 * this game and not a decision taken again here. It also settles the one thing
 * the panels could not do: red and green are the vocabulary this card is written
 * in — met and unmet, better and worse — and on the near-black panel background
 * both of them sit at about twice the contrast a reader needs. On paper they are
 * five to one and up.
 *
 * ## It says nothing aloud
 *
 * `aria-hidden` throughout, because the trigger's own `aria-label` already
 * carries the whole card as sentences — see `../game/itemCard`'s `speech`. Two
 * copies of one fact in one accessible name reads the name twice.
 */

/** Big enough to read a 2×2 sprite at, and the size the slot draws it. */
const CARD_SPRITE_SIZE_PX = 32;

/** A mark beside a name, the size the strip and the panels use for one. */
const EFFECT_ICON_SIZE_PX = 14;

/**
 * Where meeting everything a weapon asks falls on the bar, and its top.
 *
 * The same figure twice, and deliberately: requirements are a gate rather than a
 * scaling term, so a fully-met weapon is *all* of the weapon and there is
 * nothing past it to draw. The bar used to run to 125 with a notch at 100, back
 * when exceeding a requirement bought a little extra — see `../lib/mastery`'s
 * `REQUIREMENTS_MET`, which is where that stopped being true.
 */
const BAR_MET_PERCENT = 100;

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
            the card reads as that square opened up rather than as a separate
            window about it. */}
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
          </span>
          {card.kind ? (
            <span className="text-[10px] font-bold uppercase tracking-wide text-ink/70">
              {card.kind}
            </span>
          ) : null}
        </span>
      </header>

      {/* What is written on this one, set apart from the profile because it is
          the one part of the card that is not a fact about every copy. */}
      {card.description ? (
        <p className="border-l-2 border-ink/20 pl-1.5 text-[11px] leading-snug text-ink/70 italic">
          {card.description}
        </p>
      ) : null}

      {card.stats.length > 0 ? (
        <dl className="flex flex-col gap-0.5">
          {card.stats.map((stat) => (
            <StatRow key={stat.key} stat={stat} />
          ))}
        </dl>
      ) : null}

      {card.requirements.length > 0 ? (
        <Section title="Requires">
          <ul className="flex flex-col gap-0.5">
            {card.requirements.map((row) => (
              <RequirementRow key={row.mastery} row={row} />
            ))}
          </ul>
        </Section>
      ) : null}

      {card.effectiveness !== null ? (
        <Effectiveness percent={card.effectiveness} />
      ) : null}

      {card.effects.length > 0 ? (
        <Section title={card.effectiveness === null ? "Grants" : "On hit"}>
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
 * The rule is what makes the card scannable at a glance: a reader looking for
 * what a weapon asks finds the word "Requires" rather than counting rows.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5 border-t-2 border-ink/15 pt-1">
      <h4 className="text-[9px] font-bold uppercase tracking-widest text-ink/60">
        {title}
      </h4>
      {children}
    </section>
  );
}

/**
 * One figure: what it is on the left, what it comes to on the right.
 *
 * The item's own number rides alongside in brackets whenever it differs from
 * what the reader would get — which is the whole argument for the card carrying
 * numbers at all. "Damage 6" says nothing a sentence could not; "Damage 6, and
 * this sword does 17" says exactly what is wrong and what fixing it is worth.
 */
function StatRow({ stat }: { stat: ItemCardStat }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-tight">
      <dt className="shrink-0 text-ink/70">{stat.label}</dt>
      {/* The leader lives inside the value rather than between the pair: a `dl`
          takes `dt` and `dd` and nothing else, and a loose span between them is
          markup no parser is obliged to keep where it was put. */}
      <dd className="flex min-w-0 flex-1 items-baseline gap-1 tabular-nums">
        <span className="min-w-0 flex-1 self-center border-b border-dotted border-ink/20" />
        {stat.base ? (
          // Struck through rather than merely dimmed: this is the number the
          // weapon would do in better hands, and a reader skimming has to be
          // able to tell in one glance which of the two is theirs.
          <span className="shrink-0 text-ink/50 line-through">{stat.base}</span>
        ) : null}
        <span className={`shrink-0 font-bold ${TONE_TEXT[stat.tone]}`}>
          {stat.value}
        </span>
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
 * compute against where a sentence is a thing to act on. The sentence is still
 * here, under the bar below. What the pair of numbers adds is *which* mastery
 * and *how far*: a player short on Toughness for an axe they have been training
 * Blunt with cannot act on "you can hardly wield it" at all, because it does not
 * say where to go.
 */
function RequirementRow({ row }: { row: ItemCardRequirement }) {
  return (
    <li className="flex items-baseline gap-2 text-[11px] leading-tight">
      <span className={`shrink-0 font-bold ${row.met ? "text-accent" : "text-danger"}`}>
        {row.met ? "✓" : "✕"}
      </span>
      <span className="shrink-0 capitalize text-ink/80">{row.mastery}</span>
      <span className="min-w-0 flex-1 self-center border-b border-dotted border-ink/20" />
      <span className="shrink-0 tabular-nums text-ink/70">
        <span className={`font-bold ${row.met ? "text-accent" : "text-danger"}`}>
          {row.have}
        </span>
        {" / "}
        {row.required}
      </span>
    </li>
  );
}

/**
 * How much of the weapon the reader actually gets.
 *
 * **The headline of the card**, which is why it is the one row set in a size
 * anybody can read across a table: every figure above has already been scaled
 * through this number, so a reader who takes nothing else off the card takes the
 * one thing that explains all of it.
 *
 * A full bar means every requirement met and nothing left to earn *on this
 * weapon* — which is not the same as nothing left to earn. Being good with a
 * blade goes on paying after the gate opens, and it shows up above rather than
 * here: a master's damage can run past the number stamped on the blade while
 * this reads a flat hundred. See `../lib/battler`'s `MASTERY_DAMAGE_BONUS`.
 */
function Effectiveness({ percent }: { percent: number }) {
  const met = percent >= BAR_MET_PERCENT;

  return (
    <section className="flex flex-col gap-1 border-t-2 border-ink/15 pt-1">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[9px] font-bold uppercase tracking-widest text-ink/60">
          In your hands
        </h4>
        <span
          className={`ml-auto text-sm font-bold tabular-nums ${met ? "text-accent" : "text-danger"}`}
        >
          {percent}%
        </span>
      </div>
      <span className="flex h-1.5 w-full border border-ink/40 bg-ink/10">
        <span
          className={met ? "bg-accent" : "bg-danger"}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </span>
    </section>
  );
}

/**
 * One thing an item leaves behind: what it is, how likely, how long, what it does.
 *
 * The description is on its own line under the name rather than being left to a
 * second tooltip, because there is no second tooltip to be had — this *is* the
 * popup, and a status named inside one that a player would have to hover to
 * understand would be a dead end.
 */
function EffectRow({
  effect,
  tilesets,
}: {
  effect: ItemCardEffect;
  tilesets: TilesetDef[];
}) {
  return (
    <li className="flex gap-1.5">
      <span
        className="mt-0.5 grid shrink-0 place-items-center"
        style={{ width: EFFECT_ICON_SIZE_PX, height: EFFECT_ICON_SIZE_PX }}
      >
        {effect.icon ? (
          <SpritePreview
            sprite={effect.icon}
            tilesets={tilesets}
            size={EFFECT_ICON_SIZE_PX}
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="flex flex-wrap items-baseline gap-x-1.5 text-[11px]">
          <span
            className={`font-bold ${effect.tone === "bad" ? "text-danger" : "text-accent"}`}
          >
            {effect.name}
          </span>
          <span className="tabular-nums text-ink/70">
            {effect.chance === null ? effect.duration : `${effect.chance}% · ${effect.duration}`}
          </span>
        </span>
        <span className="text-[10px] leading-snug text-ink/70">
          {effect.description}
        </span>
      </span>
    </li>
  );
}
