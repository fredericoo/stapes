# Stapes Map Builder

Mini Tibia-inspired tile/map editor. Each tile is 8×8 pixels, rendered with an oblique cabinet projection in Three.js.

## Setup

```bash
pnpm install
pnpm generate   # regenerate tilesets + demo map into data/
pnpm dev
```

Open http://localhost:5173 — redirects to `/map`. Tile database lives at `/tiles`.

## Scripts

- `pnpm dev` — dev server, reading and writing `data/` on disk. Runs everything
  including `/online`, with HMR
- `pnpm dev:r2` — same, but against the local R2 bucket (needs `pnpm seed` first)
- `pnpm dev:worker` — build and run real workerd, with `data/` still on disk.
  For production fidelity — real Durable Object hibernation, checkpointing and
  eviction. No HMR, since it serves a build
- `pnpm generate` — regenerate placeholder tileset + seed JSON in `data/`
- `pnpm seed` — upload `data/` into the local R2 bucket (`--remote` for the deployed one)
- `pnpm reset` — seed, then wipe the running world so it reloads from the seed.
  Destroys every position, kit, reward and mastery. Needs `RESET_SECRET`
- `pnpm typecheck` — route typegen + `wrangler types` + tsc, for both tsconfigs
- `pnpm test:unit` — `app/` logic, node pool
- `pnpm test:workers` — `workers/` inside workerd, with real Durable Object storage
- `pnpm build` / `pnpm deploy` — production build and deploy to Cloudflare Workers

## Multiplayer

`/online` joins a shared world held by a Durable Object. Everyone spawns where
the map's `player` tile is placed; you appear to each other as tiles and can
push the same objects. Closing the tab removes your tile.

Identity is a random id in an `HttpOnly` cookie — enough to give you your avatar
back on reload, and deliberately not a login. The socket handshake sends it, so
the server never trusts a client-supplied id.

Saving in `/map` writes the map and restarts the world: everyone re-enters a
fresh game on the new map.

Two tabs in one browser share the cookie and are therefore the *same* player.
To test two players locally, open one on `localhost` and one on `127.0.0.1` —
different hosts, different cookie jars.

## Data

Authored content is:

- `tilesets/*.png` + `tilesets.json`
- `tiles.json` — tile definitions
- `map.json` — sparse stacked map (levels -8..+8)

It has two homes, behind one interface (`app/lib/storage.server.ts`):

- **In dev, `data/` on disk is the source of truth.** A tileset edited in an
  external tool is live on the next request, and the map editor's Save writes
  `data/map.json` — so changes show up in `git diff` and stay reviewable. The
  Worker has no filesystem, so it reaches the directory through a dev-only Vite
  middleware (`vite.config.ts`).
- **In production, the `DATA` R2 bucket**, at keys mirroring the same paths.
  `pnpm seed` uploads `data/` into it; a fresh bucket is empty and every page
  loads blank until that runs.

`pnpm dev:r2` runs dev against R2 instead, for when you want to exercise that
path locally.

There is a third source of truth that seeding cannot reach: the Durable Object
holding the world people are actually in. It prefers its own checkpoint to the
bucket, so a seeded map changes nothing anybody can see, and it deliberately
carries each player's kit, tags and masteries across a save. `pnpm reset` is the
way out — it seeds and then tells the deployment to forget everything. It needs
`RESET_SECRET`, the secret that deployment was given with `wrangler secret put`;
without one set, the endpoint is not there at all.

Map edits are in-memory until you hit **Save** (or Cmd/Ctrl+S). Tile DB edits save immediately via route actions.

`serializeMap` round-trips byte-for-byte, so saving an unmodified map leaves
`git status` clean rather than reformatting the file.

## TypeScript

Two configs, because the codebase spans two runtimes:

- `tsconfig.json` — `app/` and `workers/`, typed for workerd. Deliberately has no
  Node types, so a `node:` import here fails to typecheck rather than on deploy.
- `tsconfig.node.json` — `scripts/`, `e2e/` and the `*.config.ts` files, which do
  run in Node.

## Third-party assets

- **NF Pixels** by Steve Gigou, in `public/fonts/` under the SIL Open Font
  License 1.1 — the licence sits beside it, which is what the OFL asks for.
  Subset to printable ASCII. It draws the names, speech and damage over the
  world, in the DOM rather than in the canvas, and it is used at **multiples of
  10px**: its em is 10 design pixels, so those are the sizes that put every
  stroke on a whole pixel. IBM Plex Mono, loaded from Google in `app/root.tsx`,
  is the separate typeface the editor's chrome is set in.
