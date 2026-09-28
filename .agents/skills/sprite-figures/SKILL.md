---
name: sprite-figures
description: >
  Generates walking character sprite sheets (townsfolk, NPCs, outfits) by
  recolouring and stacking paper-doll parts cut from the player in people.png,
  from the command line with `bun run generate:figure` — no dev server needed.
  Use when asked to make, dress, recolour or add a townsperson, NPC, villager or
  character sprite, to give a tile a new look, or when adding or editing a part
  (a hair style, a cloak, an outfit piece).
---

# Generating character sprites

A character sheet here is a 48×64 PNG laid out like the player's block in
`data/tilesets/people.png`: rows face **south, east, west, north**; columns are
**step, stand, step**; each frame is 16×16 (2×2 cells) with its base at (1, 1).
`app/lib/figure.ts` builds one by stacking parts from `app/lib/figureParts.json`
(body, hair, shirt, trim, trousers, shoes, cloak…) and recolouring each, so any
tile that walks with the player's frames wears it by moving its `anchor` and
nothing else. Dressed in the player's own colours it draws the player exactly.

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
| Trim  | `--trim <hex>`                            | the collar and belt                    |
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

## Adding or editing a part

A part is a whole 48×64 sheet stored as text in `app/lib/figureParts.json`: 64
strings of 48 cells, `.` empty, `#` outline, `1` `2` `3` the shadow, base and
highlight of the colour the look gives that part. `PARTS` in
`app/lib/figure.ts` says which colour each part takes, its `z` in each facing
(higher is drawn later), and whether it is `outlined`. `partsFor` says which
parts a look uses. `docs/notes.md`, "A townsperson is paper-doll parts cut from
the player", explains why these choices were made.

To draw in a pixel editor instead of in text:

```sh
bun run figure-parts export "$SCRATCH/parts"   # one PNG per part: outline #2e222f and greys #595959 #a6a6a6 #e6e6e6
# edit, keeping to those four colours
bun run figure-parts import "$SCRATCH/parts"   # refuses any other colour
```

- **Draw against the body.** The head stays on the same pixels through a facing's
  three frames, so anything on the head (hair, a hat, a hood) is one mask per
  facing, repeated in all three columns. Anything that hangs (long hair, a
  ponytail, a cape's hem) runs down or down-right on screen, because height goes
  up and to the left in this projection.
- **Outlines.** A part marked `outlined: true` (every drawn part, and the
  boots) gets outline on every transparent pixel beside it, so draw only its
  colours. The body, shirt, trim and trousers carry the artist's own outline
  instead, which leaves some edges open on purpose.
- **A new style** is a new value in `HAIR_STYLES`, `CLOAK_STYLES` or
  `LOWER_STYLES`, a new id in `PART_IDS`, an entry in `PARTS`, a line in
  `partsFor`, and the part's rows in the JSON.
- The parts were first cut from `people.png` and have been hand-edited since;
  `figureParts.json` is the source of truth, and nothing regenerates it.

After a change:

1. Render a few looks with `--preview` and open them. Check every facing, and
   both steps if the part moves.
2. Run `bun run test:unit -- app/lib/figure.test.ts`. It checks that every part
   is 64 rows of 48 valid cells, that every boot pixel is outlined, that output
   stays in the palette, and that every style shows from at least one facing.
3. Run `bun run format` and `bun run lint`.
