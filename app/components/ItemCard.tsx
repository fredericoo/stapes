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

const CARD_SPRITE_SIZE_PX = 32;

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5 border-t-2 border-ink/15 pt-1">
      <h4 className="text-[9px] font-bold uppercase tracking-widest text-ink/60">{title}</h4>
      {children}
    </section>
  );
}

function StatRow({ stat }: { stat: ItemCardStat }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-tight">
      <dt className="shrink-0 text-ink/70">{termLabel(stat.term)}</dt>
      <dd className="flex min-w-0 flex-1 items-baseline gap-1 tabular-nums">
        <span className="min-w-0 flex-1 self-center border-b border-dotted border-ink/20" />
        {stat.base ? <span className="shrink-0 text-ink/50 line-through">{stat.base}</span> : null}
        <span className={`shrink-0 font-bold ${TONE_TEXT[stat.tone]}`}>{stat.value}</span>
      </dd>
    </div>
  );
}

const TONE_TEXT = {
  plain: "text-ink",
  good: "text-accent",
  bad: "text-danger",
} as const;

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
