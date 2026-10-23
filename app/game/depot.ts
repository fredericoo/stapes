import * as v from "valibot";
import { resolveDepot, type PlacedDepot } from "../lib/interactions";
import { resolveContainer, resolveItem } from "../lib/item";
import { mintItemId, type ItemInstance } from "../lib/itemInstance";
import { getStack } from "../lib/mapData";
import { stow } from "../lib/piles";
import type { MapFile, TileDef } from "../lib/types";
import { coveredBySomething, withinReach, type Actor, type ObjectRef } from "./affordances";
import { stoneLocked, type Equipment } from "./equipment";
import {
  applyItemMove,
  clearSlot,
  itemInSlot,
  placeInSlot,
  slotAccepts,
  type ItemMoveResult,
  type SlotRef,
} from "./itemMoves";

/** One player's stashes, by depot tag. */
export type Depots = Readonly<Record<string, readonly ItemInstance[]>>;

export const NO_DEPOTS: Depots = {};

const NOTHING_STASHED: readonly ItemInstance[] = [];

type DepotSlotRef = Extract<SlotRef, { kind: "depot" }>;

export function depotAt(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  ref: ObjectRef,
): PlacedDepot | null {
  if (!withinReach(map, tilesById, actor, ref)) return null;
  const stack = getStack(map, ref.x, ref.y, ref.z);
  if (coveredBySomething(stack, ref.stackIndex, tilesById)) return null;
  const placed = stack[ref.stackIndex];
  return placed ? resolveDepot(placed, tilesById[placed.tileId]) : null;
}

export function stashIn(depots: Depots, tag: string): readonly ItemInstance[] {
  return depots[tag] ?? NOTHING_STASHED;
}

export type DepotMoveResult = ItemMoveResult & { depots: Depots };

export function applyDepotMove(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  depots: Depots,
  from: SlotRef,
  to: SlotRef,
): DepotMoveResult | null {
  if (from.kind === "depot" && to.kind === "depot") return null;
  if (from.kind === "depot") return withdraw(map, tilesById, actor, equipment, depots, from, to);
  if (to.kind === "depot") return deposit(map, tilesById, actor, equipment, depots, from, to);
  const moved = applyItemMove(map, tilesById, actor, equipment, from, to);
  return moved && { ...moved, depots };
}

function withdraw(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  depots: Depots,
  from: DepotSlotRef,
  to: SlotRef,
): DepotMoveResult | null {
  const depot = depotAt(map, tilesById, actor, from.ref);
  if (!depot) return null;
  const stash = stashIn(depots, depot.tag);
  const instance = stash[from.index];
  if (!instance) return null;

  const placed = placeInSlot(map, tilesById, actor, equipment, to, instance);
  if (!placed) return null;
  const left = stash.filter((_, i) => i !== from.index);
  return { ...placed, depots: { ...depots, [depot.tag]: left } };
}

function deposit(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  actor: Actor,
  equipment: Equipment,
  depots: Depots,
  from: SlotRef,
  to: DepotSlotRef,
): DepotMoveResult | null {
  const depot = depotAt(map, tilesById, actor, to.ref);
  if (!depot) return null;
  const instance = itemInSlot(map, tilesById, actor, equipment, from);
  if (!instance?.id) return null;
  if (stoneLocked(instance, tilesById)) return null;
  if (!slotAccepts("depot", instance, tilesById)) return null;

  const stashed = stow(stashIn(depots, depot.tag), instance, depot.size, tilesById);
  if (!stashed) return null;
  const emptied = clearSlot(map, tilesById, actor, equipment, from);
  if (!emptied) return null;
  return { ...emptied, depots: { ...depots, [depot.tag]: stashed } };
}

const savedDepotsSchema = v.record(
  v.string(),
  v.array(v.looseObject({ id: v.optional(v.string()), tileId: v.string() })),
);

/**
 * Drops what the catalogue no longer has as a storable item instead of the
 * whole stash. A tag no placement uses any more is kept, so a depot taken out
 * of the map and put back opens to what was left in it.
 */
export function restoredDepots(saved: unknown, tilesById: Record<string, TileDef>): Depots {
  const parsed = v.safeParse(savedDepotsSchema, saved);
  if (!parsed.success) return NO_DEPOTS;
  const out: Record<string, ItemInstance[]> = {};
  for (const [tag, stash] of Object.entries(parsed.output)) {
    const kept = (stash as ItemInstance[]).filter((instance) => {
      const def = tilesById[instance.tileId];
      return def != null && resolveItem(def) != null && !resolveContainer(def);
    });
    if (kept.length > 0) {
      out[tag] = kept.map((one) => (one.id ? one : { ...one, id: mintItemId() }));
    }
  }
  return out;
}

/**
 * Depot contents by owner, and the owner each seated actor opens them as.
 * An owner is an account, so two of its characters online at once share one
 * stash. The ledger outlives a `GameSession`, so replacing the world under
 * the players keeps what they stashed. An actor never seated is its own owner,
 * which is what a single-player session wants.
 */
export class DepotLedger {
  private readonly ownerOfActor = new Map<string, string>();
  private readonly byOwner = new Map<string, Depots>();
  private readonly unsavedOwners = new Set<string>();
  private readonly changedActors = new Set<string>();
  private readonly vacatedOwners = new Set<string>();

  holds(owner: string): boolean {
    return this.byOwner.has(owner);
  }

  seat(actorId: string, owner: string, stored: Depots = NO_DEPOTS) {
    this.ownerOfActor.set(actorId, owner);
    if (!this.byOwner.has(owner)) this.byOwner.set(owner, stored);
  }

  unseat(actorId: string) {
    const owner = this.ownerOfActor.get(actorId);
    if (owner === undefined) return;
    this.ownerOfActor.delete(actorId);
    this.vacatedOwners.add(owner);
    this.releaseVacated();
  }

  of(actorId: string): Depots {
    return this.byOwner.get(this.ownerOf(actorId)) ?? NO_DEPOTS;
  }

  write(actorId: string, depots: Depots) {
    const owner = this.ownerOf(actorId);
    this.byOwner.set(owner, depots);
    this.unsavedOwners.add(owner);
    this.changedActors.add(actorId);
    for (const other of this.actorsOf(owner)) this.changedActors.add(other);
  }

  drainChangedActors(): string[] {
    if (this.changedActors.size === 0) return [];
    const changed = [...this.changedActors];
    this.changedActors.clear();
    return changed;
  }

  /**
   * Only owners whose every seated actor is in `saving`, so a stash is written
   * in the same commit as the kits it was moved to or from. Writing it alone
   * would leave a crash window where an item is in both, or in neither.
   */
  drainUnsaved(saving: ReadonlySet<string>): Array<[owner: string, depots: Depots]> {
    if (this.unsavedOwners.size === 0) return [];
    const out: Array<[string, Depots]> = [];
    for (const owner of this.unsavedOwners) {
      if (!this.actorsOf(owner).every((actorId) => saving.has(actorId))) continue;
      this.unsavedOwners.delete(owner);
      out.push([owner, this.byOwner.get(owner) ?? NO_DEPOTS]);
    }
    this.releaseVacated();
    return out;
  }

  private actorsOf(owner: string): string[] {
    const out: string[] = [];
    for (const [actorId, of] of this.ownerOfActor) if (of === owner) out.push(actorId);
    return out;
  }

  private ownerOf(actorId: string): string {
    return this.ownerOfActor.get(actorId) ?? actorId;
  }

  /**
   * An owner is kept until saved: dropping one with a write still pending
   * would let the next seat load the stash from before it.
   */
  private releaseVacated() {
    for (const owner of this.vacatedOwners) {
      if (this.unsavedOwners.has(owner)) continue;
      this.vacatedOwners.delete(owner);
      if (this.actorsOf(owner).length === 0) this.byOwner.delete(owner);
    }
  }
}
