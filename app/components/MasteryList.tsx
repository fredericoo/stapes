import {
  levelForXp,
  MASTERIES,
  type Mastery,
  type MasteryXp,
  progressToNextLevel,
  rating,
} from "../lib/mastery";

/**
 * What you are good at.
 *
 * **Only the masteries above zero, best first.** A body that has never held a
 * bow has no opinion about Ranged, and a row reading "Ranged 0" would claim the
 * opposite — that it is a thing you have and are bad at. The sparseness of the
 * underlying block is the same statement, and this is it drawn.
 *
 * The bar under each level is the part-way-there, which is why the raw
 * experience is what travels rather than the levels: a bar that could only move
 * when the level did would sit still through a dozen fights and then jump, and
 * "nothing is happening" is exactly the wrong thing to say to somebody who has
 * just spent ten minutes fighting rats.
 */

/** What each mastery is for, in the fewest words that distinguish it. */
const WHAT_IT_IS: Record<Mastery, string> = {
  fist: "Bare hands",
  blade: "Swords and knives",
  blunt: "Clubs and axes",
  ranged: "Bows and thrown things",
  arcane: "Staves and magic",
  toughness: "Hit points",
  agility: "Getting out of the way",
};

export function MasteryList({
  masteryXp,
  className = "",
}: {
  masteryXp: MasteryXp;
  className?: string;
}) {
  const earned = MASTERIES.map((mastery) => ({
    mastery,
    level: levelForXp(masteryXp[mastery] ?? 0),
    progress: progressToNextLevel(masteryXp[mastery] ?? 0),
  }))
    .filter((row) => row.level > 0)
    // Best first, and the tie broken by the fixed order the masteries are
    // declared in — otherwise two masteries at the same level would swap places
    // between renders for no reason a player could see.
    .sort((a, b) => b.level - a.level);

  return (
    <section
      className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label="Masteries"
    >
      <h2 className="flex items-baseline gap-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        Masteries
        {/* The same ⭐ drawn over a creature's head, so "how good am I" and "how
            hard is that" are one scale read in two places. */}
        <span className="ml-auto tabular-nums text-paper/40">
          ⭐{rating(Object.fromEntries(earned.map((r) => [r.mastery, r.level])))}
        </span>
      </h2>

      {earned.length === 0 ? (
        <p className="px-1 py-2 text-xs text-paper/50">
          Nothing practised yet. Hit something.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {earned.map(({ mastery, level, progress }) => (
            <li key={mastery} className="flex flex-col gap-0.5">
              <span className="flex items-baseline gap-1 text-xs">
                <span className="capitalize text-paper/80">{mastery}</span>
                <span className="truncate text-[10px] text-paper/35">
                  {WHAT_IT_IS[mastery]}
                </span>
                <span className="ml-auto tabular-nums text-paper">{level}</span>
              </span>
              <MasteryProgress mastery={mastery} level={level} progress={progress} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * How far into the next point, drawn the way a health bar is.
 *
 * A label rather than live text, on exactly the terms `RowHealth` is: this moves
 * on every landed blow, and a reading that changed as text would have a screen
 * reader narrate every swing of every fight.
 */
function MasteryProgress({
  mastery,
  level,
  progress,
}: {
  mastery: Mastery;
  level: number;
  progress: number;
}) {
  return (
    <span
      role="img"
      aria-label={`${mastery} ${level}, ${Math.round(progress * 100)}% towards the next`}
      className="flex h-1 w-full border border-paper/25 bg-ink"
    >
      <span
        className="bg-paper/60"
        style={{ width: `${Math.round(progress * 100)}%` }}
      />
    </span>
  );
}
