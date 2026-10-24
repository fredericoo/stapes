import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOK,
  dressHuman,
  humanSheetId,
  lookOfTileHuman,
  tileHumanFromLook,
  tileHumanLook,
  type TileHuman,
} from "./humanSprite";
import type { Direction, TileDef, TileSprite } from "./types";

const FACINGS: Direction[] = ["s", "e", "w", "n"];
const FRAME_CELLS = 2;

function walkSprites(): Record<Direction, TileSprite> {
  return Object.fromEntries(
    FACINGS.map((facing, row) => [
      facing,
      {
        frames: [0, 1, 2].map((column) => ({
          sprite: {
            rect: { x: column * FRAME_CELLS, y: row * FRAME_CELLS, w: FRAME_CELLS, h: FRAME_CELLS },
            base: { x: 1, y: 1 },
          },
          durationMs: 200,
        })),
      },
    ]),
  ) as Record<Direction, TileSprite>;
}

const HUMAN: TileHuman = {
  skin: "brown",
  hair: "black",
  head: "beard",
  outfit: { clothes: "green-tunic", shoes: "dark-boots" },
};

function townsperson(fields: Partial<TileDef> = {}): TileDef {
  return {
    id: "baker",
    name: "Baker",
    height: 3,
    type: "directional",
    kind: "battler",
    attributes: {},
    anchor: { tilesetId: "people", x: 0, y: 0 },
    sprites: walkSprites(),
    states: { moving: { sprites: walkSprites() } },
    human: HUMAN,
    ...fields,
  };
}

describe("tileHumanLook", () => {
  it("dresses the tile in its outfit, with the empty slots bare", () => {
    expect(tileHumanLook(townsperson())).toEqual({
      parts: {
        base: "body",
        shoes: "dark-boots",
        clothes: "green-tunic",
        head: "beard",
        hat: null,
      },
      skin: "brown",
      hair: "black",
    });
  });

  it("draws from the anchor when the human does not parse", () => {
    const tile = townsperson({ human: { ...HUMAN, head: "mohawk" } as unknown as TileHuman });

    expect(tileHumanLook(tile)).toBeNull();
  });

  it("draws from the anchor when a frame reaches outside one character block", () => {
    const sprites = walkSprites();
    sprites.s.frames[0]!.sprite.rect.x = 6;

    expect(tileHumanLook(townsperson({ sprites }))).toBeNull();
  });
});

describe("dressHuman", () => {
  it("anchors a copy on the composed sheet and leaves the tile as saved", () => {
    const tile = townsperson();

    const dressed = dressHuman(tile)!;

    expect(dressed.def.anchor).toEqual({ tilesetId: dressed.sheetId, x: 0, y: 0 });
    expect(dressed.def.sprites).toBe(tile.sprites);
    expect(tile.anchor).toEqual({ tilesetId: "people", x: 0, y: 0 });
  });

  it("gives two tiles in the same look the same sheet", () => {
    const baker = dressHuman(townsperson())!;
    const twin = dressHuman(townsperson({ id: "twin" }))!;
    const other = dressHuman(townsperson({ human: { ...HUMAN, hair: "white" } }))!;

    expect(twin.sheetId).toBe(baker.sheetId);
    expect(other.sheetId).not.toBe(baker.sheetId);
  });

  it("leaves a tile without a human alone", () => {
    expect(dressHuman(townsperson({ human: undefined }))).toBeNull();
  });
});

describe("tileHumanFromLook", () => {
  it("saves the look's empty layers by leaving them out", () => {
    const look = { ...DEFAULT_LOOK, parts: { ...DEFAULT_LOOK.parts, shoes: null, hat: null } };

    const human = tileHumanFromLook(look);

    expect(human.outfit).toEqual({ clothes: "white-tunic" });
    expect(humanSheetId(lookOfTileHuman(human))).toBe(humanSheetId(look));
  });
});
