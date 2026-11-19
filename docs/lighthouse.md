# The lighthouse

What the lighthouse is meant to be, the tiles it is built from, and the limits
that decide how it can be laid out. Read this before placing any of it in
`data/map.json`. The lore behind it is `docs/lore.md` (*The wizard and his
lighthouse*, *Climbing the lighthouse*).

## What it is

- **The last and hardest dungeon.** The lighthouse stands on the headland of
  the bay. It is easy to reach and very hard to climb. It has many floors, each
  harder than the one below, and the upper floors are meant for a group, not a
  player alone.
- **Two bosses.** Maren is fought partway up. Halvard, the wizard, is the final
  boss, at the top beside Wyrd.
- **No longer a working lighthouse.** It is a symbol, not a beacon: there is no
  fire, no glass and no iron. It is a medieval stone tower in grey rubble, with
  a limewashed tier.
- **Wyrd at the top.** Wyrd is the rune Halvard carved from Maren's heart. It
  is the one light the tower has, and it beats like a heart.
- **Seeing it from the beach does not matter.** The tower does not have to be
  visible from where players start, and nothing about its height is tuned for
  that.

## The tiles

All are drawn by `bun run generate:lighthouse` (`scripts/generate-lighthouse.ts`)
into `data/tilesets/lighthouse.png`.

| Tile | Use |
| --- | --- |
| `lighthouse-wall`, `lighthouse-wall-limewashed` | One full level of wall per cell, like `stone-wall`. Every finish below comes in both. |
| `lighthouse-wall-corner`, `-limewashed-corner` | A wall cell cut on the diagonal. `n` is the north-east corner, `e` south-east, `s` south-west and `w` north-west. A row of them along a diagonal makes one straight 45° wall. |
| `lighthouse-wall-slit`, `-limewashed-slit` | A wall cell with an arrow slit. It passes light, so a floor is not dark inside. |
| `lighthouse-wall-doorway`, `-limewashed-doorway` | A wall cell with an arch through it. Facing `n`/`s` the passage runs north–south; facing `e`/`w` it runs east–west. Bodies walk through it as they do through `door-open`. |
| `lighthouse-ledge` | A low kerb autotile for the outer edge of a setback. |
| `lighthouse-parapet` | A crenellated autotile, the same height as `fence`, round the top platform. |
| `lighthouse-arcade` | An autotile of stone piers and arches, one level high, round Wyrd's room. It passes light. |
| `lighthouse-roof` | A stone cone with a 3×3 footprint, anchored in the south-east cell of the arcade's ring, on the level above it. |
| `wyrd` | The rune on its plinth: a light of radius 15 that beats, and crimson particles. |
| `lighthouse-pedestal`, `lighthouse-pedestal-pressed` | A pressure-plate pair on a stone column. See *Pedestals*. |

## The intended shape

The preview this was designed against is 16 levels in three tiers. Each tier is
narrower than the one below, so the tower tapers like a real one:

| Levels | Across | Wall | Contents |
| --- | --- | --- | --- |
| 0–3 | 17 cells | rubble | Entrance (a doorway in the south wall at level 0), storerooms, the easier floors |
| 4–9 | 13 cells | limewashed | Middle floors; Maren's fight, in a hall two levels tall |
| 10–13 | 9 cells | rubble | Floors for a group |
| 14 | 9 cells | — | Top platform: parapet on the edge, arcade ring round Wyrd |
| 15 | — | — | `lighthouse-roof` over the arcade |

Numbers and widths can change. Keep these parts of it:

- **The plan is an octagon.** A cell is inside a tier of half-width `R` when
  `max(|x|, |y|) <= R` and `|x| + |y| <= R + R // 2`, counted from the tower's
  centre. The cells where `|x| + |y|` equals that limit take the corner tile
  facing their quadrant; the other edge cells take a plain wall.
- **Every setback leaves a walkway outside the narrower tier.** The walkway is
  `flagstone-floor` on the level above the wider tier's last wall, with
  `lighthouse-ledge` along its outer edge.
- **Every storey has a floor.** Each inside cell holds `flagstone-floor` on its
  level. The wall below holds it up: a wall is a full level, so its top is the
  floor plane of the level above.
- **Slits on alternate storeys.** In the preview a slit is in the middle of
  each straight wall, and two cells either side of it, on every other level.
- **The stair goes round the tower.** Use `stone-stairs`, moved a quarter turn
  round on each storey. Each stair needs the cell above it left empty (see "A
  ramp between two levels needs a hole above it" in `docs/notes.md`). A floor
  painted over that hole makes the stair impossible to stand on, and no error
  says so.
- **Wyrd stays in a 3×3 room** at the centre of the top, ringed by
  `lighthouse-arcade`. The roof cannot cover anything larger.

## Pedestals

- **How the puzzle works.** A pedestal is `pressure-plate` on a column: it reads
  the height of what stands on it. Anything at least one height unit tall
  presses it, and `lighthouse-pedestal-pressed` emits `on` on the placement's
  channel. To make "set something on every pedestal to open the door", give
  each pedestal its own channel, and list them all on a `metal-door-closed` /
  `metal-door-open` pair in `all` mode (see "A wooden door answers to hands,
  and a metal door to channels" in `docs/notes.md`).
- **It cannot ask for a particular item.** Any object one unit tall or more
  opens the door. Requiring a particular relic needs engine work. Until then,
  the nearest way is a dialog that checks a tag the player was given when they
  took the relic (`if` / `tagged`).
- **A body standing on the pedestal presses it too.** It is walkable, because a
  player can only put something down on a surface a body could stand on.
- **Pressed shows in the column, not the top.** A thin rim round the column
  lights teal and throws a blue light five cells round. The top is the same in
  both states, so the item set on it is what you see.

## Limits that decide the layout

- **Drawing.** The game draws 8 levels above and below the player
  (`VIEW_LEVEL_REACH` in `app/lib/view.ts`). Inside the tower that is the floors
  near you. From the ground, nothing above level 8 is drawn.
- **Network cost.** Every level of a chunk is sent to everybody standing on that
  chunk (see "The world is 129 levels deep" in `docs/notes.md`). A hollow tower
  of rooms is light. Filling whole floors solid, or stacking dozens of dense
  floors, is not.
- **The roof hides Wyrd from outside.** In this projection a solid roof covers
  whatever stands in the middle of the room under it. A player in the room has
  the roof cut away above them, as under any roof, so the fight is not
  affected.
- **Footprints.** `MAX_FOOTPRINT_SIDE` is 4. No single tile can roof a room
  wider than that, so a wider hall needs a floor of the level above as its
  ceiling, as every other building has.
- **Wyrd's light rebakes on every beat.** The beat changes the light's
  intensity, which rebakes a window of radius 15. Nobody has measured what that
  costs with players in the room. If it shows in a profile, give every frame
  the same intensity and keep the pulse in the sprite only.
- **Every floor needs a way back down.** `bun run verify stranded` fails CI on
  any cell a player can reach and not leave. A drop off a setback ledge, or a
  stair whose hole was floored over, is the usual way to make one.

## Previewing a layout

`bun run scene` draws a hand-written scene with the real renderer (the `verify`
skill has the format). The scene page always draws levels −8 to 8, whatever
`look` says, because it does not pass the viewer's level to the renderer. To
see a tower taller than eight levels, lower every cell of the scene by eight
levels, ground included.
