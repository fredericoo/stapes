import type { HeldDirections } from "./heldDirections";
import { listStandingSurfaces, standingAbs } from "./movement";
import { noRouteNotice } from "./notices";
import { dropLanding, findPath, type PathRefusal } from "./pathfinding";
import { absoluteStandingElevation, getStack } from "../lib/mapData";
import type { Coord, MapFile, TileDef } from "../lib/types";

/**
 * Walking to a cell somebody pointed at.
 *
 * The whole of click-to-walk that is not a pointer event or a socket: it holds a
 * destination, and once a frame it hands the step pipeline the single direction
 * that gets nearer to it. Nothing here knows about a canvas or a connection —
 * one callback in, one sentence out — which is what lets the same object steer a
 * predicted online body and a local simulation.
 *
 * ## It is the ordinary walk, one direction at a time
 *
 * There is no second way to move. The direction goes in where a held key's does
 * — `./heldDirections`, which is the one list every input device presses — so
 * every leg is chosen by `./stepping`'s `chooseStep`, drawn by the client's own
 * prediction and validated by the server with the same `canWalk` a keypress
 * goes through. A route this side got wrong is refused exactly as a mistimed
 * key is, and rolled back the same way. Nothing about clicking is
 * authoritative.
 *
 * Pressing through that list rather than writing the input directly is what
 * makes the two kinds of walking one control. It owns which of them is in force
 * — a key pressed during a clicked walk takes over, and the walk finds that out
 * by asking rather than by being told — and it is where the modifiers already
 * live, so a clicked leg is held straight or turned on the spot by whatever the
 * player's other hand is doing. @see HeldDirections.setAuto
 *
 * The direction for the leg *after* the one in flight is handed over while that
 * one is still being walked, which is not an optimisation but the thing that
 * keeps the cadence honest: the pipeline chains one step straight into the next
 * from inside its own frame, carrying the overshoot with it, and a controller
 * that waited for the walk to finish before naming the next direction would
 * spend a frame standing still at every cell — a click-walk that got slower as
 * the frame rate dropped, which is the exact fault the prediction's overshoot
 * accounting exists to avoid.
 *
 * ## A fall may be the last leg of a route, and nothing before it
 *
 * Clicking the floor of a pit walks to the floor of the pit — the route is
 * allowed to step off a ledge when the cell it lands in is the cell that was
 * clicked. Every other leg has to stay on the ground, so **a route never passes
 * through a fall on its way to somewhere else**: click across the balcony and
 * the walk goes round by the stairs, however much longer that is. @see
 * ./pathfinding's `PathOptions.drops`, which is where the rule is written.
 *
 * That limit will read as unfinished, and it is deliberate. A leg costs one
 * step whether it walks or falls, and nothing else — this game does not hurt
 * you for landing — so a search free to fall anywhere takes the drop the moment
 * it is the shorter line, and a click meant to cross a room throws the player
 * off the edge of it and leaves them to find the stairs back up. Nobody asked
 * for that, and it is a worse answer than the long walk it replaced.
 *
 * Lifting the limit is not a flag; it is deciding what a fall is worth. A drop
 * would have to cost the climb back out of it — which is a second search, or a
 * number somebody has justified — before the search can be trusted to weigh one
 * against walking round. Until somebody has done that, a fall that is not the
 * destination is not an edge.
 *
 * ## The route is recomputed every step, and never kept
 *
 * `docs/notes.md` makes this argument for a chase and it is *stronger* for a
 * person: a walk across town is twenty steps where a chase is three, so a kept
 * plan has twenty steps' worth of world to go stale in. Other bodies are walls
 * to `canWalk`, and the ones between here and a cell across the square are
 * exactly the ones that move — somebody walks into the doorway on step four, a
 * crate is shoved into step nine, a door shuts. Recomputing routes round all of
 * it without noticing; a kept route stops dead at a cell that was clear when it
 * was drawn.
 *
 * **Recomputed is not the same as re-asked every frame**, and the difference is
 * the whole cost of this. {@link tick} is driven from the render loop, so a
 * search on every call would be a dozen per leg walked — identical searches,
 * from one cell to one cell. It searches when the answer could have changed
 * instead: the body has somewhere new to think from, or the board is a
 * different object than the one last searched. @see searchedFrom, searchedMap
 *
 * **The board half of that is a weak guard, and the bound is a frame.** The map
 * is compared by identity and it gets a new one on any commit anywhere in the
 * world — a door on the far side of town, a creature stepping in a cave nobody
 * is looking at — so a busy world defeats it every frame and a still one never
 * does. What is actually bounded is one search per frame while a walk is under
 * way, each of them the cheap end of the two cases {@link findPath} is sized
 * for: a route somebody is walking settles in seven to twenty-five expanded
 * cells. The expensive case, proving a cell unreachable, happens once per click
 * and then the destination is dropped.
 *
 * **Recomputing can end a walk halfway, and that is the honest half of the
 * trade.** On a board nobody has touched it cannot: `PATH_DETOUR_SLACK` allows
 * the plan distance *plus* a constant, and walking a step of an optimal route
 * lowers the distance still owed by one while lowering the plan distance by at
 * most one, so the allowance never tightens below what it was at the click. But
 * a static board is exactly what the paragraph above says this is not. Shut the
 * door the route went through and the only way left may be longer than the
 * allowance, or gone; the walk then stops where it stands, on the same rule
 * that would have refused it at the click. It stops *silently* — see
 * {@link tick} — because the alternative is a sentence about a wolf that walked
 * in front of you.
 */

/** What steering a body needs to know about it and the board it is on. */
export type WalkView = {
  map: MapFile;
  /** Where the body stands, and which slot of that cell's stack it is. */
  at: Coord & { stackIndex: number };
  /** The cell a step already under way will land in, or null when standing still. */
  stepping: Coord | null;
  /** The walker's own tile, for the fit checks every leg goes through. */
  def: TileDef;
  tilesById: Record<string, TileDef>;
};

export class WalkTo {
  private destination: Coord | null = null;
  private notices: string[] = [];
  /**
   * The cell the last route was searched from, or null when none has been.
   *
   * {@link tick} is called once a *frame* and a step takes a fifth of a second,
   * so searching on every call is a dozen identical A* searches per leg walked
   * — same cell, same goal, same answer, and every expanded node of every one
   * of them a `canWalk` column scan per direction.
   *
   * Paired with {@link searchedMap}, and it takes both: this one alone would
   * leave a body that is standing still deaf to the board, pressing into a
   * crate somebody shoved in front of it until the click was called off.
   */
  private searchedFrom: Coord | null = null;
  /**
   * The board the last route was searched against, or null when none has been.
   *
   * Compared by identity, which is exact rather than approximate: the map is
   * copy-on-write and a mutation that changes nothing returns the same object —
   * see `docs/notes.md`, "A mutation that changes nothing must return the same
   * object". So a differing reference is the world having genuinely moved, and
   * the same reference is a frame in which nothing could have changed the
   * answer. It costs one comparison to ask.
   */
  private searchedMap: MapFile | null = null;

  /**
   * @param input where a direction goes, and what says whether it is still the
   *   one in force — the same list a held key presses, so that a click and a
   *   keypress produce one kind of step and cannot both be in force at once.
   */
  constructor(private readonly input: HeldDirections) {}

  /** Is a click still being walked out? */
  get walking(): boolean {
    return this.destination !== null;
  }

  /**
   * Set off for the cell that was pointed at, or say why not.
   *
   * The pick names a *tile*; what a body wants is the cell it would stand in
   * having climbed onto that tile, which is a different one whenever the thing
   * pointed at fills its level — see {@link standingCellOn}. Getting this wrong
   * shows as the floor of a building being unclickable, since the plank a player
   * points at belongs to the level below the one they would walk on.
   */
  start(on: Coord & { stackIndex: number }, view: WalkView) {
    const destination = standingCellOn(view, on);
    if (!destination) {
      // A wall, a tree or a body. There is nothing to search for, and the cell
      // pointed at really is one there is no way to stand in.
      this.cancel();
      this.notices.push(noRouteNotice("unreachable"));
      return;
    }
    this.destination = destination;
    // A new destination is a new question from wherever the body happens to be,
    // including the cell the last one was already answered from — so a click
    // that redirects a walk in progress re-routes on this frame rather than
    // walking one more step of the route it replaced. @see searchedFrom
    this.searchedFrom = null;
    this.searchedMap = null;
    // Straight away rather than on the next frame, for the reason a keypress
    // steps on the keystroke: the first 16ms of a click is free not to spend.
    //
    // This is the one moment a refusal is worth a sentence. The player has just
    // asked for something and nothing happened, and without a line the click
    // reads as having missed the canvas. @see ./notices
    const refused = this.route(view, destination);
    if (refused) this.notices.push(noRouteNotice(refused));
  }

  /**
   * Stop walking, and hand the input back.
   *
   * Handing it back is the load-bearing half. The pipeline chains a held
   * direction into the next step by itself, so a controller that simply stopped
   * having opinions would leave the last leg's direction pressed and the body
   * walking east for ever.
   *
   * Safe to call with no walk under way, which is what lets a keypress and a
   * teardown both call it without asking first: `setAuto(null)` says only that
   * *this* is asking for nothing, and the keys somebody is holding are in the
   * list underneath and untouched. @see HeldDirections.setAuto
   */
  cancel() {
    this.destination = null;
    // Dropped with the destination they were about. A second click from the
    // cell the first one was refused in is a new question, and a stale note
    // that this cell has already been searched would swallow it.
    // @see searchedFrom
    this.searchedFrom = null;
    this.searchedMap = null;
    this.input.setAuto(null);
  }

  /**
   * Hand over the next direction, having asked the board again.
   *
   * Called once a frame, from wherever a snapshot is already being taken.
   *
   * **A refusal here is silent**, unlike the one at the click. The player is
   * already walking and can see themselves stop, and what stops them mid-route
   * is ordinary traffic — somebody stepping into the doorway, a shoved crate,
   * a door swinging shut. A sentence for each of those is a line of text every
   * time the world moves while anybody is walking anywhere.
   */
  tick(view: WalkView) {
    const destination = this.destination;
    if (!destination) return;

    // Somebody has taken the input: a direction pressed by hand, or a window
    // that went away. Both are decisions this has no business arguing with, and
    // the walk they interrupted is over. @see HeldDirections.autoPressed
    if (!this.input.autoPressed) {
      this.cancel();
      return;
    }

    this.route(view, destination);
  }

  /**
   * Ask the board and press the next leg. Reports why not, when there is no
   * route — the caller decides whether that is worth saying out loud.
   */
  private route(view: WalkView, destination: Coord): PathRefusal | null {
    // The cell the body will be standing in when it next has a choice to make.
    const from = view.stepping ?? view.at;
    if (sameCell(from, destination)) {
      this.cancel();
      return null;
    }

    // Nothing has happened that could change the answer: the body is still
    // walking out of the leg chosen from this cell, on a board nobody has
    // touched since, and the direction for it is still pressed.
    // @see searchedFrom, searchedMap
    if (
      this.searchedFrom &&
      sameCell(from, this.searchedFrom) &&
      this.searchedMap === view.map
    ) {
      return null;
    }
    this.searchedFrom = { x: from.x, y: from.y, z: from.z };
    this.searchedMap = view.map;

    const found = findPath(
      view.map,
      // Two different cells while a step is in flight: the walk commits to the
      // map on landing, so the body is still placed in the cell it is leaving
      // while the next leg is owed from the one it is landing in. Told only
      // one of them, the search has the walker's own body as a wall behind it.
      // @see ./pathfinding's PathStart
      { at: from, self: view.at },
      destination,
      view.def,
      view.tilesById,
      {
        // The cell itself, not a neighbour of it: a patch of floor is not
        // something you stop next to. @see ./pathfinding
        arrive: "on",
        // A fall is allowed to be the last leg and nothing else, so clicking
        // down a hole walks to the bottom of it while a walk across a balcony
        // never steps off one. @see PathOptions.drops
        drops: "toGoal",
      },
    );
    if (!found.ok) {
      this.cancel();
      return found.why;
    }

    const leg = found.route[0];
    if (!leg) {
      // An empty route is a body that has arrived, which the cell check above
      // has already answered — so this is unreachable rather than a case, and
      // stopping is the answer that stays true if it ever is not.
      this.cancel();
      return null;
    }

    this.input.setAuto(leg.direction);
    return null;
  }

  /**
   * Everything there was to say since the last frame, taken away as it is read.
   *
   * The shape `PlaySession.drainNotices` has, because it is drained beside it
   * and by the same loop. This is the one sentence in the game composed on the
   * client, and it is allowed to be: what it reports is a search this side ran,
   * about a click the server was never told about. @see ./notices
   */
  drainNotices(): string[] {
    if (this.notices.length === 0) return [];
    const said = this.notices;
    this.notices = [];
    return said;
  }
}

/**
 * The cell a body would occupy standing on the tile that was picked, or null
 * when nothing stands on it.
 *
 * A pick answers with a slot in a stack, and a slot is not a place to be: a
 * tile that fills its level — the block a floor is made of, the ground a
 * building sits on — is stored on the level *below* the one a body standing on
 * it is stored on. Walking to the picked tile's own `z` would then be a request
 * to stand inside it, which is refused, and clicking the floor of a room would
 * report no way there while the player was looking straight at it.
 *
 * Matching on the elevation rather than reading a level off the tile's height is
 * what keeps this one rule: `listStandingSurfaces` already owns where a body may
 * stand in a column, and asking it which of those surfaces is the top of the
 * picked tile answers the question without a second opinion about floors.
 *
 * Null for a wall, a tree or a body, none of which has a top anybody stands on.
 * Their columns are usually walkable somewhere lower, and deliberately not
 * offered: pointing at a wall is not asking to stand at its foot.
 *
 * ## A hole is the one column read as a place rather than as a tile
 *
 * All of the above asks what the *picked tile* holds up, which is the right
 * question everywhere a body could already be standing. It is the wrong one
 * looking down a hole, where the pointer names whatever is visible at the
 * bottom and a body would never come to rest on it. The tutorial's first hole
 * is exactly that: nothing at the walker's level, a `half-wall` on the level
 * below, and bare ground a level below *that*. The pick names the half-wall,
 * nothing stands on a half-wall, and the click was refused about a hole the
 * player was standing at the mouth of — while the route, one step north and a
 * fall, had been available the whole time.
 *
 * So a column with nothing at all at the walker's own level is read as a hole,
 * and the answer is where a body entering it comes to rest. That question
 * belongs to `./pathfinding`'s {@link dropLanding} and is asked rather than
 * re-derived, because a click that aimed anywhere else would be a route to a
 * cell the search will not put the body in. It also reaches past what the
 * *pointer* can: `PICK_LEVEL_SLACK` lets a pick name one level down, and this
 * hole is two.
 *
 * Narrow deliberately. Nothing at the walker's level is what makes a column a
 * hole rather than a thing with a wall on it, so the rule above still stands
 * everywhere else and pointing at the foot of a wall is still not a request to
 * stand there.
 */
export function standingCellOn(
  view: WalkView,
  on: Coord & { stackIndex: number },
): Coord | null {
  if (getStack(view.map, on.x, on.y, view.at.z).length === 0) {
    return dropLanding(
      view.map,
      on.x,
      on.y,
      standingAbs(
        view.map,
        view.at.x,
        view.at.y,
        view.at.z,
        view.at.stackIndex,
        view.tilesById,
      ),
      view.def,
      view.tilesById,
    );
  }

  const stack = getStack(view.map, on.x, on.y, on.z);
  const top = absoluteStandingElevation(
    on.z,
    stack.slice(0, on.stackIndex + 1),
    view.tilesById,
  );
  const surface = listStandingSurfaces(
    view.map,
    on.x,
    on.y,
    view.tilesById,
  ).find((standing) => standing.abs === top);
  return surface ? { x: on.x, y: on.y, z: surface.z } : null;
}

function sameCell(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
