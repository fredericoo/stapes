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
what it found. It is evidence for a pull request, not a CI gate: nothing runs it
unless you do, and it needs no server, database or account. Every command
prints the commit it ran on, and says so when the tree has uncommitted changes.
`--json` prints exactly one JSON object on stdout; without it you get a short
table. `bun run verify --help` lists the commands, and
`bun run verify <command> --help` their options.

## Which command

| You changed | Run | It answers |
| --- | --- | --- |
| anything in `data/`: tiles, statuses, tilesets, the map | `bun run verify content` | Does every tile, status, brain and dialog load, and does every id they name exist? |
| combat numbers, a weapon, a creature's stats | `bun run verify battle <a> <b>` | Who wins, how often and how fast, sampled over seeds beside the closed-form figures? |

`verify content` exits 1 on an error in tiles, statuses or tilesets and prints
each finding with its file, the id and what is wrong. What it finds in
`data/map.json` is a warning and does not change the exit code. `--data <dir>`
checks a copy of the content directory instead, which is how to show that it
catches a fault: seed the fault into a copy and run it there.

`verify battle` fights through the Arena's own `Duel`, every seed both ways
round. A side is a battler tile id, or one with masteries and equipment by
slot: `player:sharp=15,agility=15,toughness=15,weapon=knights-sword`. By
default each body rolls its kit per seed, as the world does; `--kit none`
fights with only what you name, as the Arena does. The sampled time to kill
counts only the fights that side won, so it runs shorter than the closed form,
which is hit points over damage per second.

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
- **Playwright in the cloud container** needs the browser named:
  `CHROMIUM_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell bun run test:perf`.

## Looking at it

`bun dev` starts both halves and prints both URLs; open the client one. The
tools under `/admin` need an administrator: a fresh database seeds `admin` with
the password `salem123`. `/admin/play` is the game with the real `GameServer`
running in the tab, so it needs no socket and no character, and it is the page
to open when the question is whether the game still works.

## Handing the evidence over

Write the description the way the `pull-request-standards` skill asks: why the
change exists first, then before and after, with screenshots or recordings of
anything visual, framed the same way. Paste the command you ran and the part of
its output that shows the change, including the commit line it printed.

In a cloud session nothing can be uploaded to GitHub, so a screenshot or a file
cannot go into the PR. Send it to the user instead, and say which PR it belongs
to.
