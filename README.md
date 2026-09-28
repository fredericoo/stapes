# The Last Stones

A multiplayer tile game, and the editors that make its world. Each tile is 8×8
pixels, drawn in an oblique cabinet projection with Three.js. One Bun process
holds the world (`server/`); the client is a static bundle that runs in the tab
(`app/`).

## Setup

```bash
bun install
bun dev
```

`bun dev` prints two URLs; open the client one. `/` is the landing page. The
game is at `/online`, behind two doors: an account (`/sign-in`), then which of
its characters to play (`/characters`). The socket opens on the second one.
`/guest` skips both: it takes a character name and signs the browser in to a
guest account holding that character, which can be saved to a real account from
the in-game menu.

The world, its accounts and its characters live in `.dev/stapes.db`, inside the
checkout, so every worktree has its own. `rm -rf .dev` deletes all three, and
the next `bun dev` starts again from `data/` with only the seeded administrator.

## Signing in

**Every `/admin` page but `/admin/sign-in` needs an `ADMIN` account**,
`/admin/play` included.
A fresh database seeds one: its username and password are
`SEEDED_ADMIN_USERNAME` and `SEEDED_ADMIN_PASSWORD` in `server/auth.ts`. Sign in
with them at `/admin/sign-in`, or at `/sign-in` to play as that account.

**Agents sign in with the seeded account too.** An agent driving a local world
in a browser can type those two values into `/admin/sign-in`, or post them to
`/api/auth/sign-in/username` the way `signInAsAdmin` in `e2e/accounts.ts` does.
Both values are in this repository and so known to everybody, which is why
SETUP.md has you change the password on a deployment before anything else.

Nothing else grants the role. To promote somebody, stop the server — it holds
the database file exclusively — and say so in the database:

```sql
UPDATE user SET role = 'ADMIN' WHERE username = 'someone';
```

Session cookies are signed with `AUTH_SECRET` when it is set, and otherwise with
a secret the server generates on its first boot and keeps in its own database,
so accounts need no configuration. See [SETUP.md](SETUP.md).

## Pages

- `/` — the landing page, prerendered at build time
- `/online` — the shared world, reached through `/sign-in` or `/sign-up`, then
  `/characters` or `/characters/new`. `/account/password` is reached from the
  character chooser
- `/admin/map` — the map editor, which `/admin` opens on
- `/admin/tiles` and `/admin/statuses` — the tile and status catalogues
- `/admin/voxel` — builds a sprite out of voxels and exports it as a tileset
- `/admin/townsfolk` — draws a walking character sheet from paper-doll parts
  cut from the player, dressed in the colours, hair and cloak you pick
- `/admin/arena` — two fighters without a world in the way, for balancing
- `/admin/play` — the game with the world running in the tab
- `/admin/actions` — acting on the running world: **Close world**, for
  maintenance
- `/admin/sign-in` — the one `/admin` page that does not ask for the role

**`/admin/play` is the game with the world running in the tab** — the real
`GameServer` in a worker, the real protocol, and no socket. It is the path to
open when the question is whether the game still works. One world per tab, kept
in IndexedDB between visits, with a Reset world button where the shared world
has `POST /api/reset`.

It needs no character, but it does need the `ADMIN` sign-in, and `bun dev`
running: the worker reads the map and the catalogues over `/api`, and
`GET /api/map` answers only an administrator's session. See `docs/notes.md`,
"`/admin/play` runs the server in the tab".

Both play pages put `window.__stapes` on the page, for a script or an agent to
drive the game over the DevTools protocol: run a chat command and get its answer,
act as the player, read the world and what just happened, and wait until the
picture is ready to screenshot. `docs/notes.md`, "`window.__stapes` is the page
an agent drives", lists every call.

## Scripts

- `bun dev` — both halves at once: Vite for the client, `bun --watch` for the
  server, on ports it asks the OS for so several worktrees can run together.
  `STAPES_CLIENT_PORT` and `STAPES_SERVER_PORT` pin them. Prints both URLs; open
  the client one
- `bun run start` — the server alone, which is what the Docker image runs
- `bun run build` — the client bundle, into `build/client`. Deploying uploads it
  to the running server, which switches to it once the new server is healthy
- `bun run test` — the three suites below, one after another
- `bun run test:unit` — `app/` logic, in vitest
- `bun run test:server` — the world and its accounts, on Bun, against a real
  database file
- `bun run test:perf` — the app in a real browser, in Playwright: renderer
  budgets, the landing page, the way in, the world in a tab, the phone controls
  and `window.__stapes`. It starts its own `bun dev` on ports 5174 and 5175 against
  the same `.dev/stapes.db` as yours, so stop your `bun dev` in that worktree
  first: only one process can hold the database. `CHROMIUM_PATH` overrides the
  browser it launches, for a machine whose installed Chromium is not the build
  this version of Playwright downloads
- `bun run typecheck` — route typegen, then all three tsconfigs
- `bun run lint` — oxlint, run under Bun so it can load the TypeScript plugin
  in `lint/plugin.ts`, whose `stapes/no-comments` rule rejects every comment
  but `/** */` blocks and directives. The built-in rules it turns off each have
  their reason in `docs/tooling.md`
- `bun run format` — oxfmt, configured in `.oxfmtrc.json`.
  `bun run format:check` is the same question without writing, which is what
  CI asks. Markdown is not formatted, and neither are `data/map.json` or
  `data/tiles.json`, whose writers own their shape — `docs/tooling.md` has a
  paragraph on each
- `bun run generate` — overwrite `data/tilesets.json`, `data/tiles.json`,
  `data/map.json` and `data/tilesets/basic.png` with an eight-by-eight test
  world. It replaces the authored world rather than adding to it, so it is not a
  setup step
- `bun run generate:complement` — paint the inverse of an autotile block into
  another block of the same sheet: each cell gets the source block's full cell
  wherever the source cell is transparent. Which blocks, on which sheet, is the `JOBS`
  list at the top of the script
- `bun run generate:water` — rebuild the water autotile from two masks: the wave
  frames in `scripts/wave-frames.png` and the green shapes in the `floors` sheet.
  Writes `data/tilesets/water.png` and the `water` tile's 47 slices together
- `bun run generate:low-roofs` — draw the low-pitch roof into the free right-hand
  side of `data/tilesets/roofs.png` and write its six tiles: `low-roof-<colour>`,
  an eave rising two units across its cell, and `low-roof-<colour>-ridge`, a
  one-unit ridge on the same pitch, in red, yellow and blue. Geometry drawn
  through the game's own projection, shaded with `roof-1`'s shingle pattern
- `bun run generate:respawn` — redraw `data/tilesets/respawn.png`, the two-frame
  marker the `respawn-point` tile wears. Geometry rather than pixel art, so the
  shape and its palette entries live in the script where a diff can read them
- `bun run generate:cave-wall` — redraw `data/tilesets/cave-wall.png` and the
  slices of the cave walls on it: `cave-wall`, rock whose face stands on the half
  line of its cell wherever it meets open ground, so a passage one cell wide
  shows a cell of floor, and `cave-wall-sloped`, the same outline at the ceiling
  widening to the cell's edge at the floor, each in red rock and in grey
  (`cave-wall-grey`, `cave-wall-sloped-grey`). Every corner is rounded. Geometry
  too, drawn through the game's own projection; the variants, the shape rules
  and the palette entries are constants in the script
- `bun run generate:spinner` — render `public/crystal-spinner.gif`, the loading
  spinner: a crystal modelled in Three.js, rendered in headless Chromium and
  snapped to the logo's sixteen colours. Shape, light and timing are constants
  at the top of the script. `CHROMIUM_PATH` overrides the browser Playwright
  launches; `PREVIEW=<dir>` also writes a 4× copy there. One frame of the same
  crystal becomes `public/favicon.ico` (32 and 64 px) and
  `public/apple-touch-icon.png` (180 px, on the ink background)
- `bun run generate:npcs` — recolour the one humanoid in `people.png` into a
  sheet per NPC, so nobody in town is the player's twin. Writes
  `data/tilesets/townsfolk.png`, `smith.png`, `armourer.png` and `guard.png`
- `bun run generate:figure` — render a walking character sheet from the
  paper-doll parts in `app/lib/figureParts.json`, dressed by flags (`--hair bob
  --legs robe --cloak hooded …`), without a server. `--out` writes one PNG
  anywhere; `--name` saves it to `data/tilesets/` and registers it, and `--tile`
  moves a tile onto it; `--batch` takes a JSON list. `--help` lists every flag,
  and the `sprite-figures` skill is the workflow
- `bun run figure-parts` — edit those parts in a pixel editor: `export <dir>`
  writes every part as a PNG in three greys and the outline colour, and
  `import <dir>` reads edited ones back
- `bun run carve:caves` — carve a multi-floor cave system into `data/map.json`,
  then walk every cell of it with the game's own movement rules. What to carve
  is the `SYSTEM` block at the top of the script; `--verify` checks the map as
  it stands without touching it
- `bun run seed` — copy `data/` into the `blob` table of the database in
  `DATA_DIR`. The server has to be stopped, since it holds the file, and the
  world keeps its checkpoint. Rarely needed: every deploy already does this
  through `POST /api/seed`, which also rebuilds the world's board, and `bun dev`
  reads `data/` directly
- `bun run bench:server` — tick the world headless against `data/map.json`
  with players standing in a few scenarios, and print what a tick costs and
  how many bytes it puts on the wire. `--scenario <name>` for one,
  `--seconds <n>` for a shorter run, `--scale <n>` to put `n` of every resident
  on the map, each copy on a nearby cell with the same floor
- `bun run bench:crowd` — seat a crowd of walking players on a real
  `GameServer` against `data/map.json`, and print the tick rate the world
  keeps, what a tick costs and which parts of it cost that. `--players <n>`
  (1000), `--clustered` to seat everybody at the spawn, `--idle` to have
  nobody walk, `--deflate` to pay for compression too, `--sample <file>` to keep one player's frames,
  `--profile <file>` for a CPU profile of the measured window alone. It exits
  1 if the server refuses any of the players, since its figures are then for a
  smaller crowd. Run it with `BUN_OPTIONS=` empty if your shell sets `--smol`,
  which collects garbage far more often than production does. `docs/notes.md`,
  "A thousand players, profiled", has what it measured and how to compare runs
- `bun run bots --qty 10 --url thelaststones.com` — play `--qty` bots
  against the world at `--url` (`https://` is assumed when no scheme is
  given; the default is `http://localhost:3000`). Each signs in as a player,
  with a name from the game's name generator and an account created the first
  time, and plays the tutorial and then for gear: hunting, gathering, picking
  things up and trading with NPCs. With `OPENAI_API_KEY` set, a model
  (`gpt-5-nano`) also answers players who talk to them and can change their
  goals. They run in one process over worker
  threads; ten took about 70% of one core and 650 MB. `BOT_PASSWORD` sets the
  accounts' password, and `STAPES_ORIGIN` the origin they claim, which
  defaults to the URL. What they learn of where NPCs stand is kept in
  `BOT_MEMORY_DIR` (default `.dev/bots`), one SQLite file per world. A server started with `BOTS=n` (`bun dev`, `bun run
  start`) runs `n` of them itself. `docs/notes.md`, "A bot is a player in
  another process", has how it works
- `node scripts/record-hero.ts <client url>` — record the landing page's hero
  video, a walk through town with no interface, into
  `app/components/home/media/` as WebM, MP4 and a poster. Needs `bun dev`
  running and `ffmpeg` installed. Runs the page at a tenth of real time so
  software WebGL still gives a smooth video; the script says how
- `bun scripts/dump-quads.ts <x0> <x1> <y0> <y1> <zMin> <zMax>` — print, as
  JSON, the sprite quads the renderer would build for that box of cells in
  `data/map.json`, with their depth boxes, to work out draw order without a GPU.
  An optional seventh argument stacks extra tiles first, as
  `x,y,z,tileId[,direction]` separated by `;`. It re-derives the renderer's
  placement rather than calling it, so the two can disagree
- `bun scripts/anchor-tiles.ts` — a one-shot, already run: rewrote
  `data/tiles.json` into the anchored sprite encoding, where a tile names its
  sheet once and every rect is measured from `TileDef.anchor`. `--check` says
  what would change. `normalizeTileDef` still migrates the old encoding on load,
  so this only exists to keep the file readable
- `scripts/cap-previews.sh` and `scripts/prune-preview-volumes.sh` — run by cron
  on the preview server, not here. SETUP.md, "Previews, on their own box",
  installs them

Deploying is in [SETUP.md](SETUP.md).

## Multiplayer

`/online` is one world shared by everybody connected. A new character starts
where the map's `player` tile is placed, and a returning one where it left.
Players see each other and can push the same objects.

**Two words, kept apart everywhere.** You *sign in* and *sign out* of an
**account**; a **character** *enters* and *leaves* the world. An account holds
up to three characters, nobody else can play yours, and a character's name is
typed once and never changes.

Each of those is its own route, and each asks one question: `/sign-in`,
`/sign-up`, `/characters`, `/characters/new`, `/account/password`, and `/online`
for the world. They share one layout, which fetches the catalogues and decodes the
tilesets once per tab — while you are still typing — so splitting them up costs
nothing on the way in.

The account's own controls, Sign out and Change password, are reachable from the
character chooser and from nowhere else; the game's menu has neither. What it
has is **Leave world**: it closes the socket and puts the chooser back, leaving
the session alone, so coming back to that character is the same body standing
where you left it. It warns first only when you are in a fight, because a body
in a fight stays in the world, standing still, until it has gone a minute
without fighting — a swing, a hit or a harmful spell involving it — and for
fifteen minutes at most.

Which character you are is a query parameter on the socket, checked against the
signed session cookie — so naming somebody else's character is a refusal, not a
way into their body.

Deploying the server also restarts the world, and that is announced: the page
shows that the world is updating, and puts you back where you were standing a
couple of seconds later. Deploying the *client* restarts nothing — CI posts the
build to the running server, which stores it beside the world and flips a
pointer. Nobody is disconnected, and a later server deploy does not undo it.

Two tabs in one browser share the session, but not the character: which one a
tab is playing lives in its own `sessionStorage`, so two tabs can be two of your
three at once. Two tabs on the *same* character are the same player, and the
newest connection wins. To test two accounts locally, open one on `localhost`
and one on `127.0.0.1` — different hosts, different cookie jars.

## Data

Authored content is `data/`:

- `tilesets/*.png` + `tilesets.json`
- `tiles.json` — tile definitions
- `statuses.json` — status definitions
- `map.json` — sparse stacked map (levels -8..+8)

It has two homes behind one interface (`app/lib/dataStore.ts`):

- **In dev, `data/` on disk is the source of truth.** A tileset edited in an
  external tool is live on the next request, and the editors write straight
  back to it — the map, the tiles, the statuses and the tilesets alike — so
  changes show up in `git diff` and stay reviewable.
- **Deployed, the `blob` table** in `stapes.db`, at keys mirroring the same
  paths. A fresh deployment fills it from the `data/` in its image on first
  boot, and every deploy copies that `data/` over it again with
  `POST /api/seed`.

Map edits are in-memory until you hit **Save** (or Cmd/Ctrl+S). Tile and status
edits save immediately.

`serializeMap` round-trips byte-for-byte, so saving an unmodified map leaves
`git status` clean rather than reformatting the file.

**The world people are in is a third source of truth.** It prefers its own
checkpoint to the authored content, and carries each player's kit, tags,
masteries, statuses and health across a change of map. Three things replace its
board with the authored map:

- **Every deploy**, through `POST /api/seed`. Players stay where they are
  standing. The map, tiles, statuses and tilesets saved in a deployed editor
  since the last deploy are overwritten by `data/`, so an edit made there lasts
  until the next deploy unless it is committed too.
- **Save in `/admin/map`.** Players in the world go back to the spawn; a
  character that was away comes back near where it left.
- **`POST /api/reset`**, with the `ADMIN_SECRET` bearer token, which also
  destroys every position, kit, reward and mastery.

To keep players out without a deploy — for a fix, a reset, or an alpha that is
only open some hours — use maintenance mode: `POST /api/maintenance` with the
`ADMIN_SECRET` bearer token, or **Close world** at `/admin/actions` for an
`ADMIN` account. Administrators can still enter. See [SETUP.md](SETUP.md).

Accounts and characters are a fourth, and none of the above touches them. They
are their own tables rather than keys in the world's checkpoint, so a reset
hands everybody a fresh body under the name they already have.

A deployment keeps all of this in one directory on one volume: `stapes.db` and
its write-ahead log, plus `clients/`, the last few client builds.
`POST /api/backup` snapshots the database into `BACKUP_DIR`, and every deploy
calls it before replacing the server.

## TypeScript

Three configs, because the code spans three places:

- `tsconfig.json` — `app/`, typed for a browser tab. No Node types
- `tsconfig.server.json` — `server/`, plus the modules it shares with `app/`
- `tsconfig.node.json` — `scripts/`, `e2e/`, `lint/` and the `*.config.ts` files

## Third-party assets

- **NF Pixels** by Steve Gigou, in `public/fonts/` under the SIL Open Font
  License 1.1 — the licence sits beside it, which is what the OFL asks for.
  Subset to printable ASCII. It draws the names, speech and damage over the
  world, in the DOM rather than in the canvas, and it is used at **multiples of
  10px**: its em is 10 design pixels, so those are the sizes that put every
  stroke on a whole pixel. IBM Plex Mono, loaded from Google in `app/root.tsx`,
  is the separate typeface the editor's chrome is set in.
