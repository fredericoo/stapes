import { describe, expect, it } from "vitest";
import type { ActorSnapshot } from "../game/GameSession";
import { emptyMap, getStack, replaceStack } from "../lib/mapData";
import type { TileDef } from "../lib/types";
import { WornLooks } from "./wornLooks";

const GUARD: TileDef = {
  id: "guard",
  name: "Guard",
  height: 3,
  type: "simple",
  kind: "battler",
  attributes: {},
  anchor: { tilesetId: "people", x: 0, y: 0 },
  human: { skin: "default", hair: "red", head: "beard", outfit: { clothes: "white-tunic" } },
};
const WOLF: TileDef = { ...GUARD, id: "wolf", name: "Wolf", human: undefined };
const CATALOGUE = { guard: GUARD, wolf: WOLF };

function actor(tileId: string, x: number, outfit: ActorSnapshot["outfit"]): ActorSnapshot {
  return { id: `${tileId}-${x}`, tileId, x, y: 0, z: 0, stackIndex: 1, outfit } as ActorSnapshot;
}

function world() {
  let map = emptyMap();
  map = replaceStack(map, 0, 0, 0, [{ tileId: "grass" }, { tileId: "guard" }]);
  map = replaceStack(map, 1, 0, 0, [{ tileId: "grass" }, { tileId: "wolf" }]);
  return map;
}

describe("WornLooks", () => {
  it("draws a human in what they wear over their own outfit, in the drawn map only", () => {
    const map = world();

    const view = new WornLooks().apply(
      map,
      [actor("guard", 0, { hat: "iron-helmet", clothes: "steel-mail" })],
      CATALOGUE,
    );

    const drawnId = getStack(view.map, 0, 0, 0)[1]!.tileId;
    expect(view.tilesById[drawnId]!.human).toEqual({
      ...GUARD.human,
      outfit: { clothes: "steel-mail", hat: "iron-helmet" },
    });
    expect(getStack(map, 0, 0, 0)[1]!.tileId).toBe("guard");
    expect(CATALOGUE).not.toHaveProperty(drawnId);
  });

  it("leaves bodies that wear nothing, or are not human, as they are", () => {
    const map = world();

    const view = new WornLooks().apply(
      map,
      [actor("guard", 0, {}), actor("wolf", 1, { hat: "iron-helmet" })],
      CATALOGUE,
    );

    expect(view.map).toBe(map);
    expect(view.tilesById).toBe(CATALOGUE);
  });

  it("hands back the same map and catalogue while nothing changes, so the renderer rebuilds nothing", () => {
    const looks = new WornLooks();
    const map = world();
    const actors = [actor("guard", 0, { hat: "iron-helmet" })];

    const first = looks.apply(map, actors, CATALOGUE);
    const second = looks.apply(map, actors, CATALOGUE);

    expect(second.map).toBe(first.map);
    expect(second.tilesById).toBe(first.tilesById);
  });
});
