import { IconArrowLeft } from "@tabler/icons-react";
import { type ReactNode, useMemo } from "react";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/player";
import { AdminShell } from "../../components/AppShell";
import { ItemCard } from "../../components/ItemCard";
import { AccountName, Badge, LastOnline, Moment } from "../../components/PlayerFacts";
import { TilePreview } from "../../components/TilePreview";
import { describeBlame } from "../../game/blame";
import { COMMAND_PREFIX, GOTO_COMMAND } from "../../game/commands";
import type { DeathCost } from "../../game/deathCost";
import { EQUIPMENT_SLOTS, type Equipment } from "../../game/equipment";
import { itemCard } from "../../game/itemCard";
import { fetchBootstrap, fetchPlayer } from "../../lib/api";
import { requireAdmin } from "../../lib/auth";
import { engravedName } from "../../lib/engraving";
import type { ItemInstance } from "../../lib/itemInstance";
import {
  levelForXp,
  MASTERIES,
  MASTERY_LABELS,
  type MasteryXp,
  progressToNextLevel,
  RATING_GLYPH,
} from "../../lib/mastery";
import { pileTally } from "../../lib/piles";
import { type StatusDef, statusesById } from "../../lib/status";
import type { TileDef, TilesetDef } from "../../lib/types";
import { tilesByIdFromList } from "../../lib/validation";
import { Tooltip } from "../../ui/Tooltip";
import type { DeathRecord } from "../../../server/deaths";
import type { CharacterSheet } from "../../../server/GameServer";

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  await requireAdmin();
  const [found, bootstrap] = await Promise.all([fetchPlayer(params.characterId), fetchBootstrap()]);
  return { ...found, ...bootstrap, loadedAt: Date.now() };
}

const SLOT_LABELS: Record<keyof Equipment, string> = {
  weapon: "Main hand",
  offhand: "Off hand",
  armor: "Armour",
  head: "Head",
  charm: "Charm",
  footwear: "Feet",
  bag: "Bag",
};

const ITEM_SPRITE_PX = 32;

type Catalogue = {
  tilesById: Record<string, TileDef>;
  tilesets: TilesetDef[];
  statusDefs: Record<string, StatusDef>;
  masteryXp: MasteryXp;
};

export default function PlayerPage() {
  const { player, sheet, deaths, kills, tiles, tilesets, statuses, loadedAt } =
    useLoaderData<typeof clientLoader>();
  const catalogue = useMemo<Catalogue>(
    () => ({
      tilesById: tilesByIdFromList(tiles),
      tilesets,
      statusDefs: statusesById(statuses),
      masteryXp: sheet.masteryXp,
    }),
    [tiles, tilesets, statuses, sheet.masteryXp],
  );
  const character = player.character!;

  return (
    <AdminShell>
      <div className="flex max-w-5xl flex-col gap-3 p-3">
        <Link
          to="/admin/players"
          className="inline-flex items-center gap-1 self-start text-xs text-muted hover:text-ink"
        >
          <IconArrowLeft size={12} aria-hidden="true" />
          Players
        </Link>

        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-lg font-bold">{character.name}</h1>
          {player.rating === null ? null : (
            <span className="tabular-nums text-sm">
              {player.rating}
              {RATING_GLYPH}
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1.5">
            {sheet.dead ? <Badge>Dead</Badge> : null}
            {sheet.pvp ? <Badge>PvP</Badge> : null}
            {sheet.hidden ? <Badge>Hidden</Badge> : null}
          </span>
        </header>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <Fact label="Account">
            <AccountName entry={player} />
          </Fact>
          <Fact label="Last online">
            <LastOnline entry={player} now={loadedAt} />
          </Fact>
          <Fact label="Created">
            <Moment at={character.createdAt} now={loadedAt} />
          </Fact>
          <Fact label="Position">
            <Place at={sheet.position} />
          </Fact>
          <Fact label="Respawns at">
            <Place at={sheet.spawn} />
          </Fact>
          <Fact label="Health">
            {sheet.hp === null ? "Full" : <span className="tabular-nums">{sheet.hp} HP</span>}
          </Fact>
        </dl>

        {sheet.live ? null : (
          <p className="text-xs text-muted">
            Not in the world. This is what was saved when {character.name} last left it.
          </p>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <Panel title="Equipment">
            <Equipped sheet={sheet} catalogue={catalogue} />
          </Panel>
          <Panel title="Masteries">
            <Masteries masteryXp={sheet.masteryXp} />
          </Panel>
          <Panel title="Effects">
            <Effects sheet={sheet} statusDefs={catalogue.statusDefs} />
          </Panel>
          <Panel title="Tags">
            {sheet.tags.length === 0 ? (
              <Empty>No tags.</Empty>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {sheet.tags.map((tag) => (
                  <li key={tag}>
                    <code className="border border-border/30 px-1 text-xs">{tag}</code>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={titled("Deaths", player.deaths)}>
            {deaths.length === 0 ? (
              <Empty>{character.name} has not died.</Empty>
            ) : (
              <DeathList>
                {deaths.map((death) => (
                  <DeathEntry
                    key={death.id}
                    record={death}
                    now={loadedAt}
                    title={<Cause death={death} />}
                    detail={death.cost ? costText(death.cost) : null}
                  />
                ))}
              </DeathList>
            )}
          </Panel>
          <Panel title={titled("Kills", player.kills)}>
            {kills.length === 0 ? (
              <Empty>{character.name} has not killed another character.</Empty>
            ) : (
              <DeathList>
                {kills.map((kill) => (
                  <DeathEntry
                    key={kill.id}
                    record={kill}
                    now={loadedAt}
                    title={<Victim kill={kill} />}
                    detail={kill.cause ? `With ${kill.cause.source}` : null}
                  />
                ))}
              </DeathList>
            )}
          </Panel>
        </div>
      </div>
    </AdminShell>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Place({ at }: { at: { x: number; y: number; z: number } | null }) {
  if (!at) return <span className="text-muted">Unknown</span>;
  return (
    <code className="select-all">{`${COMMAND_PREFIX}${GOTO_COMMAND} ${at.x} ${at.y} ${at.z}`}</code>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-2 border-border bg-paper p-3 shadow-hard">
      <h2 className="text-xs font-bold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

function Equipped({ sheet, catalogue }: { sheet: CharacterSheet; catalogue: Catalogue }) {
  const equipment = sheet.equipment;
  if (!equipment) return <Empty>Nothing saved.</Empty>;
  return (
    <ul className="flex flex-col gap-1">
      {EQUIPMENT_SLOTS.map((slot) => (
        <li key={slot} className="grid grid-cols-[6rem_1fr] items-start gap-2">
          <span className="pt-2 text-xs text-muted">{SLOT_LABELS[slot]}</span>
          {equipment[slot] ? (
            <Item instance={equipment[slot]} catalogue={catalogue} />
          ) : (
            <span className="pt-2 text-sm text-muted">Empty</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Item({ instance, catalogue }: { instance: ItemInstance; catalogue: Catalogue }) {
  const tile = catalogue.tilesById[instance.tileId];
  const card = tile ? itemCard(tile, instance, catalogue.masteryXp, catalogue.statusDefs) : null;
  const name = engravedName(tile?.name ?? instance.tileId, instance.engraved);
  const tally = pileTally(instance);

  const row = (
    <span className="flex items-center gap-2">
      <span
        className="grid shrink-0 place-items-center border border-border/20 bg-panel"
        style={{ width: ITEM_SPRITE_PX + 4, height: ITEM_SPRITE_PX + 4 }}
      >
        {tile ? (
          <TilePreview
            tile={tile}
            tilesets={catalogue.tilesets}
            size={ITEM_SPRITE_PX}
            direction="s"
            still
            chrome={false}
            background={null}
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm">
          {name}
          {tally ? <span className="ml-1 tabular-nums text-muted">{tally}</span> : null}
        </span>
        {instance.inscription ? (
          <span className="truncate text-xs text-muted">“{instance.inscription}”</span>
        ) : null}
        {tile ? null : <span className="text-xs text-danger">Not in the tile catalogue</span>}
      </span>
    </span>
  );

  const contents = instance.contents ?? [];

  return (
    <div className="flex flex-col gap-1">
      {card && tile ? (
        <Tooltip
          content={<ItemCard card={card} tile={tile} tilesets={catalogue.tilesets} />}
          side="right"
        >
          <button type="button" className="self-start text-left">
            {row}
          </button>
        </Tooltip>
      ) : (
        row
      )}
      {contents.length > 0 ? (
        <ul className="ml-4 flex flex-col gap-1 border-l-2 border-border/20 pl-3">
          {contents.map((inner) => (
            <li key={inner.id}>
              <Item instance={inner} catalogue={catalogue} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Masteries({ masteryXp }: { masteryXp: MasteryXp }) {
  const rows = MASTERIES.map((mastery) => {
    const xp = masteryXp[mastery] ?? 0;
    return { mastery, xp, level: levelForXp(xp), progress: progressToNextLevel(xp) };
  }).sort((a, b) => b.level - a.level || b.xp - a.xp);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted">
          <th scope="col" className="pb-1 font-normal">
            Mastery
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            Level
          </th>
          <th scope="col" className="pb-1 pl-3 font-normal">
            To next
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            XP
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ mastery, xp, level, progress }) => (
          <tr key={mastery} className={level === 0 ? "text-muted" : ""}>
            <td className="py-0.5">{MASTERY_LABELS[mastery]}</td>
            <td className="py-0.5 text-right tabular-nums">{level}</td>
            <td className="py-0.5 pl-3">
              <span
                role="img"
                aria-label={`${Math.round(progress * 100)}% towards level ${level + 1}`}
                className="flex h-1.5 w-full min-w-16 border border-border/40 bg-panel"
              >
                <span className="bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
              </span>
            </td>
            <td className="py-0.5 text-right tabular-nums">{Math.floor(xp).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Effects({
  sheet,
  statusDefs,
}: {
  sheet: CharacterSheet;
  statusDefs: Record<string, StatusDef>;
}) {
  if (sheet.statuses.length === 0) return <Empty>No effects.</Empty>;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {sheet.statuses.map((status) => (
        <li key={status.defId} className="flex items-baseline gap-2">
          <span>{statusDefs[status.defId]?.name ?? status.defId}</span>
          <span className="ml-auto tabular-nums text-muted">
            {Math.ceil(status.remainingMs / 1000)}s left
          </span>
        </li>
      ))}
    </ul>
  );
}

function titled(title: string, count: number): string {
  return count > 0 ? `${title} · ${count}` : title;
}

function DeathList({ children }: { children: ReactNode }) {
  return <ol className="flex flex-col divide-y divide-border/20">{children}</ol>;
}

function DeathEntry({
  record,
  now,
  title,
  detail,
}: {
  record: DeathRecord;
  now: number;
  title: ReactNode;
  detail: string | null;
}) {
  return (
    <li className="flex flex-col gap-0.5 py-1.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm">{title}</span>
        <span className="text-xs text-muted">
          <Moment at={record.at} now={now} />
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 text-xs text-muted">
        {detail ? <span>{detail}</span> : null}
        {record.where ? <Place at={record.where} /> : null}
      </div>
    </li>
  );
}

function Cause({ death }: { death: DeathRecord }) {
  const { cause, killer } = death;
  if (!cause) return <span className="text-muted">No cause recorded</span>;
  if (!cause.by || !killer?.character) return <>{describeBlame(cause)}</>;
  return (
    <>
      {cause.source} by <CharacterLink id={killer.id}>{cause.by}</CharacterLink>
    </>
  );
}

function Victim({ kill }: { kill: DeathRecord }) {
  const name = kill.victim.name ?? "Somebody unnamed";
  if (!kill.victim.character) return <>{name}</>;
  return <CharacterLink id={kill.victim.id}>{name}</CharacterLink>;
}

function CharacterLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Link
      to={`/admin/players/${id}`}
      className="underline decoration-ink/30 underline-offset-2 hover:decoration-ink"
    >
      {children}
    </Link>
  );
}

function costText(cost: DeathCost): string {
  const parts = cost.levelsLost.map(
    (level) => `${MASTERY_LABELS[level.mastery]} ${level.from} → ${level.to}`,
  );
  if (cost.packLeft) parts.unshift("Pack left behind");
  return parts.length > 0 ? parts.join(" · ") : "Lost nothing";
}
