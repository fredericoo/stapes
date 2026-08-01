# Stapes Map Builder

Mini Tibia-inspired tile/map editor. Each tile is 8×8 pixels, rendered with an oblique cabinet projection in Three.js.

## Setup

```bash
pnpm install
pnpm generate   # seed tilesets + demo map into data/
pnpm dev
```

Open http://localhost:5173 — redirects to `/map`. Tile database lives at `/tiles`.

## Scripts

- `pnpm dev` — React Router SSR dev server
- `pnpm generate` — regenerate placeholder tileset + seed JSON
- `pnpm typecheck` — typegen + tsc
- `pnpm build` / `pnpm start` — production

## Data

Persisted on disk under `data/`:

- `tilesets/*.png` + `tilesets.json`
- `tiles.json` — tile definitions
- `map.json` — sparse stacked map (levels -8..+8)

Map edits are in-memory until you hit **Save** (or Cmd/Ctrl+S). Tile DB edits save immediately via route actions.
