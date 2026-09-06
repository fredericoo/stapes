import { bodyNameFor } from "../../app/game/displayName";
import type { Equipment } from "../../app/game/equipment";
import type { ActorSnapshot, GameSnapshot } from "../../app/game/GameSession";
import {
  interactionText,
  listInteractionOptions,
} from "../../app/game/interactionOptions";
import { hasLineOfSight } from "../../app/game/sight";
import { cutHides, roofCutFor, type RoofCut } from "../../app/lib/levelVisibility";
import { getStack } from "../../app/lib/mapData";
import { VIEW_CELLS } from "../../app/lib/view";
import {
  HEIGHT_PER_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  type MapFile,
  type TileDef,
} from "../../app/lib/types";

/**
 * What a bot is shown, and how it is written down.
 *
 * A pure function of the board, the catalogue, one snapshot and the sentences
 * that arrived since the last decision. Nothing here reads a clock, a socket or
 * a provider, which is what makes the interesting claims about it testable: that
 * the legend covers every character in the grid, that a cell you cannot see
 * reads as unknown rather than as ground, and that a coordinate read off the
 * ruler names the cell it appears to name.
 *
 * ## It is the player's view, not the server's board
 *
 * The two masks a person plays behind are applied in the same order the renderer
 * applies them. The roof cut first — `roofCutFor` at the bot's own cell, so a
 * body indoors is shown the room it is standing in rather than the roof over it
 * — and then line of sight, so what is round the corner reads as unknown. A bot
 * holds the whole patch stream its interest window reaches, and without the
 * second mask it would route through walls it has no business knowing about.
 *
 * ## Characters and a per-view legend, not tile ids
 *
 * `data/tiles.json` holds 125 tiles whose ids average about ten characters, so a
 * grid of raw ids is several times the tokens of a grid of single characters
 * plus a legend of the handful actually on screen. The legend is rebuilt per
 * view, so the model never has to hold a mapping between decisions — a glyph
 * means whatever this view says it means and nothing else.
 *
 * ## Bodies appear twice, from one snapshot
 *
 * A glyph in the grid gives position at a glance; the list under it gives name,
 * hit points and distance. Both are built from the same `visibleActors` array,
 * which is also what the interaction list is offered — so a body cannot be
 * standing in the grid, missing from the list, and targetable all at once.
 */

/** Where the bot itself is drawn. Never a tile, never a body. */
const SELF_GLYPH = "@";
/** A column nothing in this view can see into. */
const UNKNOWN_GLYPH = "?";
/** A column with nothing in it at all — open air, and possibly a drop. */
const NOTHING_GLYPH = ".";

/**
 * Characters terrain is drawn with, in the order they are handed out.
 *
 * Lowercase first because a lowercase field of grass reads as background and an
 * uppercase letter reads as a thing — which is the split this and
 * {@link BODY_GLYPHS} are making. The three reserved characters above are not in
 * here, and neither is anything a JSON string would have to escape.
 */
const TILE_GLYPHS =
  "abcdefghijklmnopqrstuvwxyz0123456789#+=*%&<>()[]{}!,;:$|/^~-_";

/** Characters bodies are drawn with. Uppercase, so a body is never scenery. */
const BODY_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * What everything past the end of {@link TILE_GLYPHS} is drawn as.
 *
 * Sixty distinct kinds of terrain in one 23×23 window is not a view anybody has
 * seen, but "runs out of letters" is not an acceptable way to find that out. The
 * overflow gets a legend entry of its own saying it stands for more than one
 * thing, so the legend still covers every character in the grid — which is the
 * invariant the tests hold, and the one a silent reuse would break.
 */
const OVERFLOW_GLYPH = "'";

/** How far apart the coordinate ticks are on the ruler above and below. */
const RULER_TICK_CELLS = 5;

/**
 * How far a bot sees, as a radius in cells.
 *
 * Half of what a player's camera shows, so a bot and a person are looking at the
 * same square of world. Sharing the constant is the point: the server already
 * streams each client the part of the map its view can reach, and a bot asking
 * for more would be describing cells it was never sent.
 */
export const BOT_VIEW_RADIUS = (VIEW_CELLS - 1) / 2;

/** One character of the grid, and what it stands for. */
export type BotLegendEntry = { glyph: string; tileId: string };

/** A body the bot can see, as both the grid and the list report it. */
export type BotViewBody = {
  glyph: string;
  actorId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  hp: number | null;
  maxHp: number | null;
  /** Chebyshev cells between the two bodies — the number of steps, near enough. */
  distance: number;
};

/** The bot's own body, as the vitals block reports it. */
export type BotViewSelf = {
  x: number;
  y: number;
  z: number;
  hp: number | null;
  maxHp: number | null;
  statusIds: string[];
  /** Slot name to tile id, for whatever is in a slot. */
  equipment: { slot: string; tileId: string }[];
};

export type BotView = {
  self: BotViewSelf;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** One string per row, north first. `rows[y - minY]![x - minX]` is a cell. */
  rows: string[];
  legend: BotLegendEntry[];
  bodies: BotViewBody[];
  /** `interactionText` of every row the player's own UI would be showing. */
  interactions: string[];
  /** Everything that happened since the last decision, already in English. */
  events: readonly string[];
};

export type BotViewInput = {
  map: MapFile;
  tilesById: Record<string, TileDef>;
  snapshot: GameSnapshot;
  events: readonly string[];
  radius?: number;
};

export function buildBotView({
  map,
  tilesById,
  snapshot,
  events,
  radius = BOT_VIEW_RADIUS,
}: BotViewInput): BotView {
  const self = snapshot.self;
  const cut = roofCutFor(map, tilesById, self);
  // The looking body's own height, so a bot sees over exactly what a person of
  // its size sees over. `hasLineOfSight` measures it from the ground under the
  // eye, which is its business rather than this one's.
  const eyeHeight = tilesById[self.tileId]?.height ?? HEIGHT_PER_LEVEL;
  const bounds = {
    minX: self.x - radius,
    maxX: self.x + radius,
    minY: self.y - radius,
    maxY: self.y + radius,
  };

  const glyphs = new GlyphTable();
  const rows: string[][] = [];
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    const row: string[] = [];
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const top = topVisibleTile(map, tilesById, cut, self, eyeHeight, x, y);
      row.push(
        top === "unseen"
          ? UNKNOWN_GLYPH
          : top === null
            ? NOTHING_GLYPH
            : glyphs.forTile(top),
      );
    }
    rows.push(row);
  }

  const visibleActors = snapshot.actors.filter(
    (actor) =>
      actor.id !== self.id &&
      canSeeBody(map, tilesById, cut, self, eyeHeight, actor),
  );

  const bodies: BotViewBody[] = [];
  for (const actor of visibleActors) {
    const glyph = glyphs.forBody();
    bodies.push({
      glyph,
      actorId: actor.id,
      name: bodyNameFor({ actorId: actor.id, tileId: actor.tileId }, tilesById),
      x: actor.x,
      y: actor.y,
      z: actor.z,
      hp: actor.hp,
      maxHp: actor.maxHp,
      distance: Math.max(Math.abs(actor.x - self.x), Math.abs(actor.y - self.y)),
    });
    write(rows, bounds, actor.x, actor.y, glyph);
  }
  // Last, so a body standing in the same cell this frame never hides the bot
  // from itself — the one glyph whose absence would leave the model with no
  // anchor between the grid and the coordinates it is asked to produce.
  write(rows, bounds, self.x, self.y, SELF_GLYPH);

  const interactions = listInteractionOptions(
    map,
    tilesById,
    self,
    visibleActors,
    snapshot.targetId,
    snapshot.equipment,
    null,
    snapshot.tags,
    snapshot.attacking,
    snapshot.extracting,
    snapshot.conversation,
  ).map(interactionText);

  return {
    self: {
      x: self.x,
      y: self.y,
      z: self.z,
      hp: self.hp,
      maxHp: self.maxHp,
      statusIds: self.statuses.map((status) => status.defId),
      equipment: describeEquipment(snapshot.equipment),
    },
    bounds,
    rows: rows.map((row) => row.join("")),
    legend: glyphs.legend(),
    bodies,
    interactions,
    events,
  };
}

/**
 * Hands out a character per kind of thing, and remembers what it gave.
 *
 * Assignment is first-encounter order over a row-major scan, so the same board
 * from the same cell always produces the same grid — which is what lets a test
 * name a glyph, and what stops two consecutive decisions describing an unchanged
 * view in two different alphabets.
 */
class GlyphTable {
  private readonly byTileId = new Map<string, string>();
  private tilesUsed = 0;
  private bodiesUsed = 0;
  private overflowed = false;

  forTile(tileId: string): string {
    const existing = this.byTileId.get(tileId);
    if (existing) return existing;
    const glyph = TILE_GLYPHS[this.tilesUsed];
    if (glyph === undefined) {
      this.overflowed = true;
      return OVERFLOW_GLYPH;
    }
    this.tilesUsed += 1;
    this.byTileId.set(tileId, glyph);
    return glyph;
  }

  forBody(): string {
    // Wraps rather than overflowing: twenty-six bodies in one window is a crowd
    // the list under the grid still describes correctly, and a twenty-seventh
    // sharing a letter is a smaller lie than a body with no glyph at all.
    const glyph = BODY_GLYPHS[this.bodiesUsed % BODY_GLYPHS.length]!;
    this.bodiesUsed += 1;
    return glyph;
  }

  legend(): BotLegendEntry[] {
    const entries = [...this.byTileId].map(([tileId, glyph]) => ({
      glyph,
      tileId,
    }));
    if (this.overflowed) {
      entries.push({ glyph: OVERFLOW_GLYPH, tileId: "several other things" });
    }
    return entries;
  }
}

/**
 * The topmost thing in this column the bot can actually see.
 *
 * Three answers, and the difference between the last two is the whole reason
 * `step` exists beside `walk_to`. A tile id is something to reason about;
 * `"unseen"` is a column behind a wall or under a roof, which the model must not
 * route through; and `null` is a column with nothing in it — open air, and
 * possibly the mouth of a hole with a floor somewhere below that nobody can see.
 *
 * Scanned from the top of the world down rather than from the bot's own level,
 * because a storey above is a thing you look at. Levels the roof cut has taken
 * away are skipped outright, and so are the ones with no line to them — asking
 * per level rather than once per column is what lets a bot standing indoors read
 * the floor under its feet through a roof it cannot see past.
 *
 * Bodies are stepped over rather than reported, on the board's own definition of
 * one: a placement carrying an owner is something being driven — see
 * `../../app/game/actors`. They are drawn from the snapshot, over the top of
 * this, so that the grid and the list under it are built from one source and
 * cannot disagree.
 */
function topVisibleTile(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cut: RoofCut | undefined,
  eye: { x: number; y: number; z: number },
  eyeHeight: number,
  x: number,
  y: number,
): string | null | "unseen" {
  let blocked = false;
  for (let z = MAX_LEVEL; z >= MIN_LEVEL; z--) {
    if (cutHides(cut, x, y, z)) continue;
    const stack = getStack(map, x, y, z);
    if (stack.length === 0) continue;
    if (!hasLineOfSight(map, tilesById, eye, { x, y, z }, eyeHeight)) {
      blocked = true;
      continue;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const placed = stack[i]!;
      if (placed.owner !== undefined) continue;
      return placed.tileId;
    }
  }
  // Something was there and none of it could be seen, which is a very different
  // sentence from "there is nothing here".
  return blocked ? "unseen" : null;
}

/** Is this body one the bot can see? The same two masks the grid is built with. */
function canSeeBody(
  map: MapFile,
  tilesById: Record<string, TileDef>,
  cut: RoofCut | undefined,
  eye: { x: number; y: number; z: number },
  eyeHeight: number,
  actor: ActorSnapshot,
): boolean {
  if (cutHides(cut, actor.x, actor.y, actor.z)) return false;
  return hasLineOfSight(map, tilesById, eye, actor, eyeHeight);
}

function write(
  rows: string[][],
  bounds: BotView["bounds"],
  x: number,
  y: number,
  glyph: string,
) {
  const row = rows[y - bounds.minY];
  if (!row) return;
  if (x < bounds.minX || x > bounds.maxX) return;
  row[x - bounds.minX] = glyph;
}

/**
 * What is in each filled slot, as a slot name and a tile id.
 *
 * Slots only, and deliberately not what is inside the bag: none of the verbs a
 * bot has can move an item, so a bag's contents would be a paragraph per
 * decision about things it cannot touch. It goes in with the first verb that
 * can.
 */
function describeEquipment(
  equipment: Equipment,
): { slot: string; tileId: string }[] {
  const out: { slot: string; tileId: string }[] = [];
  for (const [slot, item] of Object.entries(equipment) as [
    keyof Equipment,
    Equipment[keyof Equipment],
  ][]) {
    if (item) out.push({ slot, tileId: item.tileId });
  }
  return out;
}

/**
 * The view as the model reads it.
 *
 * Split from {@link buildBotView} so the structure can be asserted on directly
 * rather than through a regular expression over prose, and so the wording can be
 * changed without touching the rules about what is visible.
 */
export function renderBotView(view: BotView): string {
  const self = view.self;
  const lines: string[] = [];

  lines.push("## You");
  lines.push(
    `at (${self.x}, ${self.y}, ${self.z})` +
      (self.hp !== null && self.maxHp !== null
        ? `  hp ${self.hp}/${self.maxHp}`
        : ""),
  );
  lines.push(
    `carrying: ${
      self.equipment.length === 0
        ? "nothing"
        : self.equipment.map((e) => `${e.tileId} (${e.slot})`).join(", ")
    }`,
  );
  lines.push(
    `affecting you: ${self.statusIds.length === 0 ? "nothing" : self.statusIds.join(", ")}`,
  );

  lines.push("");
  lines.push("## What you can see");
  lines.push(...renderGrid(view));
  lines.push("");
  lines.push(
    `${SELF_GLYPH} = you    ${UNKNOWN_GLYPH} = out of sight    ${NOTHING_GLYPH} = nothing there (open air, possibly a drop)`,
  );
  for (const entry of view.legend) {
    lines.push(`${entry.glyph} = ${entry.tileId}`);
  }

  lines.push("");
  lines.push("## Bodies you can see");
  if (view.bodies.length === 0) {
    lines.push("nobody");
  } else {
    for (const body of view.bodies) {
      const health =
        body.hp !== null && body.maxHp !== null
          ? `  hp ${body.hp}/${body.maxHp}`
          : "";
      lines.push(
        `${body.glyph}  ${body.name}${health}  at (${body.x}, ${body.y}, ${body.z})  ${body.distance} away`,
      );
    }
  }

  lines.push("");
  lines.push("## What you can do from where you stand");
  if (view.interactions.length === 0) {
    lines.push("nothing here");
  } else {
    for (const text of view.interactions) lines.push(`- ${text}`);
  }

  lines.push("");
  lines.push("## Since your last decision");
  if (view.events.length === 0) {
    lines.push("nothing happened");
  } else {
    for (const event of view.events) lines.push(`- ${event}`);
  }

  return lines.join("\n");
}

/**
 * The grid, with the world's own coordinates written down both edges and along
 * the top and bottom.
 *
 * The ruler is not decoration. `walk_to` takes absolute coordinates, so without
 * one the model has to produce them by counting characters — which is the single
 * thing it is worst at, and a miscount is a body walking somewhere nobody asked
 * for. Every row carries its `y` on both sides, and the `x` axis is ticked every
 * {@link RULER_TICK_CELLS} cells with the number written above the tick, which
 * is how an axis has always been drawn.
 */
function renderGrid(view: BotView): string[] {
  const { minX, maxX, minY, maxY } = view.bounds;
  const width = maxX - minX + 1;
  const gutter = Math.max(
    ...[minY, maxY, minX, maxX].map((n) => String(n).length),
  );
  const pad = " ".repeat(gutter + 1);

  const ticks: number[] = [];
  for (let x = minX; x <= maxX; x++) {
    if (x % RULER_TICK_CELLS === 0) ticks.push(x);
  }

  const labelRow = Array.from({ length: width }, () => " ");
  const tickRow = Array.from({ length: width }, () => " ");
  for (const x of ticks) {
    const at = x - minX;
    tickRow[at] = "|";
    const label = String(x);
    for (let i = 0; i < label.length && at + i < width; i++) {
      labelRow[at + i] = label[i]!;
    }
  }

  const labelLine = (pad + labelRow.join("")).trimEnd();
  const tickLine = (pad + tickRow.join("")).trimEnd();
  const body = view.rows.map((row, index) => {
    const y = String(minY + index).padStart(gutter);
    return `${y} ${row} ${y}`;
  });
  return [labelLine, tickLine, ...body, tickLine, labelLine];
}
