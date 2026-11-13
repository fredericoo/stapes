---
name: sprite-design
description: >
  How to draw a sprite for a tile, item or creature on the map. The map is drawn
  in an oblique (cabinet) projection, so a top-down drawing of anything with
  height looks wrong in the game. Use whenever you add or redraw art in
  data/tilesets/, write or change a scripts/generate-*.ts, or are asked to make
  a new tile, prop, plant, item or creature look right.
---

# Drawing for the map

## The map is oblique, not top-down

Every tile is 8×8 pixels (`CELL_SIZE`), and the renderer draws the world in a
cabinet projection: **a point `z` pixels above the ground is drawn `z` pixels up
and `z` pixels left of where it stands.** One height unit is 2 pixels
(`PX_PER_HEIGHT`), so a prop of height 3 rises 6 pixels.

What that does to a drawing:

- **A horizontal surface draws exactly as it would from above**, moved up and
  left by its height. Floors, rugs, a flower lying in the grass, a coin on the
  ground: a top-down drawing is correct for these.
- **Anything with height leans up and to the left.** A stalagmite, a tree trunk
  or a mushroom stem is a diagonal on screen, never a vertical line. A
  top-down or front-on drawing of an upright thing reads as flat or as lying
  down next to everything else.
- **The visible faces are the top, the south and the east**, and the world is
  lit from the south-west: the top and the south side are the bright ones, the
  east side the dark one. `cave-wall`, the swamp trees and the stalagmites all
  shade that way, and a sprite lit from anywhere else looks wrong beside them.
- **Something with height needs room above and left of its cell.** Props use a
  2×2-cell sprite with the ground in the south-east cell: `rect` `w: 2, h: 2`,
  `base` `{ x: 1, y: 1 }`. A 1×1 sprite cuts the top off anything taller than a
  couple of pixels. Items can be 2×2 as well; `crate-chest`, `sack` and the
  skins are.

## Most things are easiest as a 3D model cast to pixels

For anything with height, build the shape in 3D and cast it through the
projection, then let the palette and the pixel grid do the rest. Getting the
lean, the faces and the light right by hand is where hand-drawn attempts go
wrong. Not everything needs it: a floor, an autotile edge, a flat item or an
icon is quicker and better drawn directly.

Two casters live in `scripts/`, and both use the game's own projection:

- **`limb-caster.ts`** casts tapered capsules: trunks, branches, cones, limbs,
  stems. `generate-swamp-trees.ts`, `generate-desert.ts` (cacti) and
  `generate-stalagmites.ts` use it. A capsule has round ends, so it cannot make
  a flat underside or a disc: a "cap" made of one is a ball.
- **`model-caster.ts`** casts any shape you can describe point by point: a
  `sample(p)` that says what is at a point and which way its surface faces, and
  a `shade(hit)` that picks a palette index. Domes, discs, boxes, ellipsoids.
  `generate-mushrooms.ts` is the example, and its `PREVIEW=<dir>` writes the
  same model cast four times larger, which is the view to judge the shape in.

Whichever you use:

- **Colours are palette indices** from `STAPES_PALETTE` (`app/lib/palette.ts`),
  painted with `paint` from `tileset-output.ts`. Take a ramp from art the new
  thing will stand beside: the cave walls' browns, `cave-wall-grey`'s greys.
- **`writeTileset`** writes the PNG, its `tilesets.json` entry and the tiles
  together. It updates only the generated fields of a tile that already exists,
  so authored fields such as `interactions` survive a re-run.
- **Hand-drawn food has a dark edge below it.** `outlineBelow` adds one. An
  edge on the right as well doubles up along every diagonal and looks heavy.

## Traps already found

- **A tall part hides behind a wide part above it.** A mushroom stem shorter
  than its cap is wide is entirely under the cap on screen. Make the hidden
  part longer, or the covering part smaller.
- **Things in front hide things behind along the diagonal.** A second object to
  the south-east of the first covers its foot. Put it beside, to the north-east
  or south-west.
- **A deep shape stretches along the diagonal.** A tall dome reads as an egg;
  a flat one reads as a cap.
- **Shading bands across a flat top read as stripes.** Give a top one colour
  and shade only the sides.
- **A sprite is lit from the cells it is drawn over.** A prop against a north
  or west wall leans over that wall, which takes no light, and renders black
  however bright the floor in front is. Place such props with open floor to
  their north and west.
- **A prop of height 4 makes the cell above it unwalkable**, because it tops out
  on the floor plane of the level above. Keep anything meant to stand under a
  roof at 3 or less.

## Looking at it in the game

Judge it in the renderer, at the size a player sees it, next to the things it
will stand beside. `bun run scene` draws a hand-written scene with the real
renderer and catalogue (the `verify` skill has the format):

```json
{
  "time": "12:00",
  "zoom": 8,
  "look": [3, 2],
  "cells": [
    { "from": [-4, -4], "to": [10, 8], "tiles": ["dirt"] },
    { "at": [2, 2], "tiles": ["dirt", "your-new-tile"] },
    { "at": [4, 2], "tiles": ["dirt", "rock-pillar"] },
    { "at": [6, 2], "tiles": ["dirt", "apple"] }
  ]
}
```

Look at the 4× cast first for the shape, then the scene for how it reads at
1×. A sprite that only looks right enlarged is not finished. Send the user the
screenshot; a cloud session cannot attach it to the PR.
