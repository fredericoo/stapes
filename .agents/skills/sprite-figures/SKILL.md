---
name: sprite-figures
description: >
  Generates walking character sprite sheets (townsfolk, NPCs, outfits) from the
  3D figure in app/lib/figure.ts, from the command line with
  `bun run generate:figure` — no dev server needed. Use when asked to make,
  dress, recolour or add a townsperson, NPC, villager or character sprite, to
  give a tile a new look, or when changing the figure model itself.
---

# Generating character sprites

A character sheet here is a 48×64 PNG laid out like the player's block in
`data/tilesets/people.png`: rows face **south, east, west, north**; columns are
**step, stand, step**; each frame is 16×16 (2×2 cells) with its base at (1, 1).
`app/lib/figure.ts` renders one from a small 3D figure through the game's
oblique projection, so any tile that walks with the player's frames wears it by
moving its `anchor` and nothing else.

Two front ends share that renderer:

- **`bun run generate:figure`** — the CLI. It reads and writes `data/` directly,
  so it needs no server. **Agents use this one.**
- `/admin/townsfolk` — the same controls in the browser, for a person. It needs
  `bun dev` and an admin account.

## The look

| Part  | Flag(s)                                   | Values                                 |
| ----- | ----------------------------------------- | -------------------------------------- |
| Skin  | `--skin <hex>`                            | any colour                             |
| Hair  | `--hair <style>`, `--hair-colour <hex>`   | `bald` `short` `bob` `long` `ponytail` |
| Beard | `--beard` / `--no-beard`                  | drawn in the hair colour               |
| Shirt | `--shirt <hex>`                           | also colours the upper arms            |
| Legs  | `--legs <style>`, `--legs-colour <hex>`   | `trousers` `robe`                      |
| Shoes | `--shoes <hex>`                           |                                        |
| Cloak | `--cloak <style>`, `--cloak-colour <hex>` | `none` `cape` `cloak` `hooded`         |

Every colour is snapped to `STAPES_PALETTE` (`app/lib/palette.ts`), and its
shadow and highlight come from the palette too, so pick palette entries to get
exactly what you asked for:

```
#2e222f outline (never use for a part)  #313638 #45293f #6e2727 #3e3546 #323353
#165a4c #484a77 #694f62 #ae2334 #e83b3b #9e4539 #fb6b1d #cd683d #cf657f #239063
#1ebc73 #f79617 #e6904e #fbb954 #91db69 #d5e04b #7f708a #4d65b4 #4d9be6 #9babb2
#a884f3 #c7dcd0 #ffffff #affcdb #53d5cf #225ac0 #362281
```

Skin tones the random look draws from: `e6904e cd683d 9e4539 fbb954 694f62`.

**Write colours without the `#`** (`--shirt ae2334`) or quote them. An unquoted
`#` after a space starts a shell comment and silently drops the rest of the
command.

## Workflow

1. **Draft into the scratchpad, not `data/`.** `--out` writes one PNG and
   touches nothing else; `--preview <dir>` adds a 6× copy on grass that you can
   open with the Read tool to check the result:

   ```sh
   bun run generate:figure --out "$SCRATCH/baker.png" --preview "$SCRATCH" \
     --hair bob --hair-colour fbb954 --shirt ffffff --legs robe --legs-colour cf657f \
     --print-look
   ```

   `--print-look` prints the resolved look as JSON, which you can pass back with
   `--look '<json>'` (or a file path) and adjust with flags.

2. **Look at the preview before going further.** At 16px a figure reads through
   value contrast between its parts, not through detail:
   - Keep hair, shirt and legs clearly lighter or darker than each other.
     A dark shirt, dark legs and dark hair merge into one shape.
   - Hair in `#45293f`, `#3e3546` or `#313638` is nearly the outline colour, and
     the head reads as a hole. Pick a brown (`6e2727`, `9e4539`) instead.
   - A cloak covers most of the figure from behind, and a `hooded` one covers the
     hair. The cloak colour is the main colour of the whole character.
   - Skin close to the shirt or cloak colour loses the hands and face.

3. **Save it for real.** `--name <name>` writes
   `data/tilesets/<slug>.png` and adds or replaces the entry in
   `data/tilesets.json`. `--tile <id>` also moves that tile's anchor onto the new
   sheet in `data/tiles.json`:

   ```sh
   bun run generate:figure --name Baker --look "$SCRATCH/baker.json" --tile pie-maker
   ```

   The script refuses `--tile` for a tile whose frames don't fit the player's
   block (a wolf, a deer, a rat), and checks this before it writes anything.
   Check the diff: `data/tiles.json` should change by one line.

4. **Several at once:** `--batch <file.json>` takes an array. Each entry is saved
   as `--name` would save it. `look` is partial and overlays the default, or a
   random look when `random` is set:

   ```json
   [
     { "name": "Guard", "tile": "blacksmith", "look": { "shirt": "#484a77", "cloak": { "style": "cape", "colour": "#ae2334" } } },
     { "name": "Stranger", "random": true, "seed": 3, "look": { "cloak": { "style": "hooded" } } }
   ]
   ```

   `--random --seed <n>` does the same for a single sheet. The same seed always
   gives the same look.

## What writing to `data/` does and does not do

- `data/` is authored content, copied into the store on deploy. A world that is
  already running prefers its own checkpoint, so a new sheet or anchor is not
  visible in a live world until content is redeployed (see `CLAUDE.md`).
  `/admin/play` reads content from the dev server, so it shows the new sheet on
  its next load.
- A new sheet is a new tileset. `people.png` and the `bun run generate:npcs`
  recolours (`townsfolk.png`, `smith.png`, `armourer.png`) are separate and stay
  as they are.
- Don't leave trial sheets in `data/tilesets/`. Draft with `--out`, and
  `git checkout data && git clean -f data/tilesets` if a trial went there.

## Changing the figure itself

The body is in `app/lib/figure.ts`: `BODY` holds the joint heights and widths in
screen pixels, `POSES` the walk, and `addHair` / `addCloak` the styles. A new
style is a new entry in `HAIR_STYLES`, `CLOAK_STYLES` or `LOWER_STYLES` plus its
shapes. `docs/notes.md`, "A townsperson is a 3D figure drawn through the game's
projection", explains the rendering and why the proportions are what they are.

After a change:

1. Render a few looks with `--preview`, and compare them side by side with the
   player's block (the top-left 48×64 of `data/tilesets/people.png`) at the same
   zoom. Every facing and both steps should still read as a person.
2. Run `bun run test:unit -- app/lib/figure.test.ts`. It checks that the output
   stays in the palette, stands on its foot cell, draws every facing and step
   differently, and that every hair, cloak and legs style shows from at least one
   facing. A style whose shapes have a sign error renders nothing, and that last
   test catches it.
3. Run `bun run format` and `bun run lint`.
