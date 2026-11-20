import type { TileDef } from "../../app/lib/types";
import type { Builder } from "./build";
import { SIDEWAYS, STEP, type Dir } from "./plan";
import { Digger, type Underground } from "./underground";

type Point = [number, number];

/**
 * Where the underground is, in map cells. Each elemental land goes down from
 * its own entrances and gets harder with depth; the deep way on level -4
 * joins every descent, and the Ember heart on -6 is the bottom of the island.
 * Everything here is placed from the terrain `docs/map.md` describes, so
 * moving a cave is an edit to this file.
 */
export function digUnderground(b: Builder, tilesById: Record<string, TileDef>): Underground {
  const d = new Digger(b, tilesById);
  const link = (z: number, points: Point[], style: Parameters<Digger["tunnel"]>[3], width = 3) =>
    d.tunnel(`${z}:${points.map((p) => p.join(",")).join(";")}`, points, z, style, width);

  /** A cave in a hill on its own, opening onto ground a player can walk to: a lair. */
  const lair = (
    name: string,
    target: Point,
    z: number,
    mouthTile: string,
    style: Parameters<Digger["room"]>[6],
    size: Point,
    faces?: Dir[],
    reach?: number,
  ) => {
    const m = d.mouth(name, target[0], target[1], z, mouthTile, style, faces, reach);
    const [dx, dy] = STEP[m.d];
    const depth = (dx ? size[0] : size[1]) + 1;
    const centre: Point = [m.x - dx * depth, m.y - dy * depth];
    link(z, [[m.x, m.y], centre], style, 2);
    d.room(name, centre[0], centre[1], z, size[0], size[1], style);
    d.place(name, `${z}`, centre[0], centre[1], z, "a lair behind a cliff mouth");
    return { centre, inward: [-dx, -dy] as Point, side: STEP[SIDEWAYS[m.d]] };
  };

  lair("Bat cave", [-40, -50], 0, "hill-cave-mouth", "stone", [8, 5]);

  const [bx, by] = d.spot(-92, -136, 3);
  const barrow = d.stairs(bx, by, -1, "s", "barrow", "barrow");
  d.entrance("The barrow", "`stone-stairs` down from the field", bx, by, 0);
  const [hx, hy] = barrow.below;
  d.hall(hx - 8, hy - 14, hx + 8, hy, -1, "barrow");
  d.hall(hx - 30, hy - 16, hx - 16, hy - 4, -1, "barrow");
  link(
    -1,
    [
      [hx - 8, hy - 9],
      [hx - 16, hy - 10],
    ],
    "barrow",
    2,
  );
  d.hall(hx + 16, hy - 18, hx + 28, hy - 6, -1, "barrow");
  link(
    -1,
    [
      [hx + 8, hy - 11],
      [hx + 16, hy - 12],
    ],
    "barrow",
    2,
  );
  d.hall(hx - 6, hy - 38, hx + 6, hy - 24, -1, "barrow");
  link(
    -1,
    [
      [hx, hy - 14],
      [hx, hy - 24],
    ],
    "barrow",
    2,
  );
  d.place(
    "The barrow",
    "-1",
    hx,
    hy - 7,
    -1,
    "four halls of flagstone and bone round an entrance hall",
  );

  const [wx, wy] = d.spot(-89, -182, 3);
  const den = d.stairs(wx, wy, -1, "s", "earth", "earth");
  d.entrance("Wolf den", "`stone-stairs` down from the field", wx, wy, 0);
  link(-1, [den.below, [den.below[0], den.below[1] - 5]], "earth");
  d.room("Wolf den", den.below[0], den.below[1] - 6, -1, 7, 5, "earth");
  d.place("Wolf den", "-1", den.below[0], den.below[1] - 6, -1, "a lair under the field");

  const [fx, fy] = d.spot(-60, -164, 1);
  d.ladder(fx, fy, -1, "flooded", "flooded");
  d.entrance("The flooded caves", "a ladder down from the lake shore", fx, fy, 0);
  link(
    -1,
    [
      [fx, fy],
      [-48, -172],
      [-40, -178],
    ],
    "flooded",
  );
  d.warren("Flooded caves", -40, -178, -1, [51, 30], 19, "flooded");
  link(
    -1,
    [
      [hx + 28, hy - 12],
      [fx - 4, fy + 2],
      [fx, fy],
    ],
    "barrow",
    2,
  );
  const flood2 = d.stairs(-30, -186, -2, "n", "flooded", "flooded");
  link(-2, [flood2.below, [-30, -196]], "flooded");
  d.warren("Flooded caves below", -30, -198, -2, [47, 30], 19, "flooded");
  d.place("The flooded caves", "-1, -2", -40, -178, -1, "standing water between the lakes");
  const heart3 = d.stairs(-40, -205, -3, "e", "stone", "flooded");
  link(-3, [heart3.below, [-47, -218], [-45, -229]], "stone");
  d.warren("Under the lakes", -47, -218, -3, [26, 18], 11, "stone");
  const heart4 = d.stairs(-45, -232, -4, "s", "stone", "stone");

  const [gx, gy] = d.spot(12, -40, 1);
  d.ladder(gx, gy, -1, "grotto", "grotto");
  d.entrance("Sea grotto", "a ladder down from the beach", gx, gy, 0);
  link(
    -1,
    [
      [gx, gy],
      [20, -34],
    ],
    "grotto",
  );
  d.warren("Sea grotto", 20, -34, -1, [30, 18], 11, "grotto");
  d.place("Sea grotto", "-1", 20, -34, -1, "pools and sand under the beach");

  const bears = lair(
    "Bear caves",
    [-162, -276],
    1,
    "hill-cave-mouth",
    "earth",
    [9, 6],
    ["s", "e"],
    50,
  );
  {
    const [ix, iy] = bears.inward;
    const [sx, sy] = bears.side;
    const inner: Point = [bears.centre[0] + ix * 12 + sx * 6, bears.centre[1] + iy * 12 + sy * 6];
    link(1, [bears.centre, inner], "earth", 2);
    d.room("Bear caves inner", inner[0], inner[1], 1, 7, 5, "earth");
  }
  lair("Troll cave", [-240, -225], 0, "hill-cave-mouth", "earth", [9, 6], ["s", "e"], 50);

  const [rx, ry] = d.spot(-248, -290, 3);
  const roots = d.stairs(rx, ry, -1, "s", "roots", "roots");
  d.entrance("The rootways", "`stone-stairs` down in the deep woods", rx, ry, 0);
  link(-1, [roots.below, [rx + 12, ry - 10], [-215, -285], [-205, -272]], "roots");
  d.warren("Rootways", rx + 14, ry - 6, -1, [35, 26], 16, "roots");
  const roots2 = d.stairs(-205, -268, -2, "n", "roots", "roots");
  link(-1, [[-205, -272], roots2.above], "roots");
  link(-2, [roots2.below, [-225, -255], [-240, -244]], "roots");
  d.warren("Rootways below", -240, -240, -2, [35, 22], 16, "roots");
  d.hole(-237, -238, -2, "roots", "roots");
  d.warren("Rootways deep", -238, -232, -3, [30, 22], 14, "roots");
  const roots3 = d.stairs(-246, -228, -3, "n", "roots", "roots");
  link(-2, [roots3.above, [-245, -236]], "roots");
  link(-3, [roots3.below, [-240, -230]], "roots");
  const [hwx, hwy] = d.spot(-255, -262, 2);
  d.hole(hwx, hwy, 0, "roots", "roots");
  d.ladder(hwx + 3, hwy, -1, "roots", "roots");
  d.entrance("The rootways", "a hole in the woods, with a ladder back up beside it", hwx, hwy, 0);
  link(
    -1,
    [
      [hwx + 1, hwy + 1],
      [rx, ry - 4],
    ],
    "roots",
  );
  const roots4 = d.stairs(-240, -222, -4, "n", "stone", "roots");
  link(-3, [roots4.above, [-238, -230]], "roots");
  d.place("The rootways", "-1 to -3", -240, -240, -2, "earth and tree roots under the deep woods");

  const frost = d.mouth("Frost caves", -98, -250, 1, "hill-cave-mouth-frost", "frost", [
    "s",
    "e",
    "w",
  ]);
  const hall: Point = [-96, -260];
  link(1, [[frost.x, frost.y], hall], "frost");
  d.room("Frost hall", hall[0], hall[1], 1, 10, 6, "frost");
  link(1, [hall, [-95, -268]], "frost");
  const up2 = d.stairs(-95, -270, 1, "n", "frost", "frost");
  link(2, [up2.above, [-92, -279], [-88, -284]], "frost");
  d.room("Frost caves second", -92, -279, 2, 9, 5, "frost");
  const up3 = d.stairs(-88, -286, 2, "n", "frost", "frost");
  link(3, [up3.above, [-75, -298]], "frost");
  d.room("Frost caves third", -75, -298, 3, 14, 6, "frost");
  const icy = d.mouth("Ice hollow", 2, -296, 3, "hill-cave-mouth-frost", "frost", ["e", "s"]);
  link(
    3,
    [
      [-75, -298],
      [-40, -297],
      [icy.x, icy.y],
    ],
    "frost",
  );
  d.place("Frost caves", "1 to 3", hall[0], hall[1], 1, "ice and frosted rock inside the mountain");
  d.place("Ice hollow", "3", icy.x, icy.y, 3, "the high way into the frost caves");

  const down0 = d.stairs(-108, -258, 0, "e", "crystal", "frost");
  link(1, [down0.above, hall], "frost");
  link(0, [down0.below, [-118, -266]], "crystal");
  d.warren("Crystal gallery", -118, -266, 0, [39, 22], 16, "crystal");
  link(
    0,
    [
      [-118, -266],
      [-105, -280],
      [-95, -292],
    ],
    "crystal",
  );
  d.room("Crystal gallery east", -95, -292, 0, 12, 7, "crystal");
  const downHalls = d.stairs(-85, -292, -1, "w", "crystal", "crystal");
  link(0, [[-95, -292], downHalls.above], "crystal");
  link(-1, [downHalls.below, [-65, -290]], "crystal");
  d.warren("Crystal halls", -65, -290, -1, [51, 26], 22, "crystal");
  d.place("Crystal galleries", "0, -1", -118, -266, 0, "arcane crystal in frosted rock");

  const lake2 = d.stairs(-52, -293, -2, "w", "frozenLake", "crystal");
  link(-1, [[-65, -290], lake2.above], "crystal");
  link(-2, [lake2.below, [-32, -295]], "frozenLake");
  d.warren("Frozen lake", -32, -295, -2, [57, 26], 22, "frozenLake");
  const lake3 = d.stairs(-20, -300, -3, "w", "frozenLake", "frozenLake");
  link(-2, [[-32, -295], lake3.above], "frozenLake");
  link(-3, [lake3.below, [-5, -292]], "frozenLake");
  d.warren("Frozen lake below", -5, -292, -3, [47, 22], 19, "frozenLake");
  const lake4 = d.stairs(-10, -276, -4, "n", "stone", "frozenLake");
  link(-3, [[-5, -292], lake4.above], "frozenLake");
  d.place("The frozen lake", "-2, -3", -32, -295, -2, "ice over standing water under the peak");

  const gorge = d.mouth("Ember deeps", 156, -215, 0, "hill-cave-mouth-basalt", "sandstone", ["w"]);
  const waste = d.mouth("Ember deeps", 195, -212, 0, "hill-cave-mouth-sandstone", "sandstone", [
    "e",
    "s",
  ]);
  const top: Point = [172, -212];
  link(0, [[gorge.x, gorge.y], top], "sandstone");
  link(0, [[waste.x, waste.y], top], "sandstone");
  d.room("Ember deeps", top[0], top[1], 0, 9, 6, "sandstone");
  const e1 = d.stairs(172, -206, -1, "n", "sandstone", "sandstone");
  link(-1, [e1.below, [175, -195]], "sandstone");
  d.warren("Ember deeps -1", 175, -195, -1, [43, 26], 19, "sandstone");
  const e2 = d.stairs(182, -190, -2, "n", "sandstone", "sandstone");
  link(-2, [e2.below, [178, -178]], "sandstone");
  d.warren("Ember deeps -2", 178, -178, -2, [35, 22], 16, "sandstone");
  d.hole(172, -178, -2, "basalt", "sandstone");
  d.warren("Ember deeps -3", 168, -172, -3, [35, 22], 16, "basalt");
  const e3 = d.stairs(185, -170, -3, "n", "basalt", "sandstone");
  link(-3, [e3.below, [168, -172]], "basalt");
  const e4 = d.stairs(160, -175, -4, "e", "basalt", "basalt");
  link(-4, [e4.below, [160, -190]], "basalt");
  d.warren("Ember deeps -4", 160, -190, -4, [26, 26], 16, "basalt");
  const e5 = d.stairs(168, -198, -5, "w", "lava", "basalt");
  link(-5, [e5.below, [180, -205]], "lava");
  d.warren("Ember deeps -5", 180, -205, -5, [39, 26], 19, "lava");
  const e6 = d.stairs(188, -210, -6, "n", "lava", "lava");
  link(-6, [e6.below, [175, -195]], "lava");
  d.hole(172, -202, -5, "lava", "lava");
  d.room("Ember heart", 175, -195, -6, 22, 13, "lava");
  d.warren("Ember heart", 175, -195, -6, [51, 35], 22, "lava");
  d.place("Ember deeps", "0 to -5", top[0], top[1], 0, "sandstone, then basalt, then lava");
  d.place("Ember heart", "-6", 175, -195, -6, "a lava cavern with the deep-ore veins");
  lair(
    "Snake hollow",
    [128, -121],
    0,
    "hill-cave-mouth-sandstone",
    "sandstone",
    [7, 5],
    ["e", "s"],
  );

  link(
    -4,
    [
      roots4.below,
      [-242, -245],
      [-232, -266],
      [-180, -268],
      [-130, -266],
      [-60, -270],
      lake4.below,
    ],
    "stone",
  );
  link(-4, [lake4.below, [-40, -262], heart4.below], "stone");
  link(
    -4,
    [
      heart4.below,
      [-55, -200],
      [-40, -150],
      [10, -135],
      [60, -135],
      [152, -135],
      [155, -160],
      e4.below,
    ],
    "stone",
  );
  d.warren("The deep way west", -130, -266, -4, [22, 7], 9, "stone");
  d.warren("The deep way east", 40, -135, -4, [26, 7], 9, "stone");
  d.place("The deep way", "-4", -130, -266, -4, "one tunnel from the rootways to the Ember deeps");

  const cells = d.write();
  return d.summary(cells);
}
