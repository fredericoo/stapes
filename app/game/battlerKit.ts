import { resolveBattler } from "../lib/battler";
import { resolveContainer } from "../lib/item";
import type { ItemInstance } from "../lib/itemInstance";
import { mintItemId } from "../lib/itemInstance";
import type { Kit, KitContent } from "../lib/kit";
import { MAX_KIT_CHANCE } from "../lib/kit";
import type { TileDef } from "../lib/types";
import { emptyEquipment, type Equipment } from "./equipment";
import { slotAccepts } from "./itemMoves";

/**
 * Turning what a body is *authored* to carry into what it *is* carrying.
 *
 * The one crossing between `../lib/kit`'s authored shape and `./equipment`'s
 * runtime one, and it happens exactly once per body: when the world puts one on
 * the board. A creature killed and respawned is a new body and rolls again,
 * which is what makes a rat's meat a thing you go and get rather than a thing
 * you have.
 *
 * Its own module rather than a function in `./equipment`, because rolling is the
 * one part of a kit that needs to know what a *slot* will take — and that answer
 * lives in `./itemMoves`, which already reads `./equipment`. A cycle between the
 * two would be the price of putting this there.
 */

/**
 * What a fresh body of this kind is carrying.
 *
 * The one call every path that seats somebody goes through — a player joining,
 * a resident adopted out of the map, a creature growing back at a spawn point —
 * so "instantiating a battler instantiates its items" is true by construction
 * rather than by three functions remembering to.
 *
 * **A tile that is not a battler carries nothing**, which is the same answer as
 * a battler with no kit and deliberately not a different one: equipment hangs
 * off having a body, and a tile with no hit points has none. A tile the
 * catalogue has lost gives the same nothing, on the terms everything else here
 * treats a missing tile.
 */
export function equipmentForBody(
  tileId: string,
  tilesById: Record<string, TileDef>,
  random: () => number,
): Equipment {
  const def = tilesById[tileId];
  const battler = def ? resolveBattler(def) : null;
  if (!battler) return emptyEquipment();
  return equipmentFromKit(battler.kit ?? [], tilesById, random);
}

/**
 * Roll a kit into a kit.
 *
 * **Every entry costs exactly one draw, whatever else has landed**, on the same
 * grounds a swing always costs three and a decay lifetime always costs one: a
 * draw count that varied with what an author typed would mean adding a rare
 * dagger to one wolf changed what every creature in the world rolled after it.
 * So an entry aimed at a square that is already taken is still drawn for, and
 * the contents of a container that never arrived are still drawn for, and both
 * results are thrown away.
 *
 * **The first success takes the square.** Entries are rolled in the order they
 * were authored, which is what makes several entries on one slot a weighted
 * table: put the rare blade above the rusty one and a body that rolls both ends
 * up with the blade.
 *
 * Three ways an entry that succeeded still lands nothing, and all three are the
 * world being out of date rather than the kit being wrong — so all three are
 * silent, on the terms `restoredEquipment` drops a sword the catalogue has lost:
 *
 * - the tile is not in the catalogue any more;
 * - the slot will not take it (`slotAccepts` — a hand takes anything you can
 *   carry, the back takes only a pack you can wear, and inside a container the
 *   nesting rule still bites). One answer, shared with every drag and every
 *   rot, so a kit can never author a body into a state a player could not be
 *   put in;
 * - the container it was going into is full, or is not a container at all.
 *
 * The dice are passed in rather than reached for, because they are the world's:
 * two sessions on one seed have to agree about what the wolf was carrying as
 * well as about where it walked.
 */
export function equipmentFromKit(
  kit: Kit,
  tilesById: Record<string, TileDef>,
  random: () => number,
): Equipment {
  const equipment = emptyEquipment();

  for (const entry of kit) {
    const won = draw(entry, random);
    // Before the slot is tested, so a full square costs the same dice as an
    // empty one — see the note above.
    const contents = (entry.contents ?? []).filter((content) =>
      draw(content, random),
    );

    if (!won) continue;
    if (equipment[entry.slot]) continue;
    const instance = instantiate(entry.tileId, tilesById);
    if (!instance || !slotAccepts(entry.slot, instance, tilesById)) continue;

    equipment[entry.slot] = fill(instance, contents, tilesById);
  }

  return equipment;
}

/** Did this entry's chance come up? Certain is certain; zero is never. */
function draw(entry: KitContent, random: () => number): boolean {
  return random() * MAX_KIT_CHANCE < entry.chance;
}

/**
 * A fresh thing of this kind, or null when the catalogue has never heard of it.
 *
 * Minted here rather than left anonymous, exactly as the starting bag is: this
 * item is not in the world and there is no placement it came from, and an id is
 * what lets it be dropped, found and traced like anything else. It is also what
 * `../lib/itemInstance` requires of anything the wire has to describe.
 */
function instantiate(
  tileId: string,
  tilesById: Record<string, TileDef>,
): ItemInstance | null {
  if (!tilesById[tileId]) return null;
  return { id: mintItemId(), tileId };
}

/**
 * Put what rolled inside a container inside it, up to what it holds.
 *
 * Anything past the container's size is dropped rather than spilling into
 * another slot: what an author wrote is "these things are in this bag", and a
 * fifth thing in a four-slot bag turning up in a fist would be the kit quietly
 * disagreeing with them.
 *
 * A non-container with contents authored on it keeps none of them, which is the
 * same silence — the tile stopped being a bag while somebody was away, and the
 * entry is now a plain thing that arrives plain.
 */
function fill(
  instance: ItemInstance,
  contents: KitContent[],
  tilesById: Record<string, TileDef>,
): ItemInstance {
  const size = resolveContainer(tilesById[instance.tileId]!)?.size ?? 0;
  if (size === 0) return instance;

  const inside: ItemInstance[] = [];
  for (const content of contents) {
    if (inside.length >= size) break;
    const held = instantiate(content.tileId, tilesById);
    if (!held || !slotAccepts("contents", held, tilesById)) continue;
    inside.push(held);
  }
  // Always present on a container, empty included, because that is the shape
  // every other container on a body has — see `Equipment.bag`, whose `contents`
  // *is* the inventory rather than a second list beside it.
  return { ...instance, contents: inside };
}
