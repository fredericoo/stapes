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

- `pnpm dev` — dev server, reading and writing `data/` on disk
- `pnpm dev:r2` — same, but against the local R2 bucket (needs `pnpm seed` first)
- `pnpm generate` — regenerate placeholder tileset + seed JSON in `data/`
- `pnpm seed` — upload `data/` into the local R2 bucket (`--remote` for the deployed one)
- `pnpm typecheck` — route typegen + `wrangler types` + tsc, for both tsconfigs
- `pnpm build` / `pnpm deploy` — production build and deploy to Cloudflare Workers

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

Map edits are in-memory until you hit **Save** (or Cmd/Ctrl+S). Tile DB edits save immediately via route actions.

`serializeMap` round-trips byte-for-byte, so saving an unmodified map leaves
`git status` clean rather than reformatting the file.

## TypeScript

Two configs, because the codebase spans two runtimes:

- `tsconfig.json` — `app/` and `workers/`, typed for workerd. Deliberately has no
  Node types, so a `node:` import here fails to typecheck rather than on deploy.
- `tsconfig.node.json` — `scripts/`, `e2e/` and the `*.config.ts` files, which do
  run in Node.
