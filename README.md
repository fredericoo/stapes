# Stapes Map Builder

Mini Tibia-inspired tile/map editor. Each tile is 8×8 pixels, rendered with an oblique cabinet projection in Three.js.

## Setup

```bash
bun install
bun run generate   # regenerate tilesets + demo map into data/
bun dev
```

Open http://localhost:5173 — redirects to `/online`. Tile database lives at `/tiles`.
Weapons and creatures are balanced at `/arena`, which fights two of them without
a world in the way.

## Scripts

- `bun dev` — both halves at once: Vite for the client, `bun --watch` for the
  server, on ports it asks the OS for so several worktrees can run together.
  Prints both URLs; open the client one
- `bun run generate` — regenerate placeholder tileset + seed JSON in `data/`
- `bun run seed` — load `data/` into a database that already has content. Rarely
  needed: a fresh one seeds itself on boot
- `bun run typecheck` — route typegen, then all three tsconfigs
- `bun run test:unit` — `app/` logic, in vitest
- `bun run test:server` — the world, on Bun, against a real database file
- `bun run test:perf` — renderer budgets, in Playwright
- `bun run build` — the client bundle, which CI pushes to the bucket

Deploying is in [SETUP.md](SETUP.md).

## Multiplayer

`/online` joins a shared world held by a Durable Object. Everyone spawns where
the map's `player` tile is placed; you appear to each other as tiles and can
push the same objects. Closing the tab removes your tile.

Identity is a random id in an `HttpOnly` cookie — enough to give you your avatar
back on reload, and deliberately not a login. The socket handshake sends it, so
the server never trusts a client-supplied id.

Saving in `/map` writes the map and restarts the world: everyone re-enters a
fresh game on the new map.

Deploying the server also restarts the world, and that is announced: the page
shows that the world is updating, and puts you back where you were standing a
couple of seconds later. Deploying the *client* restarts nothing — CI posts the
build to the running server, which stores it beside the world and flips a
pointer. Nobody is disconnected, and a later server deploy does not undo it.

Two tabs in one browser share the cookie and are therefore the *same* player.
To test two players locally, open one on `localhost` and one on `127.0.0.1` —
different hosts, different cookie jars.

## Data

Authored content is:

- `tilesets/*.png` + `tilesets.json`
- `tiles.json` — tile definitions
- `map.json` — sparse stacked map (levels -8..+8)

It has two homes behind one interface (`app/lib/storage.server.ts`):

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

Map edits are in-memory until you hit **Save** (or Cmd/Ctrl+S). Tile DB edits
save immediately.

`serializeMap` round-trips byte-for-byte, so saving an unmodified map leaves
`git status` clean rather than reformatting the file.

## TypeScript

Three configs, because the code spans three places:

- `tsconfig.json` — `app/`, typed for a browser tab. No Node types
- `tsconfig.server.json` — `server/`, plus the modules it shares with `app/`
- `tsconfig.node.json` — `scripts/`, `e2e/` and the `*.config.ts` files

They differ only in what they include and which globals they admit; the
strictness settings are the same in all three, so a module shared between
`app/` and `server/` cannot be stricter in one than in the other. Beyond
`strict`, the ones worth knowing about:

- **`noUncheckedIndexedAccess`** — `array[i]` is `T | undefined`. Most of the
  hits are provably in-range reads of a typed array inside a bounds-checked
  loop, and those are written `grid[i]!`; the point is that the ones that are
  *not* provable now have to say so.
- **`module: "preserve"`** — nothing here is compiled by `tsc`. Vite compiles
  the app and Bun runs the server as written, `.ts` extensions and all, and
  `preserve` is the setting that describes that instead of pretending to emit.
- **`isolatedModules`, `verbatimModuleSyntax`, `moduleDetection: "force"`** —
  everything the bundler and Bun already assume: one file at a time, imports
  left exactly as typed, and no file quietly being a script.

## Third-party assets

- **NF Pixels** by Steve Gigou, in `public/fonts/` under the SIL Open Font
  License 1.1 — the licence sits beside it, which is what the OFL asks for.
  Subset to printable ASCII. It draws the names, speech and damage over the
  world, in the DOM rather than in the canvas, and it is used at **multiples of
  10px**: its em is 10 design pixels, so those are the sizes that put every
  stroke on a whole pixel. IBM Plex Mono, loaded from Google in `app/root.tsx`,
  is the separate typeface the editor's chrome is set in.
