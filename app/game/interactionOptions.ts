import { getStack } from "../lib/mapData";
import type { InteractionKind } from "../lib/interactions";
import { resolveSwitch } from "../lib/interactions";
import type { MapFile, TileDef } from "../lib/types";
import { DIRECTIONS, MAX_LEVEL, MIN_LEVEL } from "../lib/types";
import {
  canPushFrom,
  canSwitchFrom,
  INTERACT_LEVEL_SLACK,
  type ObjectRef,
} from "./affordances";
import { bodyNameFor } from "./displayName";
import type { ActorSnapshot, PlaySession } from "./GameSession";
import { DIR_DELTA } from "./movement";

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
export type InteractionAction = InteractionKind | "target";

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
  /** Already the one being pointed at. Only ever true of a `target`. */
  active: boolean;
};

const LABELS: Record<InteractionAction, string> = {
  target: "Target",
  push: "Push",
  switch: "Switch",
};

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
  switch: 1,
  push: 2,
};

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
): InteractionOption[] {
  const bodies = bodiesByCell(self, visibleActors);

  return [
    ...targetOptions(tilesById, bodies, targetId),
    ...objectOptions(map, tilesById, self, bodies),
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
  session.interact(option.ref);
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
): InteractionOption[] {
  const out: InteractionOption[] = [];
  const zMin = Math.max(MIN_LEVEL, self.z - INTERACT_LEVEL_SLACK);
  const zMax = Math.min(MAX_LEVEL, self.z + INTERACT_LEVEL_SLACK);

  for (const direction of DIRECTIONS) {
    const { dx, dy } = DIR_DELTA[direction];
    const x = self.x + dx;
    const y = self.y + dy;

    for (let z = zMin; z <= zMax; z++) {
      const stack = getStack(map, x, y, z);
      // Only the top of a stack can be acted on, exactly as the pick has it.
      const stackIndex = stack.length - 1;
      const placed = stack[stackIndex];
      if (!placed) continue;

      const ref: ObjectRef = { x, y, z, stackIndex };
      const action = objectAction(map, tilesById, self, ref);
      if (!action) continue;

      const body = bodies.get(refKey(ref));
      out.push({
        id: `${action}:${refKey(ref)}`,
        action,
        label: objectActionLabel(action, tilesById[placed.tileId]),
        ref,
        actorId: null,
        tileId: placed.tileId,
        name: body
          ? bodyNameFor({ actorId: body.id, tileId: body.tileId }, tilesById)
          : (tilesById[placed.tileId]?.name ?? placed.tileId),
        // A shove at a creature reports its health for the same reason the
        // fight does: it is the same creature, and which of two identical rats
        // this row means is the question a bar answers. A crate has none.
        health: body ? healthOf(body) : null,
        active: false,
      });
    }
  }

  return out;
}

function objectAction(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  self: ActorSnapshot,
  ref: ObjectRef,
): InteractionKind | null {
  if (canSwitchFrom(map, tilesById, self, ref)) return "switch";
  if (canPushFrom(map, tilesById, self, ref)) return "push";
  return null;
}

function objectActionLabel(
  action: InteractionKind,
  def: TileDef | undefined,
): string {
  if (action !== "switch" || !def) return LABELS[action];
  return resolveSwitch(def)?.actionName?.trim() || LABELS.switch;
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
