import type { ItemInstance } from "../lib/itemInstance";
import { resolveWeapon } from "../lib/item";
import {
  levelForXp,
  MASTERIES,
  type Mastery,
  type MasteryXp,
  masteriesFromXp,
  masteryRatio,
  MAX_MASTERY_RATIO,
} from "../lib/mastery";
import type { TileDef } from "../lib/types";

/**
 * What the thing in your hand asks of you, and how far short you are.
 *
 * **The tile editor cannot show this and never will**, which is the whole reason
 * it exists here: an author writes what a weapon asks, and only a player has the
 * other half of the comparison. A requirement on its own is a number; a
 * requirement beside your own level is a decision about whether to draw the
 * thing.
 *
 * Every requirement listed one by one, and the worst of them called out, because
 * **the worst ratio decides** and that is the single most surprising rule in the
 * system. A sword held back by a Toughness requirement it does not even train
 * reads, without this, as a sword that is simply broken.
 */

/** What the ratio buys, in the words the design argues it in. */
function verdict(ratio: number): string {
  if (ratio >= MAX_MASTERY_RATIO) return "As well as this can be swung.";
  if (ratio >= 1) return "Swung properly.";
  if (ratio >= 0.75) return "Nearly under control.";
  if (ratio >= 0.4) return "Wild. Half of it goes nowhere.";
  return "Far too much weapon. It barely lands.";
}

export function WeaponDemands({
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
    // the list above it can never disagree about what a player has.
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
      <p
        className={[
          "text-[11px]",
          ratio < 1 ? "text-danger" : "text-paper/60",
        ].join(" ")}
      >
        {verdict(ratio)}
      </p>
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
   * Only ever marked while the weapon is actually being held back — once every
   * requirement is met there is nothing to blame, and a permanent red row on a
   * weapon that works properly would read as a fault.
   */
  blame: boolean;
}) {
  const met = have >= required;

  return (
    <li className="flex items-baseline gap-1 text-xs">
      <span
        className={["capitalize", met ? "text-paper/80" : "text-danger"].join(
          " ",
        )}
      >
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
