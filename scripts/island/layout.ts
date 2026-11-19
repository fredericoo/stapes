/**
 * Every named place, at its position on `docs/lore-map.webp` in sketch
 * pixels. The generator scales them by `cellsPerPixel`, so moving a place on
 * the island is an edit here and nowhere else.
 */
export const PLACES = {
  wreckBeach: { x: 812, y: 928, label: "Wreck beach", note: "player wakes here" },
  wreck: { x: 836, y: 958, label: "The wreck", note: "salvage" },
  camp: { x: 800, y: 762, label: "The camp", note: "first trades" },
  batCave: { x: 738, y: 826, label: "Bat cave", note: "first time underground" },
  druids: { x: 510, y: 540, label: "The druids' town", note: "rune temple" },
  barrow: { x: 634, y: 654, label: "The barrow", note: "skeletons, bone" },
  frostCaves: { x: 622, y: 438, label: "Frost caves", note: "crystal" },
  bearCaves: { x: 494, y: 374, label: "Bear caves", note: "deep woods" },
  deepWoods: { x: 345, y: 405, label: "Deep woods", note: "" },
  bog: { x: 365, y: 678, label: "The bog", note: "" },
  witch: { x: 452, y: 640, label: "Witch's house", note: "on stilts, bog's edge" },
  inn: { x: 790, y: 478, label: "Roadside inn", note: "north shore of the lake" },
  lake: { x: 850, y: 522, label: "The lake", note: "" },
  warriors: { x: 980, y: 548, label: "The warriors' town", note: "" },
  emberDeeps: { x: 1145, y: 530, label: "Ember deeps", note: "deep ore" },
  gorge: { x: 1120, y: 560, label: "Lava gorge", note: "" },
  lighthouse: { x: 1038, y: 868, label: "The lighthouse", note: "Halvard, Maren, Wyrd" },
  harbour: { x: 968, y: 868, label: "Old harbour ruins", note: "flooded, overgrown" },
  peak: { x: 705, y: 285, label: "The White Peak", note: "" },
  icyCave: { x: 820, y: 340, label: "Ice hollow", note: "under the peak" },
  bayCave: { x: 900, y: 905, label: "Sea grotto", note: "flooded" },
  snakeHollow: { x: 1010, y: 690, label: "Snake hollow", note: "desert edge lair" },
  wolfDen: { x: 640, y: 560, label: "Wolf den", note: "" },
  trollCave: { x: 400, y: 520, label: "Troll cave", note: "deep woods" },
} as const;

export type PlaceId = keyof typeof PLACES;

/**
 * Roads as pairs of places. Order matters: each road is routed over the ones
 * already laid and prefers to run along them, so trunks go first.
 */
export const ROADS: ReadonlyArray<readonly [PlaceId, PlaceId]> = [
  ["wreckBeach", "camp"],
  ["camp", "druids"],
  ["camp", "warriors"],
  ["druids", "inn"],
  ["inn", "warriors"],
  ["warriors", "lighthouse"],
  ["camp", "harbour"],
  ["harbour", "lighthouse"],
  ["warriors", "emberDeeps"],
  ["druids", "deepWoods"],
  ["druids", "frostCaves"],
];

/** The camp road, and the only one nothing hostile is placed beside. */
export const SAFE_PATH: readonly [PlaceId, PlaceId] = ["wreckBeach", "camp"];

/**
 * Every settlement's flat site in cells, centred on its place. The ground in
 * a site is levelled to one storey, and the land round it eases down to it
 * over `SITE_APRON` cells, so a town never stands on a cliff.
 */
export const SITES = {
  camp: { w: 40, h: 30 },
  druids: { w: 76, h: 64 },
  warriors: { w: 80, h: 66 },
  inn: { w: 34, h: 26 },
  witch: { w: 14, h: 14 },
  lighthouse: { w: 30, h: 30 },
  harbour: { w: 56, h: 24 },
} as const satisfies Partial<Record<PlaceId, { w: number; h: number }>>;

export type SiteId = keyof typeof SITES;

export const SITE_APRON = 12;
