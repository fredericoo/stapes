import type { HeldDirections } from "./heldDirections";
import { listStandingSurfaces, standingAbs } from "./movement";
import { noRouteNotice } from "./notices";
import { dropLanding, findPath, type PathOptions, type PathRefusal } from "./pathfinding";
import { absoluteStandingElevation, getStack } from "../lib/mapData";
import type { StatusDef } from "../lib/status";
import type { Coord, MapFile, TileDef } from "../lib/types";

export type WalkView = {
  map: MapFile;
  who: string;
  at: Coord & { stackIndex: number };
  stepping: Coord | null;
  def: TileDef;
  tilesById: Record<string, TileDef>;
  statusDefs: Record<string, StatusDef>;
  bodyAt: (actorId: string) => Coord | null;
};

type Errand =
  | { kind: "cell"; at: Coord; arrive: NonNullable<PathOptions["arrive"]> }
  | { kind: "body"; actorId: string };

export class WalkTo {
  private errand: Errand | null = null;
  private notices: string[] = [];
  private searchedFrom: Coord | null = null;
  private searchedGoal: Coord | null = null;
  private searchedMap: MapFile | null = null;
  private stalled = false;

  constructor(private readonly input: HeldDirections) {}

  get walking(): boolean {
    return this.errand !== null;
  }

  get followingId(): string | null {
    return this.errand?.kind === "body" ? this.errand.actorId : null;
  }

  start(on: Coord & { stackIndex: number }, view: WalkView) {
    const standing = standingCellOn(view, on);
    this.begin(
      standing
        ? { kind: "cell", at: standing, arrive: "on" }
        : { kind: "cell", at: { x: on.x, y: on.y, z: on.z }, arrive: "beside" },
      view,
    );
  }

  follow(actorId: string | null, view: WalkView) {
    if (actorId === null) {
      this.cancel();
      return;
    }
    this.begin({ kind: "body", actorId }, view);
  }

  private begin(errand: Errand, view: WalkView) {
    this.errand = errand;
    this.forget();
    const refused = this.route(view);
    if (refused) this.notices.push(noRouteNotice(refused));
  }

  private forget() {
    this.searchedFrom = null;
    this.searchedGoal = null;
    this.searchedMap = null;
    this.stalled = false;
  }

  cancel() {
    this.errand = null;
    this.forget();
    this.input.setAuto(null);
  }

  tick(view: WalkView) {
    const errand = this.errand;
    if (!errand) return;

    if (errand.kind === "body") {
      if (this.input.pressed) {
        this.input.setAuto(null);
        this.forget();
        return;
      }
      this.route(view);
      return;
    }

    if (!this.input.autoPressed) {
      this.cancel();
      return;
    }

    this.route(view);
  }

  private route(view: WalkView): PathRefusal | null {
    const errand = this.errand;
    if (!errand) return null;

    const goal = this.goalOf(errand, view);
    if (!goal) {
      this.cancel();
      return null;
    }

    const from = view.stepping ?? view.at;

    if (
      this.searchedFrom &&
      this.searchedGoal &&
      sameCell(from, this.searchedFrom) &&
      sameCell(goal, this.searchedGoal) &&
      (this.stalled || this.searchedMap === view.map)
    ) {
      return null;
    }
    this.searchedFrom = { x: from.x, y: from.y, z: from.z };
    this.searchedGoal = goal;
    this.searchedMap = view.map;

    const found = findPath(
      view.map,
      { at: from, self: view.at, who: view.who },
      goal,
      view.def,
      view.tilesById,
      view.statusDefs,
      {
        arrive: errand.kind === "body" ? "beside" : errand.arrive,
        drops: "toGoal",
      },
    );
    if (!found.ok) {
      this.stalled = true;
      if (errand.kind === "cell") this.cancel();
      else this.input.setAuto(null);
      return found.why;
    }
    this.stalled = false;

    const leg = found.route[0];
    if (!leg) {
      if (errand.kind === "cell") this.cancel();
      else this.input.setAuto(null);
      return null;
    }

    this.input.setAuto(leg.direction);
    return null;
  }

  private goalOf(errand: Errand, view: WalkView): Coord | null {
    return errand.kind === "cell" ? errand.at : view.bodyAt(errand.actorId);
  }

  drainNotices(): string[] {
    if (this.notices.length === 0) return [];
    const said = this.notices;
    this.notices = [];
    return said;
  }
}

export function standingCellOn(view: WalkView, on: Coord & { stackIndex: number }): Coord | null {
  /**
   * Empty at the walker's own level, not the picked tile's, is what marks a
   * hole: the pointer names whatever is visible at the bottom, which sits on
   * a level below the one the walker stands on.
   */
  if (getStack(view.map, on.x, on.y, view.at.z).length === 0) {
    return dropLanding(
      view.map,
      on.x,
      on.y,
      standingAbs(view.map, view.at.x, view.at.y, view.at.z, view.at.stackIndex, view.tilesById),
      view.def,
      view.tilesById,
    );
  }

  const stack = getStack(view.map, on.x, on.y, on.z);
  const top = absoluteStandingElevation(on.z, stack.slice(0, on.stackIndex + 1), view.tilesById);
  const surface = listStandingSurfaces(view.map, on.x, on.y, view.tilesById).find(
    (standing) => standing.abs === top,
  );
  return surface ? { x: on.x, y: on.y, z: surface.z } : null;
}

function sameCell(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
