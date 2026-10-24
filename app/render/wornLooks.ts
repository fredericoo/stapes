import type { ActorSnapshot } from "../game/GameSession";
import { isBare, outfitKey, type Outfit } from "../lib/humanSprite";
import { getStack, setStacks, type StackEdit } from "../lib/mapData";
import type { MapFile, PlacedTile, TileDef } from "../lib/types";

export type WornView = { map: MapFile; tilesById: Record<string, TileDef> };

/**
 * Draws each human actor in what they have equipped. In the drawn map only,
 * the actor's placement becomes a copy of its tile whose outfit carries the
 * worn parts over its own, and the copy joins the drawn catalogue, so the
 * renderers compose it like any other human tile. The rules, picking and the
 * interaction panel keep reading the real snapshot and the real tile.
 */
export class WornLooks {
  private base: Record<string, TileDef> | null = null;
  private readonly dressed = new Map<string, TileDef>();
  private catalogue: Record<string, TileDef> | null = null;
  private drawn: { map: MapFile; key: string; out: MapFile } | null = null;

  apply(
    map: MapFile,
    actors: readonly ActorSnapshot[],
    tilesById: Record<string, TileDef>,
  ): WornView {
    if (this.base !== tilesById) this.reset(tilesById);

    const stacks = new Map<string, StackEdit>();
    const keys: string[] = [];
    for (const actor of actors) {
      const id = this.dressedIdFor(actor, tilesById);
      if (!id) continue;
      const cell = `${actor.x},${actor.y},${actor.z}`;
      const edit = stacks.get(cell) ?? {
        x: actor.x,
        y: actor.y,
        z: actor.z,
        stack: [...getStack(map, actor.x, actor.y, actor.z)],
      };
      const placed: PlacedTile | undefined = edit.stack[actor.stackIndex];
      if (placed?.tileId !== actor.tileId) continue;
      edit.stack[actor.stackIndex] = { ...placed, tileId: id };
      stacks.set(cell, edit);
      keys.push(`${cell},${actor.stackIndex}=${id}`);
    }
    if (keys.length === 0) return { map, tilesById };

    const key = keys.join(";");
    if (this.drawn?.map !== map || this.drawn.key !== key) {
      this.drawn = { map, key, out: setStacks(map, [...stacks.values()]) };
    }
    return { map: this.drawn.out, tilesById: this.catalogueOf(tilesById) };
  }

  private reset(tilesById: Record<string, TileDef>) {
    this.base = tilesById;
    this.dressed.clear();
    this.catalogue = null;
    this.drawn = null;
  }

  private dressedIdFor(actor: ActorSnapshot, tilesById: Record<string, TileDef>): string | null {
    if (isBare(actor.outfit)) return null;
    const def = tilesById[actor.tileId];
    if (!def?.human) return null;
    const id = `${def.id}~${outfitKey(actor.outfit)}`;
    if (!this.dressed.has(id)) {
      this.dressed.set(id, wearing(def, id, actor.outfit));
      this.catalogue = null;
    }
    return id;
  }

  /** Rebuilt only when a new look appears, so the renderers' per-catalogue caches hold between frames. */
  private catalogueOf(tilesById: Record<string, TileDef>): Record<string, TileDef> {
    this.catalogue ??= { ...tilesById, ...Object.fromEntries(this.dressed) };
    return this.catalogue;
  }
}

function wearing(def: TileDef, id: string, worn: Outfit): TileDef {
  const human = def.human!;
  return { ...def, id, human: { ...human, outfit: { ...human.outfit, ...worn } } };
}
