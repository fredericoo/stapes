---
name: verify
description: >
  Use when you need to show that a change works in the game, not only that the
  tests pass. Says which `bun run verify` command goes with which kind of
  change, the checks that need no command, the traps already found, and how to
  hand the evidence over in a pull request.
---

# Showing that a change works

`bun run verify <command>` runs the game's own code on this checkout and prints
what it found. It is evidence for a pull request and needs no server, database
or account. CI runs one of the commands, `stranded`; nothing runs the others
unless you do. Every command
prints the commit it ran on, and says so when the tree has uncommitted changes.
`--json` prints exactly one JSON object on stdout; without it you get a short
table. `bun run verify --help` lists the commands, and
`bun run verify <command> --help` their options.

## Which command

| You changed | Run | It answers |
| --- | --- | --- |
| anything in `data/`: tiles, statuses, tilesets, the map | `bun run verify content` | Does every tile, status, brain and dialog load, and does every id they name exist? |
| `data/map.json`, or anything in how a body walks, climbs, drops or teleports | `bun run verify stranded` | Starting where a player starts, is there anywhere they can get to and not get back from? |
| combat numbers, a weapon, a creature's stats | `bun run verify battle <a> <b> --against main`, for example `bun run verify battle wolf player:sharp=15,agility=15,toughness=15,weapon=knights-sword --against main` | Who wins, how often and how fast, sampled over seeds beside the closed-form figures, and how far each figure moved from `main`? |

`verify content` exits 1 on an error in tiles, statuses or tilesets and prints
each finding with its file, the id and what is wrong. What it finds in
`data/map.json` is a warning and does not change the exit code. `--data <dir>`
checks a copy of the content directory instead, which is how to show that it
catches a fault: seed the fault into a copy and run it there.

`verify stranded` walks the map with `navigationLegs`, every leg a body can
take: steps, drops off a ledge, doors, ladders and portals. It exits 1 if any
cell that can be reached that way has no route back to the start, and lists
each such place with the legs that lead into it, which are the ledges to fix.
Creatures are taken off the board first. `--image <file.png>` also draws the
surface from above with every stranded cell in red, the cell each way in
leaves from in yellow and a red frame round each place. CI runs it, so a map edit that leaves
a pit with no way out fails the build and uploads that picture and the JSON
report as the `stranded` artifact; the fix is a ramp, a ladder or a gap in
whatever closes the place in.

`verify battle` fights through the Arena's own `Duel`, every seed both ways
round. A side is a battler tile id, or one with masteries and equipment by
slot: `player:sharp=15,agility=15,toughness=15,weapon=knights-sword`. By
default each body rolls its kit per seed, as the world does; `--kit none`
fights with only what you name, as the Arena does. The sampled time to kill
counts only the fights that side won, so it runs shorter than the closed form,
which is hit points over damage per second. To ask why a fight went the way it
did, `--trace <seed>` prints that one fight blow by blow. `--matrix` fights
every creature against a player at rungs 10, 15 and 33, which is the table to
show when a change could move more than one creature.

`--against <ref>` fights the same battles, on the same seeds, on another commit
in a temporary git worktree, and adds the change in each figure. That
comparison is the balance evidence a combat or content PR attaches. The ref
has to have `verify battle` itself; on an older one it says so and stops.

## Checks that need no command

- **Run the tests that own the files you touched**, by path, before the whole
  suite: `bunx vitest run app/game/duel.test.ts`, `bun test server/api.test.ts`.
- **Re-run a timing test on its own before calling it red.**
  `app/lib/lighting.perf.test.ts` has failed while the machine was busy and
  passed when run alone.
- **Show a new regression test failing on the base commit.** With the fix and
  the test committed, put the old code back
  (`git checkout origin/main -- <the file you fixed>`), run the test and see it
  fail for the reason it names, then restore the fix
  (`git checkout HEAD -- <the file you fixed>`). Say in the PR that you did.

## Traps already found

- **Brains need a player in the session.** `GameSession.tickBrains` does
  nothing unless the session holds a non-resident actor. A creature takes a
  turn every round only while a player is within its brain's reach; further
  away it dozes and takes a turn now and then. A script or test about creature
  behaviour has to put a player near the creature.
- **Frame times from headless Chromium measure SwiftShader**, a software
  rasteriser, not a GPU. Compare them only with other runs on the same machine.
- **No unit test reads `data/map.json`.** `AGENTS.md` says why and what to
  build instead. `verify content` reads it because its job is the content we
  ship.
- **A world lets in at most 250 players who are not administrators**
  (`MAX_ONLINE_PLAYERS`). A test with a larger crowd has to raise it the way
  `bench:crowd` does, with `GameServer`'s `maxOnlinePlayers` option.
- **Playwright in the cloud container** needs the browser named, because the
  one the repo's Playwright expects is not installed there:
  `CHROMIUM_PATH=/opt/pw-browsers/chromium bun run test:perf`, and the same
  for `bun run scene`.
- **A CSS animation in a headless screenshot of `/admin/play` is at its first
  keyframe.** The page draws so few frames under SwiftShader that an animation
  started 700ms earlier still reports `currentTime` 0, so anything that fades
  in is missing from the picture. Seek it before the shot:
  `el.getAnimations().forEach((a) => { a.pause(); a.currentTime = 300; })`.
- **A creature in `/admin/play` acts on its own.** It wanders off, turns, or
  kills the player before the screenshot. `/brain <body> off` stops it, and
  `/face <body> <n|e|s|w>` turns it; `/tile` and `/spawn` reply with the new
  body's id in `ids`. For a picture rather than behaviour, draw a scene
  instead (below).

## Looking at it

`bun dev` starts both halves and prints both URLs; open the client one. The
tools under `/admin` need an administrator: a fresh database seeds `admin` with
the password `salem123`. `/admin/play` is the game with the real `GameServer`
running in the tab, so it needs no socket and no character, and it is the page
to open when the question is whether the game still works.

### A picture of a renderer change: `bun run scene`

When the question is what something looks like (a sprite, a reflection, light,
draw order), do not go looking for the case in the real world. Write it:

```json
{
  "time": "12:00",
  "zoom": 6,
  "look": [4, 4],
  "cells": [
    { "from": [-2, -2], "to": [10, 10], "tiles": ["grass-2"] },
    { "from": [4, 4], "to": [9, 9], "tiles": ["dirt", "water"] },
    { "at": [3, 3], "tiles": ["grass-2", { "tile": "cyclops", "facing": "e" }] }
  ]
}
```

```sh
bun run scene scripts/scenes/cyclops-pond.json --out before.png
```

- **It is the real renderer and the real catalogue.** `/admin/scene` hands the
  scene to `WorldRenderer` with `data/tiles.json` and the tilesets, and no
  `GameServer`: nothing moves, nothing thinks, nobody dies. It waits for the
  light to bake before the shot.
- **Later entries replace earlier stacks**, so fill the ground with a `from`/`to`
  rectangle first and place things after. A stack is listed bottom first, as
  in `data/map.json`. `z` goes third in `at`, or as `z` beside `from`/`to`.
- **Before and after from one scene file.** Render it on the base commit and on
  the branch, with the same `--size`, and the only difference is the change.
  Keep a scene that shows something worth checking again in `scripts/scenes/`.
- **`"weather": "rain"` or `"fog"` draws the scene under that weather.** Fog is
  measured from the cell in `look`.
- **It takes about 20 seconds**, most of it starting `bun dev`. With `bun dev`
  already running, `--url <client origin>` skips that.
- **What it cannot show:** anything that needs the game running, such as a
  walk, a projectile, a status tint or a creature's state. Use `/admin/play`
  with `/brain off` and `/face` for those.

## Handing the evidence over

Write the description the way the `pull-request-standards` skill asks: why the
change exists first, then before and after, with screenshots or recordings of
anything visual, framed the same way. Paste the command you ran and the part of
its output that shows the change, including the commit line it printed.

In a cloud session nothing can be uploaded to GitHub, so a screenshot or a file
cannot go into the PR. Send it to the user instead, and say which PR it belongs
to.
