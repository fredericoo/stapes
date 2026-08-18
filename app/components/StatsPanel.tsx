import {
  levelForXp,
  MASTERIES,
  type Mastery,
  type MasteryXp,
  masteriesFromXp,
  progressToNextLevel,
  RATING_GLYPH,
  rating,
} from "../lib/mastery";
import type { Vitals } from "../game/GameSession";
import { healthBarColor, healthFraction } from "../render/healthBar";

/**
 * What you are, in numbers: what you can take, and what you are good at.
 *
 * Its own panel rather than a tail on the equipment one, because the two answer
 * different questions and only one of them changes when you move an item. What
 * is in your hand is a decision you are making now; this is the record of every
 * fight you have had, and burying it under two slots made it read as a footnote
 * to a bag.
 *
 * Hit points are here and nowhere else in the chrome. The bar over your own head
 * says the same thing, but it is drawn in world space at the top of the screen
 * and says it in a colour rather than a number — and "am I going to survive the
 * next rat" is a question with an exact answer.
 */
export function StatsPanel({
  vitals,
  masteryXp,
  className = "",
}: {
  vitals: Vitals;
  masteryXp: MasteryXp;
  className?: string;
}) {
  const earned = MASTERIES.map((mastery) => ({
    mastery,
    level: levelForXp(masteryXp[mastery] ?? 0),
    progress: progressToNextLevel(masteryXp[mastery] ?? 0),
  }))
    .filter((row) => row.level > 0)
    // Best first, and ties broken by the fixed order the masteries are declared
    // in — otherwise two at the same level would swap places between renders for
    // no reason a player could see.
    .sort((a, b) => b.level - a.level);

  // Off the same experience the list is read from rather than off the body,
  // so the ⭐ in this panel and the levels under it can never disagree. The
  // body's own reading is the same number by a different route; see
  // `GameSession.ratingOf`.
  const stars = vitals.rating ?? rating(masteriesFromXp(masteryXp));

  return (
    <section
      className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}
      aria-label="Stats"
    >
      <h2 className="flex items-baseline gap-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        Stats
        <span className="ml-auto tabular-nums text-paper/70">
          {RATING_GLYPH}
          {stars}
        </span>
      </h2>

      <Health vitals={vitals} />

      <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        Masteries
      </h3>
      {earned.length === 0 ? (
        <p className="px-1 py-1 text-xs text-paper/50">
          Nothing practised yet. Hit something.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {earned.map(({ mastery, level, progress }) => (
            <li key={mastery} className="flex flex-col gap-0.5">
              <span className="flex items-baseline gap-1 text-xs">
                <span className="capitalize text-paper/80">{mastery}</span>
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
 * Hit points as a figure and as a bar, which are two readings of one number for
 * two different questions: the bar is "how much trouble am I in", the figure is
 * "can I take four more bites".
 *
 * The same colour ramp the bar over your head wears, so the panel and the world
 * cannot come to disagree about what "nearly dead" looks like.
 */
function Health({ vitals }: { vitals: Vitals }) {
  const { hp, maxHp } = vitals;
  if (hp === null || maxHp === null) {
    return <p className="px-1 text-xs text-paper/50">No hit points to speak of.</p>;
  }

  const fraction = healthFraction(hp, maxHp);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-baseline gap-1 text-xs">
        <span className="text-paper/80">Health</span>
        <span className="ml-auto tabular-nums text-paper">
          {hp}
          <span className="text-paper/40">/{maxHp}</span>
        </span>
      </span>
      <span
        role="img"
        aria-label={`${hp} of ${maxHp} health`}
        className="flex h-1.5 w-full border border-paper/40 bg-ink"
      >
        <span
          style={{
            width: `${fraction * 100}%`,
            backgroundColor: healthBarColor(fraction),
          }}
        />
      </span>
    </div>
  );
}

/**
 * How far into the next point, drawn the way a health bar is.
 *
 * A label rather than live text: this moves on every landed blow, and a reading
 * that changed as text would have a screen reader narrate every swing of every
 * fight.
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
