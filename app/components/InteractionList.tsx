import {
  IconApple,
  IconBoxSeam,
  IconDoorEnter,
  IconFlame,
  IconGift,
  IconHandGrab,
  IconHandMove,
  IconMessageCircle,
  IconPick,
  IconShirt,
  IconSwitch,
  IconTarget,
  IconTransform,
} from "@tabler/icons-react";
import { useMemo, useRef } from "react";
import type { ExtractCooling } from "../game/extract";
import type {
  InteractionAction,
  InteractionGroup,
  InteractionOption,
} from "../game/interactionOptions";
import {
  groupInteractionOptions,
  groupSubject,
  interactionText,
} from "../game/interactionOptions";
import type { TileDef, TilesetDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  HEALTH_BAR_FILL_STEPS,
  healthBarColor,
  healthBarFillBricks,
  healthFraction,
} from "../render/healthBar";
import { TilePreview } from "./TilePreview";
import { useTap } from "./useTap";

/**
 * Everything within reach, as a list you can act from.
 *
 * The world has always been able to answer "can I do something to that" — the
 * outline under the cursor is exactly that answer — but only one object at a
 * time and only once you have aimed at it. With a thumb there is no aiming
 * beforehand: you tap, and either something happens or you have just walked
 * somewhere. So the same answer is read out here instead, for every reachable
 * thing at once, which turns an affordance you had to go looking for into one
 * you can see. It earns its place on a desktop for the same reason a quest log
 * does — knowing what is *possible* is a different question from doing it.
 *
 * **One box per thing, one button per verb.** The box says which thing — its
 * sprite and its name, once — and inside it is a button for each of the things
 * you could do to it. A body you can both shove and fight used to be two full
 * rows, which drew the same rat twice and said its name twice in a column
 * barely wide enough to say it once; the verbs are still separate, because the
 * verb is what a player scans for, but they no longer each drag a sprite and a
 * name along behind them. See `groupInteractionOptions`, which decides what
 * counts as one thing.
 *
 * A box about a body carries its health under the name, on the same ramp the
 * bar over its head is drawn on. Two rats read as two identical boxes
 * otherwise, and the one thing you want to know before swinging is which of
 * them is the one you have nearly finished and which just walked into view.
 *
 * Rows carry the option and nothing else; {@link onAct} hands it back to
 * whoever owns the session. Nothing in here knows what a push is.
 */

/** Which sprite stands for a tile in a list — the one facing the reader. */
const FRONT: "s" = "s";

const ICONS: Record<InteractionAction, typeof IconTarget> = {
  target: IconTarget,
  // A speech bubble: the one row that opens a panel of words rather than
  // doing something to the board.
  talk: IconMessageCircle,
  open: IconBoxSeam,
  // A closing hand against push's sliding one: both are hands, and the
  // difference between taking a thing and shoving it is what the shape says.
  pickUp: IconHandGrab,
  // Deliberately not a hand, so it cannot be mistaken for the pick-up row
  // sitting directly under it: putting a thing on is about your body, and every
  // slot it can go in is somewhere you wear or carry it.
  equip: IconShirt,
  push: IconHandMove,
  switch: IconSwitch,
  // A doorway rather than a ladder or a swirl, because the row covers both and
  // the one thing every teleport has in common is that you end up through it.
  teleport: IconDoorEnter,
  // A flame, because the motivating case is one and because every other shape
  // that says "a condition" says it with an icon a status already owns. The row
  // covers a blessing too, and the authored verb beside it is what tells them
  // apart — the same trade the transmute row makes below.
  addStatus: IconFlame,
  // An apple for every consumable, drink included: the icon says "this gets
  // used up", and the authored verb beside it says how.
  consume: IconApple,
  // Being handed something, whoever is doing the handing. A gift rather than a
  // chest, because half of these are people.
  reward: IconGift,
  // One shape becoming another, which is the only thing every recipe shares:
  // the row could be cooking, trading or smelting, and the authored verb beside
  // it is what says which. Deliberately not a flame — that would name one of
  // them and mislead about the rest.
  transmute: IconTransform,
  // A pick, because a resource is a thing you *work* and every other shape that
  // says "you get something" — the gift, the grabbing hand — says it about
  // being handed one. It names mining and leaves picking a bush to the authored
  // verb beside it, on exactly the trade the transmute row above makes.
  extract: IconPick,
};

const SPRITE_SIZE_PX = 32;

export function InteractionList({
  options,
  tiles,
  tilesets,
  attacking = false,
  onAct,
  onHover,
  className = "",
}: {
  options: InteractionOption[];
  tiles: TileDef[];
  tilesets: TilesetDef[];
  /**
   * Whether a target is a fight, which is what colours the chosen row.
   *
   * The row wears whatever its subject is wearing out in the world — red in
   * attack mode, white otherwise — so the list and the canvas are never two
   * separate things to learn. It is the only thing in here that knows about
   * attack mode at all: what a row *does* is unchanged by it.
   */
  attacking?: boolean;
  onAct: (option: InteractionOption) => void;
  /**
   * The row being pointed at, so the world can outline what it is talking
   * about. By id rather than by option, because the thing moves and the
   * renderer has to resolve it against the list as it stands — see
   * `GameRenderer.setListHover`.
   *
   * Absent where there is no hover to have. Given by keyboard focus as well as
   * by the mouse: tabbing through the list and watching the world light up is
   * the same question being asked the same way.
   */
  onHover?: (optionId: string | null) => void;
  className?: string;
}) {
  const tilesById = useMemo(() => tilesByIdFromList(tiles), [tiles]);
  const groups = useMemo(() => groupInteractionOptions(options), [options]);

  return (
    <div
      className={[
        "flex flex-col gap-1 overflow-y-auto overscroll-contain",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      // Announced, because it changes without the player having touched it:
      // walking up to a crate is what puts the row there. Polite so it waits
      // for a gap rather than talking over a fight.
      role="log"
      aria-live="polite"
      aria-label="Within reach"
    >
      {options.length === 0 ? (
        // A word rather than an empty box. The list is always on screen — it
        // reserves its width so the game does not resize as you walk — and an
        // empty frame reads as something failing to load.
        <p className="px-1 py-2 text-xs text-paper/50">Nothing in reach.</p>
      ) : (
        groups.map((group) => (
          <InteractionBox
            key={group.key}
            group={group}
            tile={tilesById[groupSubject(group).tileId] ?? null}
            tilesets={tilesets}
            attacking={attacking}
            onAct={onAct}
            onHover={onHover}
          />
        ))
      )}
    </div>
  );
}

/**
 * What a lit row wears, and it is the colour its subject wears in the world.
 *
 * The vocabulary is four colours and each one means one thing: **yellow acts on
 * something, red fights it, white singles it out, blue looks at it.** A row and
 * the outline under the cursor are two ways of pointing at one thing, so the row
 * cannot invent a fifth or borrow one of the other four.
 *
 * Which is why an open box is not red. The red belongs to a *fight*, and it is
 * worn by a target once attack mode has turned pointing at somebody into
 * swinging at them; a chest you have open has nothing to do with that mode, and
 * a panel that went red the moment you drew your sword would be saying so.
 */
function litClass(option: InteractionOption, attacking: boolean): string {
  if (option.action === "open") {
    return "border-interact bg-interact/20 text-paper";
  }
  if (attacking) return "border-danger bg-danger/20 text-paper";
  return "border-paper bg-paper/15 text-paper";
}

/**
 * What a box wears, lit or not.
 *
 * Lit by whatever inside it you are in the middle of — the body you are
 * pointing at, the chest you have open — because that state belongs to the
 * *thing*, and the thing is what the box is. Only one verb in a box can ever be
 * a state you are in, so there is nothing to arbitrate.
 *
 * A reward is the one box that carries its colour without being lit, and it has
 * to: everything else here is a state you can be *in*, and lighting up is how
 * the list says which one you are in. "You can only do this once" is not a
 * state, it is a property of the offer, so it is on the box from the moment the
 * box exists. Which is also why it is a tint rather than the full lit
 * treatment: it must not read as the box being selected.
 */
function boxClass(
  group: InteractionGroup,
  active: InteractionOption | null,
  attacking: boolean,
): string {
  if (active) return litClass(active, attacking);
  if (group.options.some((option) => option.action === "reward")) {
    return "border-reward/60 bg-reward/10 text-paper hover:border-reward";
  }
  return "border-paper/40 bg-ink text-paper hover:border-paper";
}

/**
 * What a verb wears inside the box.
 *
 * Quieter than the box around it by a whole border width, and on purpose: the
 * box is what you find in a scan of the column, and the buttons are what you
 * read once you have found it. The one exception is the verb naming a state you
 * are in — "Close" on the chest that is open — which wears the same colour its
 * box does, so that pressing it again reads as the way out.
 *
 * A reward's verb carries the purple as text rather than as a fill: the box has
 * already said the offer is a one-off, and "Receive" in the same colour is what
 * says which of the verbs in it is the offer.
 */
function actionClass(option: InteractionOption, attacking: boolean): string {
  // Ahead of every other case, because it is the one that says the verb cannot
  // be run at all — a "Pick" that is also a reward is still a "Pick" you have
  // to wait for. Dashed and faint on exactly the terms a cooling spell is, and
  // for the same reason: the state has to survive being looked at on a bright
  // phone outdoors. No hover, because there is nothing to hover towards.
  if (option.cooldown) {
    return "border-dashed border-paper/25 text-paper/40";
  }
  if (option.active) return litClass(option, attacking);
  if (option.action === "reward") {
    return "border-reward/60 text-reward hover:border-reward hover:bg-reward/10";
  }
  return "border-paper/30 text-paper hover:border-paper hover:bg-paper/10";
}

/**
 * How much of a wait has already gone, in milliseconds.
 *
 * **The one number the bar is drawn from**, and it is a negative
 * `animation-delay` rather than a width: the fill is a keyframe over the whole
 * duration, so starting it this far in is what makes a row rebuilt mid-wait
 * pick the animation up where it already was instead of restarting it. See
 * `fill-wait` in `app.css`.
 *
 * Clamped at both ends rather than trusted, on `statusFraction`'s terms: the
 * remainder and the duration are two numbers off the wire that nothing forces
 * into a ratio, and either a positive delay or one past the duration would draw
 * a bar that is not in the button.
 *
 * Exported for the test rather than for a second caller — the arithmetic is
 * assertable and the rendering is not.
 */
export function waitElapsedMs(cooldown: ExtractCooling): number {
  const elapsed = cooldown.durationMs - cooldown.remainingMs;
  return Math.max(0, Math.min(cooldown.durationMs, elapsed));
}

/**
 * One thing and everything you could do to it.
 *
 * The box is not a button — the buttons are inside it. What is outside them is
 * the answer to "which one is this": the sprite, the name, and what is left of
 * the body if it has one, said once however many verbs are stacked underneath.
 * Pointing at any part of the box asks the world to outline the thing, because
 * every button in here is about the same thing and the box is what says so.
 *
 * The border carries the state of whatever inside it is in one — the body you
 * are pointing at, the box you have open — so the thing is lit rather than the
 * verb, which is how it is lit out in the world.
 */
function InteractionBox({
  group,
  tile,
  tilesets,
  attacking,
  onAct,
  onHover,
}: {
  group: InteractionGroup;
  tile: TileDef | null;
  tilesets: TilesetDef[];
  attacking: boolean;
  onAct: (option: InteractionOption) => void;
  onHover?: (optionId: string | null) => void;
}) {
  const subject = groupSubject(group);
  const active = group.options.find((option) => option.active) ?? null;

  return (
    <div
      onMouseEnter={() => onHover?.(subject.id)}
      onMouseLeave={() => onHover?.(null)}
      className={[
        "flex w-full shrink-0 items-start gap-2 border-2 p-1",
        boxClass(group, active, attacking),
      ].join(" ")}
    >
      <TilePreview
        tile={tile}
        tilesets={tilesets}
        size={SPRITE_SIZE_PX}
        direction={FRONT}
        still
        chrome={false}
        background={null}
        className="shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs text-paper/70">{subject.name}</span>
        {subject.health ? <RowHealth health={subject.health} /> : null}
        {/* Under the name and hard against it: the name is a heading for these
            and a gap would let it float between the box above and this one. */}
        <div className="mt-1 flex flex-col gap-px">
          {group.options.map((option) => (
            <ActionButton
              key={option.id}
              option={option}
              subjectId={subject.id}
              attacking={attacking}
              onAct={onAct}
              onHover={onHover}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The bar that fills as a row's wait runs out.
 *
 * White, faint, and driven entirely by CSS — see `fill-wait` in `app.css`. The
 * element is given the *whole* duration and a negative delay of however much
 * had already gone when it appeared, so the browser runs it on the compositor
 * and nothing here has to touch it again.
 *
 * **The delay is read once, when the bar appears, and never again.** That is
 * the whole reason this is a component rather than three lines inline. A row is
 * re-rendered for all sorts of reasons while a wait runs — anything that
 * changes the list around it — and `cooldown.remainingMs` is a live number, so
 * a delay recomputed on every render would re-seek a running animation over and
 * over and drive the fill far ahead of the wait it is drawing. It was doing
 * exactly that: an eight-second wait filled its bar in five.
 *
 * Reading it once is also *correct* rather than merely stable, because this
 * mounts exactly when the wait becomes visible to this client — its own start,
 * or a reconnect in the middle of one — and both are moments when the remainder
 * is right. The bar is unmounted when the wait ends, so the next one on the
 * same row starts a fresh instance and a fresh reading.
 */
function WaitFill({ cooldown }: { cooldown: ExtractCooling }) {
  const delayMs = useRef(waitElapsedMs(cooldown)).current;

  return (
    <span
      aria-hidden="true"
      className="fill-wait pointer-events-none absolute inset-0 bg-paper/20"
      style={{
        animationDuration: `${cooldown.durationMs}ms`,
        animationDelay: `-${delayMs}ms`,
      }}
    />
  );
}

/**
 * One verb, and pressing it is what runs it.
 *
 * Named for a screen reader with the thing it acts on — "Push Crate" and not
 * "Push" — because the name is now outside the button and a list of buttons
 * read aloud would otherwise be a list of bare verbs. The words on screen stay
 * the verb alone: the sprite two centimetres to the left has already said which
 * crate this is, and repeating it in every button is what the box exists to
 * stop.
 */
function ActionButton({
  option,
  subjectId,
  attacking,
  onAct,
  onHover,
}: {
  option: InteractionOption;
  /**
   * The entry the box as a whole stands for, which is what the world goes back
   * to outlining when the pointer leaves this button for the box around it. The
   * outline is the same either way — every verb in a box acts on one placement —
   * but its *colour* is the verb's, so a pointer sliding off "Push" and onto
   * nothing in particular must not leave the world claiming a shove.
   */
  subjectId: string;
  attacking: boolean;
  onAct: (option: InteractionOption) => void;
  onHover?: (optionId: string | null) => void;
}) {
  const Icon = ICONS[option.action];
  const waiting = option.cooldown;
  // Pointer-driven rather than click-driven: a button has to answer a thumb
  // that is already holding the d-pad, and a click never arrives while it is.
  // See `./useTap`.
  //
  // Refused here as well as in `applyInteraction`, in the session and on the
  // server — a spell button's discipline: a row that is visibly greyed must not
  // quietly send anyway, or the grey is a lie about what pressing it does.
  const tap = useTap(() => {
    if (!waiting) onAct(option);
  });

  return (
    <button
      type="button"
      {...tap}
      onMouseEnter={() => onHover?.(option.id)}
      onMouseLeave={() => onHover?.(subjectId)}
      onFocus={() => onHover?.(option.id)}
      onBlur={() => onHover?.(null)}
      // What it is, then why it cannot be used — the order a spell button says
      // it in, and for its reason: the verb is what identifies the row and the
      // rest is its state. Spelled out rather than left to the grey, which a
      // screen reader cannot see and a bar cannot say.
      aria-label={
        waiting
          ? `${interactionText(option)}, not ready yet`
          : interactionText(option)
      }
      // Not `disabled` and not out of the tab order, exactly as a cooling spell
      // is not: a row somebody is waiting on is the row they most want to read,
      // and one that vanished from the keyboard's reach whenever it went grey
      // would be unreachable at precisely the moment it is interesting.
      aria-disabled={waiting ? true : undefined}
      // Pointing at somebody and having a box open are states you are in, and
      // both buttons toggle out of them; a push happens and is over, and a
      // button that claimed otherwise would be announced as stuck on.
      aria-pressed={
        option.action === "target" || option.action === "open"
          ? option.active
          : undefined
      }
      className={[
        // Tall enough to hit with a thumb where there is a thumb, and no taller
        // than it needs to be where there is a cursor: the phone shows this
        // same list, and a verb that used to be a whole row with a sprite in it
        // must not become a line of text you have to aim at.
        // `relative` so the wait can be drawn behind the verb rather than
        // beside it; `overflow-hidden` so the fill is clipped by the border
        // rather than by the box two levels up.
        "relative overflow-hidden flex w-full min-h-6 items-center gap-1 border px-1 py-0.5 text-left pointer-coarse:min-h-9",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        actionClass(option, attacking),
      ].join(" ")}
    >
      {/* The wait, filling the row from the left as it runs out. Behind the
          verb rather than under it, because what it is counting down to is
          *that verb becoming pressable* — a separate track below would be a
          second thing to look at for one fact. Absent entirely when there is
          nothing to wait for, rather than drawn empty. */}
      {waiting ? <WaitFill cooldown={waiting} /> : null}
      <Icon
        size={14}
        stroke={2}
        aria-hidden="true"
        // Above the fill, which is absolutely positioned across the whole row.
        className="relative shrink-0"
      />
      {/* The type is on the span and not on the button, because `button { font:
          inherit }` in `app.css` is unlayered and beats a utility class: a size
          set on the button itself is silently the page's. Set small and tight,
          and in sentence case — the verbs are authored ("Climb", "Warm your
          hands"), a column this narrow truncates a long one, and capitals cost
          width to shout a heading the box above no longer needs shouted. */}
      <span className="relative truncate text-[11px] leading-snug font-medium tracking-tight">
        {option.label}
      </span>
    </button>
  );
}

/**
 * How much of a body is left, under the name of it.
 *
 * The reading and its colour come from `../render/healthBar`, which is the same
 * arithmetic the bar over the creature's head runs: a row that went red at a
 * different moment than the world did would be two gauges to learn instead of
 * one. The fill is stated in that module's steps and turned into a percentage
 * here — what the steps are buying is the rounding, not the pixels, which is why
 * this row keeps the default count while a bar in the world takes its own from
 * the width of a cell. A creature on its last hit point keeps a visible sliver,
 * and one that has taken a scratch never rounds back up to a full track.
 *
 * Named for a screen reader rather than left as decoration, because the bar is
 * the only place this number appears. It is a label rather than text on purpose:
 * the list around it is a live region, and a reading that changed as text would
 * have every blow in a fight read out over the fight.
 */
function RowHealth({ health }: { health: { hp: number; maxHp: number } }) {
  const fraction = healthFraction(health.hp, health.maxHp);

  return (
    <span
      role="img"
      aria-label={`${health.hp} of ${health.maxHp} health`}
      className="mt-1 flex h-1 w-full border border-paper/40 bg-ink"
    >
      <span
        style={{
          width: `${(healthBarFillBricks(fraction) / HEALTH_BAR_FILL_STEPS) * 100}%`,
          backgroundColor: healthBarColor(fraction),
        }}
      />
    </span>
  );
}
