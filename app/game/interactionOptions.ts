import { getStack } from "../lib/mapData";
import type { InteractionKind } from "../lib/interactions";
import { resolveReward, resolveSwitch } from "../lib/interactions";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";
import { MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import {
  canOpenFrom,
  canPickUpFrom,
  canPushFrom,
  canRewardFrom,
  canSwitchFrom,
  INTERACT_LEVEL_SLACK,
  type ObjectRef,
} from "./affordances";
import { bodyNameFor } from "./displayName";
import type { Equipment } from "./equipment";
import type { ActorSnapshot, PlaySession } from "./GameSession";

/**
 * Everything the player could do right now, as a list rather than as something
 * to be found by pointing.
 *
 * The world already answers this question — the outline under the cursor is the
 * same answer — but only for one object at a time, and only once you have aimed
 * at it. A thumb has no hover to aim with, so on a phone the affordance was
 * invisible until it was already being used. Reading the same rules out into a
 * list makes what is reachable something you can *see* instead of something you
 * discover, which is as useful with a mouse as it is with a finger.
 *
 * Pure, and deliberately in the same place and on the same terms as
 * `./affordances`: it asks the identical questions the renderer's pick and the
 * server's validation ask, so the list can never offer something a tap would
 * refuse.
 *
 * **One entry per action, not per thing.** A body you can both shove and fight
 * is two entries with one name between them, which is the shape a player reads:
 * they are looking for the *verb*, and grouping buries it under a heading. It
 * also keeps every entry the same size, which is what lets the list be scanned
 * rather than parsed.
 */

/**
 * What an entry does. The push/switch pair plus the one thing a body offers.
 *
 * `target` and not `attack`: picking somebody out is its own act now, and
 * whether it turns into blows is attack mode's answer rather than this list's —
 * see {@link GameSnapshot.attacking}. The row is the same row either way, which
 * is the point: you choose who you are interested in once, and change your mind
 * about what to do with them without having to choose again.
 */
export type InteractionAction = InteractionKind | "target" | "open";

export type InteractionOption = {
  /** Identity across frames, so the list can be diffed rather than compared. */
  id: string;
  action: InteractionAction;
  /**
   * What to call it. "Push" and "Attack" belong to the interaction and are the
   * same everywhere; a switch is named by its author — see
   * {@link SwitchInteraction.actionName} — because only they know whether this
   * half of the door opens or shuts.
   */
  label: string;
  /** The placement to act on. `target` carries one too, for its sprite. */
  ref: ObjectRef;
  /** Who to point at, for `target`; null for anything the board offers. */
  actorId: string | null;
  /** The tile standing for this entry — its front sprite is what gets drawn. */
  tileId: string;
  /** A person by their handle, anything else by what its tile is called. */
  name: string;
  /**
   * How hurt the body this entry acts on is, or null where there is no body —
   * a crate has no health to report.
   *
   * Carried on the entry rather than looked up again by whoever draws it: the
   * list is the one place that already holds the actor, and a second lookup
   * from a component would be a second answer that can disagree with this one.
   *
   * The reading is the same reading the bar over the creature's head is drawn
   * from, which is the point of showing it here at all: a row that says only
   * *what* something is cannot answer "the rat I have nearly killed, or the one
   * that just walked in", and that is the question being asked of a list of
   * bodies you could pick a fight with.
   */
  health: { hp: number; maxHp: number } | null;
  /**
   * The state this row names is the one you are already in — the body you are
   * pointing at, or the box you have open. Rows for things that simply *happen*,
   * like a shove, are never active: there is no state to be in afterwards.
   */
  active: boolean;
};

const LABELS: Record<InteractionAction, string> = {
  target: "Target",
  open: "Open",
  pickUp: "Pick up",
  push: "Push",
  switch: "Switch",
  // What an unnamed reward reads as. "Take" rather than "Reward", because the
  // fallback has to name what the *player* does, and every other label here
  // does: the tile being a reward is the author's word for it, not theirs.
  reward: "Take",
};

/**
 * What the open row says once the box it names is open.
 *
 * The row is a toggle, so it is named for what pressing it would *do* rather
 * than for what the thing is — the same rule a switch follows, where the label
 * is the authored verb and not the tile. A row that went on saying "Open" beside
 * an open chest would be offering something already true.
 */
const CLOSE_LABEL = "Close";

/**
 * One entry as a sentence: the verb and what it is about.
 *
 * The list draws these on two lines because it has a column to fill; anything
 * with one line to say it in — the label under the pointer, a tooltip, anything
 * read aloud — says it this way. Written once so "Pick up Rusty Sword" cannot
 * come out as "Rusty Sword: pick up" somewhere else.
 */
export function interactionText(option: InteractionOption): string {
  return `${option.label} ${option.name}`;
}

/**
 * Which verb comes first where two entries are the same distance away.
 *
 * Stated rather than left to the id's alphabet. It used to be exactly that
 * accident — "attack" sorted before "push" — and renaming the verb to "target"
 * silently reversed it, which is the whole argument for writing the order down:
 * a body you can both point at and shove offers the fight first because that is
 * the decision with consequences, and nothing about the spelling should be able
 * to change that again.
 */
const ACTION_ORDER: Record<InteractionAction, number> = {
  target: 0,
  // Above everything the board offers, and above `open` in particular: a chest
  // authored as both a reward and a container is one you are meant to be *given*
  // the contents of, and rummaging in it is the lesser reading of the same tap.
  reward: 1,
  switch: 2,
  // Above open, and the two are almost never both on offer anyway — which is
  // what makes the order easy. A bag is only pick-up-able when your back is
  // bare, and a bare back is exactly when you want the bag rather than a look
  // inside it; the moment you are wearing one, pick-up stops being offered at
  // all and open is the only thing left. A chest is never picked up, so it opens
  // either way. The pair therefore reads: take it if you can, otherwise look in
  // it.
  pickUp: 3,
  open: 4,
  push: 5,
};

/**
 * The row a tap on this object runs — the first one the list offers for it.
 *
 * **The pointer and the list are the same list.** Whatever is under the cursor
 * is looked up here, and what comes back decides all three things at once: the
 * colour of the outline, the words in the label over it, and what happens if you
 * click. So a chest that reads "Open Chest" opens, and cannot quietly shove
 * instead — there is no second precedence anywhere to disagree with this one.
 *
 * "First" is {@link ACTION_ORDER}, which is the order the list itself sorts by
 * once distance has been settled — and distance is settled here by construction,
 * since every candidate is the same object.
 */
export function topInteractionAt(
  options: readonly InteractionOption[],
  ref: ObjectRef,
): InteractionOption | null {
  let best: InteractionOption | null = null;
  const key = refKey(ref);
  for (const option of options) {
    if (refKey(option.ref) !== key) continue;
    if (!best || ACTION_ORDER[option.action] < ACTION_ORDER[best.action]) {
      best = option;
    }
  }
  return best;
}

/**
 * How much a floor counts for when sorting by nearness.
 *
 * Big enough that anything on your own floor comes before anything that is not.
 * A body one storey up is drawn a couple of cells away and is nowhere near you,
 * and a list that interleaved the two by screen distance would put a creature
 * through a ceiling between you and the crate at your feet.
 */
const LEVEL_DISTANCE_WEIGHT = 100;

/**
 * Everything the viewer can act on, nearest first.
 *
 * Bounded by construction: four neighbouring cells across three floors for the
 * board's own affordances, plus whichever actors the caller has already decided
 * are on screen. Nothing here sweeps the map — the list is rebuilt whenever the
 * board or the player moves, which during a walk is every commit, and an O(map)
 * answer at that rate is the mistake this codebase keeps having to un-make.
 *
 * Motion is not consulted. An actor mid-step cannot act, but an entry that
 * disappeared for the 200ms of every stride would flicker its way through a
 * walk and be unhittable at the end of one; the session re-asks on the tap, so
 * the worst a stale entry can do is nothing at all.
 *
 * @param visibleActors actors the viewer can *see* — on a drawn floor and
 *   inside the view. Attacking is picking a target rather than swinging, so it
 *   is offered at any distance you can point at, and how far the view reaches
 *   is the renderer's question rather than this one's.
 */
export function listInteractionOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  visibleActors: readonly ActorSnapshot[],
  targetId: string | null,
  equipment: Equipment,
  openedRef: ObjectRef | null = null,
  tags: readonly string[] = [],
): InteractionOption[] {
  const bodies = bodiesByCell(self, visibleActors);

  return [
    ...targetOptions(tilesById, bodies, targetId),
    ...objectOptions(map, tilesById, self, bodies, equipment, openedRef, tags),
  ].sort(
    (a, b) =>
      distanceFrom(self, a.ref) - distanceFrom(self, b.ref) ||
      ACTION_ORDER[a.action] - ACTION_ORDER[b.action] ||
      // Whatever is left is settled by id, so two things equally far off never
      // trade places between frames.
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Run what an entry says it does.
 *
 * Here rather than in the component because it is the one place that knows an
 * entry is a session call, and both routes would otherwise write the same three
 * lines against sessions they hold differently. The list itself knows nothing
 * about pushing or fighting; it hands the option back and this decides.
 *
 * Tapping the one you are already pointing at drops it. That is the only way to
 * clear a target with a thumb — the keyboard has Escape and a touch screen has
 * nothing — and it is why the entry says which one is active at all.
 */
export function applyInteraction(
  session: PlaySession | null,
  option: InteractionOption,
) {
  if (!session) return;
  if (option.action === "target") {
    session.setTarget(option.active ? null : option.actorId);
    return;
  }
  // Named rather than left to `interact`'s precedence. The row says "Pick up",
  // and a row that ran whatever the tap would have chosen would be lying on any
  // tile that is both an item and something else.
  if (option.action === "pickUp") {
    session.pickUp(option.ref);
    return;
  }
  // `open` never reaches here — it is panel state, and the view intercepts it
  // before handing anything to the session. See `GameViewport`.
  if (option.action === "open") return;
  session.interact(option.ref);
}

/**
 * Where the top *thing* is in a stack, or -1 for a stack of nothing but bodies.
 *
 * The counterpart of `affordances`' own cover rule, and it has to agree with it:
 * a cell whose rows were built from a slot that module considers buried would
 * offer actions every one of which is refused, and a cell it can reach into but
 * this one never looks at would offer none at all.
 */
function topmostThingIn(stack: readonly PlacedTile[]): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i]?.owner) return i;
  }
  return -1;
}

function refKey(ref: ObjectRef): string {
  return `${ref.x},${ref.y},${ref.z},${ref.stackIndex}`;
}

/**
 * Who is standing where, so a shove and a swing at the same body agree on what
 * to call it.
 *
 * Without this the push entry for another player would be named after their
 * *tile* — "Player" — beside an attack entry naming the person in it. The body
 * is what answers the question, exactly as it does for a name tag and for
 * speech, so both entries ask it the same way.
 *
 * The viewer's own body is left out: they are neither somebody to fight nor,
 * standing on themselves, somebody to shove.
 */
function bodiesByCell(
  self: ActorSnapshot,
  visibleActors: readonly ActorSnapshot[],
): Map<string, ActorSnapshot> {
  const bodies = new Map<string, ActorSnapshot>();
  for (const actor of visibleActors) {
    if (actor.id === self.id) continue;
    bodies.set(refKey(actor), actor);
  }
  return bodies;
}

/**
 * What a body has left, or null for one that has none to lose.
 *
 * Both halves or neither: the snapshot promises `maxHp` is null exactly when
 * `hp` is, and reading them as a pair here means nothing downstream has to
 * carry a half-answer it cannot draw.
 */
function healthOf(actor: ActorSnapshot): { hp: number; maxHp: number } | null {
  if (actor.hp === null || actor.maxHp === null) return null;
  return { hp: actor.hp, maxHp: actor.maxHp };
}

/** Squared plan distance, with a whole floor counting for far more than a cell. */
function distanceFrom(self: ActorSnapshot, ref: ObjectRef): number {
  const dx = ref.x - self.x;
  const dy = ref.y - self.y;
  const dz = (ref.z - self.z) * LEVEL_DISTANCE_WEIGHT;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * One entry per reachable object, carrying what a tap would actually run.
 *
 * A tile can be authored with both a switch and a push, and `PlaySession.interact`
 * tries the switch first — so listing both would put an entry on screen that does
 * something other than what it says. The precedence is read here rather than
 * restated: whichever the tap would take is the one named.
 */
function objectOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  equipment: Equipment,
  openedRef: ObjectRef | null,
  tags: readonly string[],
): InteractionOption[] {
  const out: InteractionOption[] = [];
  const zMin = Math.max(MIN_LEVEL, self.z - INTERACT_LEVEL_SLACK);
  const zMax = Math.min(MAX_LEVEL, self.z + INTERACT_LEVEL_SLACK);

  // The 3×3 around the actor, their own cell included, because reaching for a
  // thing is round (see `REACH_CELLS`) where a shove is orthogonal. Still
  // bounded by construction — nine cells across three floors, and nothing here
  // ever sweeps the map.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const x = self.x + dx;
      const y = self.y + dy;

      for (let z = zMin; z <= zMax; z++) {
        for (const stackIndex of actionableSlotsIn(getStack(map, x, y, z))) {
          out.push(
            ...slotOptions(
              map,
              tilesById,
              self,
              bodies,
              equipment,
              { x, y, z, stackIndex },
              openedRef,
              tags,
            ),
          );
        }
      }
    }
  }

  return out;
}

/**
 * Which slots of one cell are worth asking about — at most two.
 *
 * The top of the stack, which is what a tap acts on, and *underneath a body*
 * the topmost thing that is not one. A body is not a lid: standing on a sword
 * does not bury it, and a chest with somebody on it is a chest you can still
 * open. The cell this matters most in is the actor's own, which the round reach
 * takes in on purpose and which their own body would otherwise cover
 * completely.
 *
 * Both, rather than one or the other, because a body can be a subject in its own
 * right — the `player` tile is shovable — so looking only underneath would take
 * away the shove, and looking only on top is the bug this fixes.
 *
 * Deliberately not the whole stack. Reaching under a body is reaching past
 * something soft; reaching under a crate is not, and a cell of four things does
 * not offer four rows.
 */
function actionableSlotsIn(stack: readonly PlacedTile[]): number[] {
  const top = stack.length - 1;
  if (top < 0) return [];
  if (!stack[top]?.owner) return [top];
  const covered = topmostThingIn(stack);
  return covered < 0 ? [top] : [top, covered];
}

/** Every row one slot of one cell offers. */
function slotOptions(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  bodies: Map<string, ActorSnapshot>,
  equipment: Equipment,
  ref: ObjectRef,
  openedRef: ObjectRef | null,
  tags: readonly string[],
): InteractionOption[] {
  const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
  if (!placed) return [];
  // Your own body is the one subject that is never worth a row: everything the
  // list offers is something to do to something *else*, and the tile a player
  // stands in happens to be shovable.
  if (placed.owner === self.id) return [];

  const body = bodies.get(refKey(ref));
  const name = body
    ? bodyNameFor({ actorId: body.id, tileId: body.tileId }, tilesById)
    : (tilesById[placed.tileId]?.name ?? placed.tileId);

  const out: InteractionOption[] = [];
  const add = (action: InteractionAction, label: string, active = false) => {
    out.push({
      id: `${action}:${refKey(ref)}`,
      action,
      label,
      ref,
      actorId: null,
      tileId: placed.tileId,
      name,
      // A shove at a creature reports its health for the same reason the fight
      // does: it is the same creature, and which of two identical rats this row
      // means is the question a bar answers. A crate has none.
      health: body ? healthOf(body) : null,
      active,
    });
  };

  // The one thing a tap would run, named by what it would actually be — the
  // precedence is read out of the session's own order rather than restated here.
  const action = objectAction(map, tilesById, self, ref, equipment, tags);
  if (action) add(action, objectActionLabel(action, tilesById[placed.tileId]));

  // And, beside it, opening — which is not something a tap runs at all. A bag on
  // the floor is therefore two rows, "Open" and "Pick up", which is the same
  // one-row-per-verb rule bodies already follow.
  //
  // One row for both halves of the toggle, lit and renamed while it is the box
  // you have open. A second "Close" row beside the first would be two entries
  // for one box, and the list's whole promise is that a row is a thing you can
  // do to a thing you can see.
  if (canOpenFrom(map, tilesById, self, ref)) {
    const isOpen = openedRef != null && refKey(openedRef) === refKey(ref);
    add("open", isOpen ? CLOSE_LABEL : LABELS.open, isOpen);
  }

  return out;
}

function objectAction(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  ref: ObjectRef,
  equipment: Equipment,
  tags: readonly string[],
): InteractionKind | null {
  if (canRewardFrom(map, tilesById, self, ref, equipment, tags)) return "reward";
  if (canSwitchFrom(map, tilesById, self, ref)) return "switch";
  if (canPickUpFrom(map, tilesById, self, ref, equipment)) return "pickUp";
  if (canPushFrom(map, tilesById, self, ref)) return "push";
  return null;
}

/**
 * The two actions whose verb is the author's rather than the mechanism's, and
 * they are the same case: a switch is "Open" or "Pull" because only the author
 * knows which half of the door this is, and a reward is "Open" or "Receive"
 * because only they know whether it is a box or a person.
 */
function objectActionLabel(
  action: InteractionKind,
  def: TileDef | undefined,
): string {
  if (!def) return LABELS[action];
  if (action === "switch") {
    return resolveSwitch(def)?.actionName?.trim() || LABELS.switch;
  }
  if (action === "reward") {
    return resolveReward(def)?.actionName?.trim() || LABELS.reward;
  }
  return LABELS[action];
}

/**
 * One entry per body the viewer can see, and whoever is already being pointed
 * at.
 *
 * **Range is deliberately not consulted.** Tapping a body does not swing at it —
 * it marks it as the target, and attack mode plus the session decide when and
 * whether a blow lands from there. So the question this answers is "who could I
 * single out", and the honest bound on that is what is on screen, not what is
 * already within arm's reach: choosing your target while walking towards it is
 * the normal way a fight starts, and an entry that only appeared once you were
 * beside them would arrive after the decision it exists for.
 *
 * A battler is anything with hit points, which the snapshot already says: `hp`
 * is null for a body that has none.
 */
function targetOptions(
  tilesById: Record<string, TileDef>,
  bodies: Map<string, ActorSnapshot>,
  targetId: string | null,
): InteractionOption[] {
  const out: InteractionOption[] = [];

  for (const actor of bodies.values()) {
    if (actor.hp === null) continue;

    const ref: ObjectRef = {
      x: actor.x,
      y: actor.y,
      z: actor.z,
      stackIndex: actor.stackIndex,
    };
    out.push({
      id: `target:${actor.id}`,
      action: "target",
      label: LABELS.target,
      ref,
      actorId: actor.id,
      tileId: actor.tileId,
      name: bodyNameFor(
        { actorId: actor.id, tileId: actor.tileId },
        tilesById,
      ),
      health: healthOf(actor),
      active: actor.id === targetId,
    });
  }

  return out;
}
