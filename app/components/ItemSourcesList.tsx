import { Fragment, type ReactNode } from "react";
import type { Exchange, ExchangeSide, Find, FindKind, ItemSources } from "../lib/itemSources";
import type { TileDef, TilesetDef } from "../lib/types";
import { TilePreview } from "./TilePreview";

const ICON_SIZE_PX = 16;

const SHOWN_BEFORE_MORE = 4;

const FIND_LABELS: Record<FindKind, string> = {
  start: "Every new character starts with it",
  gather: "Gathered from",
  drop: "Dropped by",
  decay: "Left when this spoils:",
};

export type ItemSourcesContext = {
  tiles: ReadonlyMap<string, TileDef>;
  tilesets: TilesetDef[];
  itemId: string;
  onPick: (tileId: string) => void;
};

export function ItemSourcesList({
  sources,
  context,
}: {
  sources: ItemSources;
  context: ItemSourcesContext;
}) {
  const finds = distinctFinds(sources.finds, context.tiles);
  const found = finds.length + sources.obtained.length;
  return (
    <>
      <Section title="Where to get it">
        {found === 0 ? (
          <p className="text-detail text-ink/60">No shop, recipe or creature gives this.</p>
        ) : (
          <Rows
            rows={[
              ...finds.map((find) => (
                <FindRow key={`${find.kind}:${find.from}`} find={find} context={context} />
              )),
              ...sources.obtained.map((exchange, index) => (
                <ExchangeRow key={index} exchange={exchange} context={context} />
              )),
            ]}
          />
        )}
      </Section>
      {sources.usedIn.length > 0 ? (
        <Section title="Used for">
          <Rows
            rows={sources.usedIn.map((exchange, index) => (
              <ExchangeRow key={index} exchange={exchange} context={context} />
            ))}
          />
        </Section>
      ) : null}
    </>
  );
}

/**
 * One row per name, at its best chance: the stages of one crystal are separate
 * tiles that all read "Arcane Crystal".
 */
function distinctFinds(finds: Find[], tiles: ReadonlyMap<string, TileDef>): Find[] {
  const best = new Map<string, Find>();
  for (const find of finds) {
    const key = `${find.kind}:${tiles.get(find.from)?.name || find.from}`;
    const held = best.get(key);
    if (!held || find.chance > held.chance) best.set(key, find);
  }
  return [...best.values()];
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1 border-t-2 border-ink/15 pt-1">
      <h3 className="text-2xs font-bold uppercase tracking-widest text-ink/60">{title}</h3>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: ReactNode[] }) {
  const shown = rows.slice(0, SHOWN_BEFORE_MORE);
  const rest = rows.slice(SHOWN_BEFORE_MORE);
  return (
    <ul className="flex flex-col gap-1.5">
      {shown}
      {rest.length > 0 ? (
        <li>
          <details>
            <summary className="cursor-pointer text-detail font-bold text-accent">
              {rest.length} more
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1.5">{rest}</ul>
          </details>
        </li>
      ) : null}
    </ul>
  );
}

function FindRow({ find, context }: { find: Find; context: ItemSourcesContext }) {
  const chance = find.chance >= 100 ? null : formatChance(find.chance);
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-detail leading-tight">
      <span className="text-ink/70">{FIND_LABELS[find.kind]}</span>
      {find.kind === "start" ? null : <TileName tileId={find.from} context={context} />}
      {chance ? <span className="tabular-nums text-ink/60">{chance}</span> : null}
    </li>
  );
}

function ExchangeRow({ exchange, context }: { exchange: Exchange; context: ItemSourcesContext }) {
  const place = context.tiles.get(exchange.at)?.name || exchange.at;
  const where =
    exchange.kind === "trade"
      ? `Trade with ${place}`
      : exchange.name
        ? `${exchange.name}, at ${place}`
        : `Made at ${place}`;
  return (
    <li className="flex flex-col gap-0.5 text-detail leading-tight">
      <span className="text-2xs text-ink/60">{where}</span>
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <Sides sides={exchange.take} context={context} />
        <span aria-label="for" className="text-ink/50">
          →
        </span>
        <Sides sides={exchange.give} context={context} />
      </span>
    </li>
  );
}

function Sides({ sides, context }: { sides: ExchangeSide[]; context: ItemSourcesContext }) {
  return sides.map((side, index) => (
    <Fragment key={`${side.tileId}:${index}`}>
      {index > 0 ? <span className="text-ink/50">{side.chance === null ? "+" : "or"}</span> : null}
      <span className="inline-flex items-center gap-1">
        {side.count > 1 ? <span className="font-bold tabular-nums">{side.count}</span> : null}
        <TileName tileId={side.tileId} context={context} />
        {side.chance === null ? null : (
          <span className="tabular-nums text-ink/60">{formatChance(side.chance)}</span>
        )}
      </span>
    </Fragment>
  ));
}

function TileName({ tileId, context }: { tileId: string; context: ItemSourcesContext }) {
  const tile = context.tiles.get(tileId);
  const name = tile?.name || tileId;
  const icon = tile ? (
    <TilePreview
      tile={tile}
      tilesets={context.tilesets}
      size={ICON_SIZE_PX}
      direction="s"
      still
      chrome={false}
      background={null}
    />
  ) : null;
  if (tile?.kind !== "item") {
    return (
      <span className="inline-flex items-center gap-1 font-bold">
        {icon}
        {name}
      </span>
    );
  }
  if (tileId === context.itemId) {
    return (
      <span className="inline-flex items-center gap-1 font-bold underline decoration-2 decoration-ink/30">
        {icon}
        {name}
      </span>
    );
  }
  return (
    <a
      href={`#${tileId}`}
      onClick={(event) => {
        event.preventDefault();
        context.onPick(tileId);
      }}
      className="inline-flex items-center gap-1 font-bold text-accent underline decoration-accent/40 hover:decoration-accent"
    >
      {icon}
      {name}
    </a>
  );
}

function formatChance(percent: number): string {
  if (percent >= 10) return `${Math.round(percent)}%`;
  return `${Math.round(percent * 10) / 10}%`;
}
