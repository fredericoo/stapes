# Stapes Map Builder

Mini Tibia-inspired tile/map editor. Each tile is 8×8 pixels, rendered with an oblique cabinet projection in Three.js.

## Setup

```bash
pnpm install
pnpm generate   # regenerate tilesets + demo map into data/
pnpm seed       # upload data/ into the local R2 bucket
pnpm dev
```

Open http://localhost:5173 — redirects to `/map`. Tile database lives at `/tiles`.

`pnpm seed` is required once per environment: the app reads from R2, and a fresh
bucket is empty. Without it every page loads blank.

## Scripts

- `pnpm dev` — React Router SSR dev server, running in workerd via the Cloudflare Vite plugin
- `pnpm generate` — regenerate placeholder tileset + seed JSON in `data/`
- `pnpm seed` — upload `data/` into the local R2 bucket (`--remote` for the deployed one)
- `pnpm typecheck` — route typegen + `wrangler types` + tsc, for both tsconfigs
- `pnpm build` / `pnpm deploy` — production build and deploy to Cloudflare Workers

## Data

Runs on Cloudflare Workers. Authored content lives in the `DATA` R2 bucket, at
keys mirroring the repo's `data/` directory:

- `tilesets/*.png` + `tilesets.json`
- `tiles.json` — tile definitions
- `map.json` — sparse stacked map (levels -8..+8)

`data/` in the repo is the seed for that bucket, not the live source; the app
never reads the filesystem. Access goes through `app/lib/storage.server.ts`.

Map edits are in-memory until you hit **Save** (or Cmd/Ctrl+S). Tile DB edits save immediately via route actions.

## TypeScript

Two configs, because the codebase spans two runtimes:

- `tsconfig.json` — `app/` and `workers/`, typed for workerd. Deliberately has no
  Node types, so a `node:` import here fails to typecheck rather than on deploy.
- `tsconfig.node.json` — `scripts/`, `e2e/` and the `*.config.ts` files, which do
  run in Node.
