import {
  levelForXp,
  MASTERIES,
  type Mastery,
  type MasteryXp,
  masteriesFromXp,
  masteryRatio,
} from "../lib/mastery";
import { resolveWeapon } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import type { TileDef } from "../lib/types";

/**
 * What the thing in your hand asks of you, and how far short you are.
 *
 * **What it asks, and never what it is worth.** This game is played by picking
 * things up and finding out — whether a weapon hits harder than your fists is a
 * thing to discover by swinging it, and a panel that answered in advance would
 * be answering the only question the fighting has to offer.
 *
 * A requirement is a different kind of fact. It is authored on the item, it is a
 * gate rather than a verdict, and without it the single most surprising rule in
 * the system — that the *worst* ratio decides — is invisible: a sword held back
 * by a Toughness requirement it never trains reads as a sword that is simply
 * broken. The tile editor cannot show this and never will, because an author
 * writes what a weapon asks and only a player has the other half of the
 * comparison.
 */
export function WeaponAsks({
  weapon,
  masteryXp,
  tilesById,
  className = "",
}: {
  /** What is in hand, or null. Nothing is drawn for bare hands. */
  weapon: ItemInstance | null;
  masteryXp: MasteryXp;
  tilesById: Record<string, TileDef>;
  className?: string;
}) {
  const def = weapon ? tilesById[weapon.tileId] : undefined;
  const resolved = def ? resolveWeapon(def) : null;
  const requirements = resolved?.requirements;
  if (!resolved || !requirements) return null;

  const asked = MASTERIES.map((mastery) => ({
    mastery,
    required: requirements[mastery] ?? 0,
    // Read out of the experience rather than passed in as levels, so this and
    // the mastery list can never disagree about what a player has.
    have: levelForXp(masteryXp[mastery] ?? 0),
  })).filter((row) => row.required > 0);

  // A weapon whose every requirement is zero asks nothing, which the schema
  // permits and the editor makes easy to author by accident.
  if (asked.length === 0) return null;

  const ratio = masteryRatio(masteriesFromXp(masteryXp), requirements);
  // Whichever is furthest behind, which is the one holding the rest back. Ties
  // go to the first, and it does not matter which: they are equally to blame.
  const worst = asked.reduce((a, b) =>
    a.have / a.required <= b.have / b.required ? a : b,
  );

  return (
    <section
      className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label={`What ${def?.name ?? "this weapon"} asks of you`}
    >
      <h2 className="text-[11px] font-bold uppercase tracking-wide text-paper/50">
        {def?.name ?? "In hand"} asks
      </h2>
      <ul className="flex flex-col gap-0.5">
        {asked.map((row) => (
          <Demand key={row.mastery} {...row} blame={row === worst && ratio < 1} />
        ))}
      </ul>
    </section>
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
