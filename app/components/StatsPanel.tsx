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
import type { Attributes } from "../game/attributes";
import type { Vitals } from "../game/GameSession";
// Aliased because `EffectRow` below already has a `seconds` of its own, which is
// a count and not a wording.
import { seconds as inSeconds } from "../lib/duration";
import { bandLabel, HEADINGS, termLabel, type TermKey } from "../lib/terms";
import type { TilesetDef } from "../lib/types";
import { healthBarColor, healthFraction } from "../render/healthBar";
import { secondsLeft } from "../game/statuses";
import { Tooltip } from "../ui";
import type { ActiveStatus } from "../lib/status";
import { compareStatuses, STATUS_ICON_SIZE_PX } from "./StatusStrip";
import { SpritePreview } from "./TilePreview";

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
 *
 * ## The heading stays and everything under it scrolls
 *
 * Four sections — health, effects, masteries, combat — and two of them grow: ten
 * masteries and a handful of statuses came to more than half a tall desktop
 * window, and the column this sits in gives its room up out of the list of what
 * is in reach. So the body is held to {@link STATS_BODY_MAX_HEIGHT} and scrolls,
 * and the ⭐ line stays put as the thing that says which panel you are looking
 * at. See {@link scrolls}, which is why the cap is not always on.
 */
export function StatsPanel({
  vitals,
  masteryXp,
  statuses = [],
  tilesets = [],
  scrolls = false,
  className = "",
}: {
  vitals: Vitals;
  masteryXp: MasteryXp;
  /** What is running on this body. See `./StatusStrip`, which draws the glance. */
  statuses?: ActiveStatus[];
  tilesets?: TilesetDef[];
  /**
   * Whether the body is capped at {@link STATS_BODY_MAX_HEIGHT} and scrolls
   * inside it.
   *
   * **On beside a mouse and off under a thumb**, rather than always. On a phone
   * the panels already sit in a column that scrolls as one — see
   * `./GameViewport` — and a second scroller inside the first is a trap for a
   * finger: a drag that starts on the stats catches the inner box, hits its end,
   * and the column behind it never moves. A desktop column has no such scroller
   * for this to fight with, and it is the one that runs out of height.
   *
   * Off by default, which is the reading a caller that has not thought about it
   * should get: an uncapped panel is the one that is always legible, merely
   * long.
   */
  scrolls?: boolean;
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
      {/* Outside the scroller, so the panel keeps a line saying what it is
          however far down the masteries you have read. */}
      <h2 className="flex items-baseline gap-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        {HEADINGS.stats}
        <span className="ml-auto tabular-nums text-paper/70">
          {RATING_GLYPH}
          {stars}
        </span>
      </h2>

      <div
        className={[
          "flex flex-col gap-1",
          // `contain` rather than `none`: reaching the end of this box should
          // hand the wheel to the column behind it, and only the page-level
          // bounce is worth refusing. The scrollbar is given width on purpose —
          // see `.scrolls-in-chrome` in `../app.css`.
          scrolls ? "scrolls-in-chrome overflow-y-auto overscroll-contain" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={scrolls ? { maxHeight: STATS_BODY_MAX_HEIGHT } : undefined}
      >
        <Health vitals={vitals} />

        <Effects statuses={statuses} tilesets={tilesets} />

        <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
          {HEADINGS.masteries}
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

        {/* Under the masteries rather than over them: what you have practised is
            what you are, and these are what it currently comes to with a weapon
            in your hand. */}
        <Combat attributes={vitals.attributes} />
      </div>
    </section>
  );
}

/**
 * The tallest the panel's body may get before it scrolls.
 *
 * **A fixed height rather than a share of the window, and small on purpose.**
 * It was two fifths of the viewport, which on a tall screen is most of the
 * column: the panel would take its share whether or not it had anything to put
 * there, and the list of what is in reach — the thing you actually act on —
 * gave up the room. What this panel is for is checking a number and going back
 * to the world, so it gets a fixed slice and everything past it is scrolled to
 * on purpose.
 *
 * Two hundred is about eight rows. Health and the first few masteries are in
 * view, which is the part somebody glances at; the rest, Combat included, is a
 * scroll away. That is the trade the number makes, and it is the one to revisit
 * if it turns out to be the wrong part of the panel to have free.
 *
 * Only ever applied on a device with a mouse — see {@link scrolls}, which is
 * where the reason lives.
 */
const STATS_BODY_MAX_HEIGHT = 200;

/**
 * The combat block: what this body hits for, how often, and what it turns aside.
 *
 * ## Two columns of short labels
 *
 * **Attack down the left, survival down the right**, which is what the ordering
 * below buys and the reason the grid is worth having over a list. Seven rows in
 * one column was the tallest thing in the panel for the least information in it:
 * the figures are two to six characters and the rest was whitespace. Paired up
 * they cost four rows, and the reader gets the two halves of a fight side by
 * side rather than having to hold one while scrolling to the other.
 *
 * ## The words are not this panel's to pick
 *
 * Every caption comes out of `../lib/terms`, which is also where the item card
 * gets the caption for the same measurement — so the sword in your hand and the
 * body holding it meet the reader with one word each. This panel used to say
 * "Atk Spd" where the card said `every`, and "Accuracy" where the card said
 * `hit`; the second of those was not even the same measurement, because
 * `accuracy` is a weapon's own field and this row is `hitChance`.
 *
 * This grid is also the narrowest surface a caption has to fit, so it is what
 * decides how long the words may be — about eight characters before a column
 * truncates one. That is an argument for a shorter word everywhere, never for a
 * short one here and a long one on the card.
 *
 * What the panel still owns is the *figure*, because that is where its fourteen
 * characters bite: `../game/attributes` shortens the reach to "2–8c" where a
 * card has room for "2–8 cells, fired". Units are on the figures rather than in
 * the captions — `c` is cells, `c/s` cells a second — so "Range 6c" and "Move
 * 5.0c/s" read against each other.
 *
 * ## Read, not explained
 *
 * Every row is a number that came out of a function — see `../game/attributes`,
 * which is called by the simulation and the browser alike, so the panel cannot
 * quote a figure a blow does not use. Nothing here describes a curve in words: a
 * sentence about a formula is a second copy of that formula which no test can
 * fail when the first one moves. That is `./ArenaFighterPanel`'s rule, and it
 * holds harder here, where the reader is a player rather than somebody tuning
 * the numbers.
 *
 * `haste`, `variance` and the weapon's mastery have no row. The first two are
 * not readings — they are terms inside two of the rows here — and the third is
 * said better by the masteries above, where the level you are earning with that
 * weapon already has a line.
 *
 * No section at all for a body with no stats, on {@link Effects}'s terms: the
 * health line already says this body has nothing to fight with.
 */
function Combat({ attributes }: { attributes: Attributes | null }) {
  if (!attributes) return null;

  const { minDamage, maxDamage, swingMs, hitChance, def, flee, reach, walkPace } =
    attributes;

  return (
    <>
      <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        {HEADINGS.combat}
      </h3>
      {/* Row-major, so the left column is items 1, 3, 5, 7 — see the ordering
          note above. The last cell is left empty rather than balanced, on the
          terms `./ArenaFighterPanel`'s three-column grid already sets. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] tabular-nums">
        {/* A band rather than a face value and a variance, because a range is
            one reading: what it takes to kill the thing in front of you is
            worked out from both ends at once. The item card reports a weapon's
            damage the same way and through the same wording — see
            `../lib/terms`'s `bandLabel`. */}
        <Reading term="damage" value={bandLabel(minDamage, maxDamage)} />
        <Reading term="defence" value={`${def}`} />
        <Reading term="swing" value={inSeconds(swingMs)} />
        {/* Not a percentage, and deliberately not dressed as one: it is one side
            of a contest against whatever is swinging at you, so there is no
            number of blows it corresponds to on its own. @see `../game/combat`'s
            `dodgeChance` */}
        <Reading term="evasion" value={`${flee}`} />
        <Reading term="hit" value={`${Math.round(hitChance * 100)}%`} />
        {/* A rate, unlike the swing above — see `../game/attributes`'s
            `walkPace` for why this one is not quoted as an interval. */}
        <Reading term="move" value={`${walkPace.toFixed(1)}c/s`} />
        <Reading term="range" value={reach} />
      </dl>
    </>
  );
}

/**
 * One reading: which measurement it is, and what it comes to.
 *
 * A `dt`/`dd` pair rather than two spans, because that is what the grid holds —
 * names and figures — and it is what lets a screen reader read each pair out
 * together instead of announcing seven labels and then seven numbers. The `div`
 * around them is what keeps a pair in one grid cell.
 *
 * The term rather than a caption, so a row here cannot be given a word the item
 * card does not use for the same thing. @see `../lib/terms`
 *
 * Sized by the grid rather than here, so the two columns cannot come to be set
 * in different type.
 */
function Reading({ term, value }: { term: TermKey; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="truncate text-paper/80">{termLabel(term)}</dt>
      <dd className="ml-auto shrink-0 text-paper">{value}</dd>
    </div>
  );
}

/**
 * What is running on this body.
 *
 * **One line each: icon, name, seconds.** It was three — a description under
 * every name — and five statuses of that pushed the masteries and the whole
 * equipment panel off the bottom of a short window. The list has to stay
 * scannable at the size a status count can actually reach, which means the
 * explanation cannot be in the row.
 *
 * So the description is a tooltip, on the row and on the strip's icons alike:
 * the name and the number are what you *read*, and what a status does is what
 * you go and *ask*. That also makes the two surfaces say the same thing in the
 * same way, rather than the panel being a wordier strip.
 *
 * No section at all when there is nothing, rather than an empty heading. The
 * masteries below print a sentence when empty because "nothing practised yet" is
 * itself something to act on; "no effects" is not.
 */
function Effects({
  statuses,
  tilesets,
}: {
  statuses: ActiveStatus[];
  tilesets: TilesetDef[];
}) {
  if (statuses.length === 0) return null;

  // The same comparator the strip sorts by, so the two can never disagree about
  // which status comes first — one rule, in one place.
  const ordered = [...statuses].sort(compareStatuses);

  return (
    <>
      <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wide text-paper/50">
        {HEADINGS.effects}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {ordered.map((status) => (
          <EffectRow key={status.defId} status={status} tilesets={tilesets} />
        ))}
      </ul>
    </>
  );
}

/**
 * One status: what it is, and how long is left.
 *
 * Red for a harmful one, and that is the same `tone` the strip sorts by rather
 * than a second judgement made here — so a status that survives an overflow
 * because it is bad is also the one printed in the colour that says so.
 */
function EffectRow({
  status,
  tilesets,
}: {
  status: ActiveStatus;
  tilesets: TilesetDef[];
}) {
  const seconds = secondsLeft(status.remainingMs);

  return (
    <Tooltip content={status.description} side="left">
      <li
        className="flex items-center gap-1.5 text-xs"
        // The row is what is hovered, so the whole line answers rather than a
        // 18px sprite the pointer has to be aimed at.
        aria-label={`${status.name}. ${status.description}. ${seconds} seconds left`}
      >
        <span
          className="grid shrink-0 place-items-center"
          style={{ width: STATUS_ICON_SIZE_PX, height: STATUS_ICON_SIZE_PX }}
        >
          <SpritePreview
            sprite={status.icon}
            tilesets={tilesets}
            size={STATUS_ICON_SIZE_PX}
          />
        </span>
        <span
          className={`truncate ${status.tone === "bad" ? "text-danger" : "text-paper/80"}`}
        >
          {status.name}
        </span>
        {/* Not live text, on exactly the terms `MasteryProgress` is: a reading
            that changed as text would have a screen reader narrate every second
            of an hour. The row's own label carries it instead. */}
        <span aria-hidden="true" className="ml-auto shrink-0 tabular-nums text-paper/70">
          {seconds}s
        </span>
      </li>
    </Tooltip>
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
        <span className="text-paper/80">{termLabel("health")}</span>
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
