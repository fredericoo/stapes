import { resolveBattler } from "../lib/battler";
import { PLAYER_TILE_ID } from "../game/constants";
import {
  type Equipment,
  effectiveBattler,
  weaponInHand,
  worseThanBareHands,
} from "../game/equipment";
import { attackIntervalMs } from "../game/combat";
import {
  levelForXp,
  MASTERIES,
  type Mastery,
  type MasteryXp,
  masteriesFromXp,
  masteryRatio,
} from "../lib/mastery";
import type { TileDef } from "../lib/types";

/**
 * What you are actually fighting with, and what it asks of you.
 *
 * **A held weapon replaces your hands rather than adding to them**, which is the
 * rule the whole natural-weapon design rests on — and it has a sharp edge nobody
 * could see. A lantern equipped for light is a weapon: damage 1 at accuracy 45
 * and a swing every 95 ticks, against bare hands at 4 and 82 and 41. A player who
 * picked one up to see in the dark was fighting at a quarter of their own fists
 * with nothing on screen saying so, and read it as the game being broken.
 *
 * So this says the numbers out loud. Always, including for bare hands: a readout
 * that appeared only when something was wrong would make its own absence the
 * message, which is a thing you can only read if you already know the rule.
 *
 * ## Why the arithmetic happens here
 *
 * These are the *same functions* the simulation runs — `weaponInHand` and
 * `effectiveBattler`, out of `../game/equipment` — given the same three inputs,
 * all of which the client already holds. That is deliberately not a second
 * source of truth: a second *implementation* would be, and this is a second call
 * site of the one implementation. Sending the numbers instead would mean a
 * message per equip and per landed blow for three figures a panel can derive.
 *
 * The player's body is the `player` tile by construction — `spawnActor` places
 * that and nothing else, which is the same hardcoded exception `bodyNameFor`
 * already leans on.
 */
export function WeaponDemands({
  equipment,
  masteryXp,
  tilesById,
  className = "",
}: {
  equipment: Equipment;
  masteryXp: MasteryXp;
  tilesById: Record<string, TileDef>;
  className?: string;
}) {
  const body = resolveBattler(tilesById[PLAYER_TILE_ID] ?? ({} as TileDef));
  if (!body) return null;

  const masteries = masteriesFromXp(masteryXp);
  const wielder = { ...body, masteries };
  const weapon = weaponInHand(wielder, equipment, tilesById);
  const stats = effectiveBattler(wielder, equipment, tilesById);

  const held = equipment.weapon;
  const name = held ? (tilesById[held.tileId]?.name ?? "In hand") : "Bare hands";

  const asked = MASTERIES.map((mastery) => ({
    mastery,
    required: weapon.requirements?.[mastery] ?? 0,
    have: levelForXp(masteryXp[mastery] ?? 0),
  })).filter((row) => row.required > 0);

  const ratio = masteryRatio(masteries, weapon.requirements);
  // Whichever is furthest behind, which is the one holding the rest back. Ties
  // go to the first, and it does not matter which: they are equally to blame.
  const worst = asked.length
    ? asked.reduce((a, b) => (a.have / a.required <= b.have / b.required ? a : b))
    : null;

  // **The comparison that matters**, and the only one a player can act on: a
  // thing in your hand that is worse than the hand is a thing to put down. In
  // `../game/equipment` rather than here, because it is a fact about the fight.
  const worseThanBare = worseThanBareHands(wielder, equipment, tilesById);

  return (
    <section
      className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label="What you are fighting with"
    >
      <h2 className="flex items-baseline gap-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        Fighting with
        <span className="ml-auto truncate normal-case text-paper/70">{name}</span>
      </h2>

      <ul className="flex flex-col gap-0.5">
        <Figure label="Damage" value={String(stats.damage)} />
        <Figure
          label="Swing"
          value={`${(attackIntervalMs(stats.spd) / 1000).toFixed(1)}s`}
        />
        <Figure label="Accuracy" value={`${Math.round(stats.hitChance * 100)}%`} />
      </ul>

      {worseThanBare ? (
        <p className="text-[11px] text-danger">
          Worse than your bare hands. Put it in your bag.
        </p>
      ) : null}

      {asked.length > 0 ? (
        <>
          <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
            Asks
          </h3>
          <ul className="flex flex-col gap-0.5">
            {asked.map((row) => (
              <Demand
                key={row.mastery}
                {...row}
                blame={row === worst && ratio < 1}
              />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-baseline gap-1 text-xs">
      <span className="text-paper/80">{label}</span>
      <span className="ml-auto tabular-nums text-paper">{value}</span>
    </li>
  );
}

function Demand({
  mastery,
  required,
  have,
  blame,
}: {
  mastery: Mastery;
  required: number;
  have: number;
  /**
   * Whether this is the requirement deciding the whole ratio.
   *
   * Only marked while the weapon is actually held back — once every requirement
   * is met there is nothing to blame, and a permanent red row on a weapon that
   * works properly would read as a fault.
   */
  blame: boolean;
}) {
  const met = have >= required;

  return (
    <li className="flex items-baseline gap-1 text-xs">
      <span className={["capitalize", met ? "text-paper/80" : "text-danger"].join(" ")}>
        {mastery}
      </span>
      {blame ? (
        <span className="text-[10px] uppercase tracking-wide text-danger/80">
          holding it back
        </span>
      ) : null}
      <span className="ml-auto tabular-nums text-paper/50">
        <span className={met ? "text-paper" : "text-danger"}>{have}</span>
        <span aria-hidden> / </span>
        <span className="sr-only"> of </span>
        {required}
      </span>
    </li>
  );
}
