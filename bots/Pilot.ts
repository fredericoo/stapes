import type { ObjectRef } from "../app/game/affordances";
import type { ActorSnapshot } from "../app/game/GameSession";
import { opensToIntangible, type NavLeg } from "../app/game/navigation";
import { getStack } from "../app/lib/mapData";
import type { Coord, Direction, MapFile, TileDef } from "../app/lib/types";
import type { RemoteSession } from "../app/net/RemoteSession";

export type PilotBody = Pick<RemoteSession, "setInput" | "interact">;

export type PilotState = "underway" | "arrived" | "lost";

export const PRESS_RETRY_MS = 400;

/**
 * Follows a planned route by holding one direction at a time, as a player's
 * keys would. A step is chained by switching to the next leg's direction as
 * soon as the current walk is heading for the right cell, so the client's
 * prediction starts the next step the moment this one lands.
 */
export class Pilot {
  private next = 0;
  private lastPressMs = -Infinity;

  constructor(
    private readonly start: Coord,
    readonly legs: readonly NavLeg[],
    private readonly tilesById: Record<string, TileDef>,
  ) {}

  get remaining(): number {
    return this.legs.length - this.next;
  }

  drive(body: PilotBody, self: ActorSnapshot, map: MapFile, nowMs: number): PilotState {
    if (self.fall || self.slide) {
      body.setInput({ directions: [] });
      return "underway";
    }

    if (self.walk) {
      const leg = this.legs[this.next];
      if (leg?.kind === "walk" && !leg.drop && sameCell(self.walk.to, leg.to)) {
        this.next++;
        body.setInput({ directions: this.chainable() });
      }
      return "underway";
    }

    while (this.next < this.legs.length && sameCell(self, this.legs[this.next]!.to)) this.next++;
    if (this.next >= this.legs.length) {
      body.setInput({ directions: [] });
      return "arrived";
    }

    const leg = this.legs[this.next]!;
    const from = this.next === 0 ? this.start : this.legs[this.next - 1]!.to;
    if (!sameCell(self, from)) return "lost";

    if (leg.kind === "use") {
      body.setInput({ directions: [] });
      this.press(body, leg.ref, nowMs);
      return "underway";
    }
    if (leg.opens && this.closed(map, leg.opens)) {
      body.setInput({ directions: [] });
      this.press(body, leg.opens, nowMs);
      return "underway";
    }
    body.setInput({ directions: [leg.direction] });
    return "underway";
  }

  private chainable(): Direction[] {
    const leg = this.legs[this.next];
    if (leg?.kind !== "walk" || leg.opens) return [];
    return [leg.direction];
  }

  private closed(map: MapFile, ref: ObjectRef): boolean {
    const placed = getStack(map, ref.x, ref.y, ref.z)[ref.stackIndex];
    return placed !== undefined && opensToIntangible(placed, this.tilesById) !== null;
  }

  /**
   * `interact` refuses while a step is unconfirmed, so a press is retried
   * rather than sent once; the retry is spaced so a refusal for good reason
   * does not become a message every frame.
   */
  private press(body: PilotBody, ref: ObjectRef, nowMs: number) {
    if (nowMs - this.lastPressMs < PRESS_RETRY_MS) return;
    if (body.interact(ref)) this.lastPressMs = nowMs;
  }
}

function sameCell(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
