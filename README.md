# The Last Stones

Mini Tibia-inspired tile/map editor. Each tile is 8×8 pixels, rendered with an oblique cabinet projection in Three.js.

## Setup

```bash
bun install
bun run generate   # regenerate tilesets + demo map into data/
bun dev
```

Open the client URL `bun dev` prints — the game, behind two doors: an account
(`/sign-in`), then which of its characters to play (`/characters`). The socket
opens on the second one.

The authoring tools are all under `/admin`, which opens on the map editor: the
tile database is at `/admin/tiles`, and `/admin/arena` balances two fighters
without a world in the way. **They need an `ADMIN` account.** A fresh database
seeds one — username `admin`, password `salem123` — and nothing else grants the
role: to promote somebody, say so in the database.

```sql
UPDATE user SET role = 'ADMIN' WHERE username = 'someone';
```

A deployment needs nothing new: session cookies are signed with `AUTH_SECRET`
when it is set, and with a secret the server generates on its first boot and
keeps in its own database when it is not. See [SETUP.md](SETUP.md).

`/admin/play` is the same game with the world running in the tab — the real
`GameServer` in a worker, the real protocol, no socket and nothing to log in to.
It is the path to open when the question is whether the game still works.

## Scripts

- `bun dev` — both halves at once: Vite for the client, `bun --watch` for the
  server, on ports it asks the OS for so several worktrees can run together.
  Prints both URLs; open the client one
- `bun run generate` — regenerate placeholder tileset + seed JSON in `data/`
- `bun run generate:water` — rebuild the water autotile from two masks: the wave
  frames in `scripts/wave-frames.png` and the green shapes in the `floors` sheet.
  Writes `data/tilesets/water.png` and the `water` tile's 47 slices together
- `bun run generate:respawn` — redraw `data/tilesets/respawn.png`, the two-frame
  marker the `respawn-point` tile wears. Geometry rather than pixel art, so the
  shape and its palette entries live in the script where a diff can read them
- `bun run generate:spinner` — render `public/crystal-spinner.gif`, the loading
  spinner: a crystal modelled in Three.js, rendered in headless Chromium and
  snapped to the logo's sixteen colours. Shape, light and timing are constants
  at the top of the script. `CHROMIUM_PATH` overrides the browser Playwright
  launches; `PREVIEW=<dir>` also writes a 4× copy there
- `bun run generate:npcs` — recolour the one humanoid in `people.png` into a
  sheet per NPC, so nobody in town is the player's twin. Writes
  `data/tilesets/townsfolk.png`, `smith.png` and `armourer.png`
- `bun run carve:caves` — carve a multi-floor cave system into `data/map.json`,
  then walk every cell of it with the game's own movement rules. What to carve
  is the `SYSTEM` block at the top of the script; `--verify` checks the map as
  it stands without touching it
- `bun run bench:server` — tick the world headless against `data/map.json`
  with players standing in a few scenarios, and print what a tick costs and
  how many bytes it puts on the wire. `--scenario <name>` for one,
  `--seconds <n>` for a shorter run
- `node scripts/record-hero.ts <client url>` — record the landing page's hero
  video, a walk through town with no interface, into `public/home/` as WebM,
  MP4 and a poster. Needs `bun dev` running and `ffmpeg` installed. Runs the page
  at a tenth of real time so software WebGL still gives a smooth video; the
  script says how
- `bun scripts/anchor-tiles.ts` — a one-shot, already run: rewrote
  `data/tiles.json` into the anchored sprite encoding, where a tile names its
  sheet once and every rect is measured from `TileDef.anchor`. `--check` says
  what would change. `normalizeTileDef` still migrates the old encoding on load,
  so this only exists to keep the file readable
- `bun run seed` — load `data/` into a database that already has content. Rarely
  needed: a fresh one seeds itself on boot
- `bun run lint` — oxlint. Four rules are off and `.oxlintrc.json` says why
  each one is wrong about this codebase rather than inconvenient
- `bun run format` — oxfmt, at a print width of 100. `bun run format:check`
  is the same question without writing, which is what CI asks. Markdown is not
  formatted, and neither are `data/map.json` or `data/tiles.json`, whose
  writers own their shape — `.oxfmtrc.json` has a paragraph on each
- `bun run typecheck` — route typegen, then all three tsconfigs
- `bun run test:unit` — `app/` logic, in vitest
- `bun run test:server` — the world and its accounts, on Bun, against a real
  database file
- `bun run test:perf` — the app in a real browser, in Playwright: renderer
  budgets, the way in, and the world in a tab
- `bun run build` — the client bundle, which CI pushes to the bucket

Deploying is in [SETUP.md](SETUP.md).

## Multiplayer

`/` joins a shared world. Everyone spawns where the map's `player` tile is
placed; you appear to each other as tiles and can push the same objects.
Closing the tab removes your tile.

**Two words, kept apart everywhere.** You *sign in* and *sign out* of an
**account**; a **character** *enters* and *leaves* the world. An account holds
up to three characters, nobody else can play yours, and a character's name is
typed once and never changes.

Each of those is its own route, and each asks one question: `/sign-in`,
`/sign-up`, `/characters`, `/characters/new`, `/account/password`, and `/` for
the world. They share one layout, which fetches the catalogues and decodes the
tilesets once per tab — while you are still typing — so splitting them up costs
nothing on the way in.

The account's own controls, Sign out and Change password, are reachable from the
character chooser and from nowhere else; the game's menu has neither. What it
has is **Leave world**, beside the lighting switch: it closes the socket and
puts the chooser back, leaving the session alone, so coming back to that
character is the same body standing where you left it. It warns first only when
you are in a fight, because a body in combat stays on the board for a minute
after its socket goes.

Which character you are is a query parameter on the socket, checked against the
signed session cookie — so naming somebody else's character is a refusal, not a
way into their body.

Saving in `/admin/map` writes the map and restarts the world: everyone re-enters a
fresh game on the new map.

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

**`/admin/play` is the same page against a world in the tab.** One world per
tab, kept in IndexedDB between visits, with a Reset world button where the
shared world has `POST /api/reset`. It reads the map and the catalogues over
`/api` like every other page, so it still wants `bun dev` — what it does not
want is a socket, an account or anything to sign in to. See `docs/notes.md`,
"`/admin/play` runs the server in the tab".

## Data

Authored content is:

- `tilesets/*.png` + `tilesets.json`
- `tiles.json` — tile definitions
- `map.json` — sparse stacked map (levels -8..+8)

It has two homes behind one interface (`app/lib/dataStore.ts`):

- **In dev, `data/` on disk is the source of truth.** A tileset edited in an
  external tool is live on the next request, and the map editor's Save writes
  `data/map.json` — so changes show up in `git diff` and stay reviewable.
- **Deployed, the `blob` table** in `stapes.db`, at keys mirroring the same
  paths. A fresh deployment fills it from the `data/` in its image on first
  boot, so there is nothing to seed by hand.

The whole of a deployment is one directory on one volume: `stapes.db` and its
write-ahead log, plus `clients/` holding the last few client builds. That is
everything worth backing up, and it is what `POST /api/backup` snapshots.

There is a third source of truth that seeding cannot reach: the world people are
actually in. It prefers its own checkpoint to the authored content, so a seeded
map changes nothing anybody can see, and it deliberately carries each player's
kit, tags and masteries across a save. `POST /api/reset` is the way out — it
destroys every position, kit, reward and mastery, and needs `ADMIN_SECRET`.

To keep players out without a deploy — for a fix, a reset, or an alpha that is
only open some hours — use maintenance mode: `POST /api/maintenance` with the
`ADMIN_SECRET` bearer token, or **Close world** at `/admin/actions` for an
`ADMIN` account. Administrators can still enter. See [SETUP.md](SETUP.md).

Accounts and characters are a fourth, and none of the above touches them. They
are their own tables rather than keys in the world's checkpoint, so a reset
hands everybody a fresh body under the name they already have.

Map edits are in-memory until you hit **Save** (or Cmd/Ctrl+S). Tile DB edits
save immediately.

`serializeMap` round-trips byte-for-byte, so saving an unmodified map leaves
`git status` clean rather than reformatting the file.

## TypeScript

Three configs, because the code spans three places:

- `tsconfig.json` — `app/`, typed for a browser tab. No Node types
- `tsconfig.server.json` — `server/`, plus the modules it shares with `app/`
- `tsconfig.node.json` — `scripts/`, `e2e/` and the `*.config.ts` files

## Third-party assets

- **NF Pixels** by Steve Gigou, in `public/fonts/` under the SIL Open Font
  License 1.1 — the licence sits beside it, which is what the OFL asks for.
  Subset to printable ASCII. It draws the names, speech and damage over the
  world, in the DOM rather than in the canvas, and it is used at **multiples of
  10px**: its em is 10 design pixels, so those are the sizes that put every
  stroke on a whole pixel. IBM Plex Mono, loaded from Google in `app/root.tsx`,
  is the separate typeface the editor's chrome is set in.
