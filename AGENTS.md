# Agent notes — Stapes

## Map mutations must be undoable

Every change to map data (`MapFile` / placed tiles) **must** go through `useEditorStore.getState().commitMap(...)` (or a store method that calls it: `eraseAt`, `stampAt`, `stampMany`, `appendArmed`, `removeFromStack`, `reorderSelectedStack`, `setStackDirection`).

- Do **not** assign `map` via `setState`, mutate stacks in place, or call `mapData` helpers and write the result into the store yourself.
- Discrete edits (backspace/delete, stack panel trash/reorder/direction, tile picker append, shape stamp) use plain `commitMap(next)` so each gets its own undo entry.
- Paint drags use `beginStroke` → `commitMap(next, { coalesceInStroke: true })` → `endStroke` so the whole drag is one undo step.
- If you add a new map-editing path, wire it through `commitMap` and confirm ⌘Z undoes it before considering the work done.

## Renderer and simulation performance

The game targets **120fps — an 8.3ms frame budget**, and the whole budget is
spent by the time you have done anything twice. Every rule below was written
after something in this list cost 2–150ms per frame in production code, so
treat them as load-bearing rather than stylistic.

Measure with the in-game counter first: the FPS chip in `/play` expands into a
per-phase breakdown (`app/render/frameProfile.ts`). It reports **p50 and worst**
per 500ms window. Read the worst. A 55ms hitch once every 200ms barely moves an
average, and that is exactly the shape of bug that reaches a player.

### Never sweep the map to answer a local question

This is the single most common way performance has been lost here. It has
happened in at least four independent places.

```ts
// The tell. If you are writing this outside a one-time index build, stop.
for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
  for (const [ck, stack] of Object.entries(level)) { ... }
}
```

Ask what the caller actually needs, then address exactly that region:

- Light bakes need the window plus `MAX_LIGHT_LEVEL` of apron
  (`app/lib/lightingChunks.ts`).
- A dynamic light needs its own radius, not the map
  (`overlayEmitterOverrides`).
- The roof-cut probe needs `VIEW_RADIUS` — **2.5 cells** — and was building
  world-wide occlusion to look at a 5×5 box.
- Finding the player is a cell lookup once you remember where they were
  (`playerStillAt`).

Iterate a rect and look cells up (`level[coordKey(x, y)]`), or iterate the
level's own keys. Do not filter the world down to the part you wanted.

The cost is invisible on today's ~5k-cell fixture map and fatal at the intended
size. The map is headed for thousands of cells square across 17 levels; anything
O(map) per frame is already broken, it just has not shown up yet.

### Exploit the persistent map

`MapFile` is copy-on-write (`setStacks` in `app/lib/mapData.ts`). Unchanged
levels and unchanged cell stacks keep object identity, which makes change
detection nearly free:

```ts
if (prev === next) return;                      // whole map unchanged
if (prev.levels[lz] === next.levels[lz]) continue;  // level unchanged
if (before?.[key] === after[key]) continue;     // cell unchanged
```

Do not hash map contents to detect changes. A per-frame content hash used to
cost ~1ms; the identity checks that replaced it cost nothing.

### A mutation that changes nothing must return the same object

Downstream, a new map object *is* an edit: it invalidates light chunks and
rebuilds level geometry. `setEntityDirection` rewrote the map every tick a
direction key was held, re-asserting a facing the player already had — that
alone put a full mesh rebuild on **20.8% of frames while walking**. Guard it:

```ts
if (current.direction === direction) return map;
```

Any new mutation helper needs the same no-op guard.

### Levels are chunked; keep it that way

`map.levels[z]` is `Record<chunkKey, Record<cellKey, PlacedTile[]>>`, not a flat
cell record. It was flat, and one populated floor held 4565 cells — so editing a
single tile copied all of them. Chunking bounds a copy-on-write edit to one
chunk (`CHUNK_SIZE` square) and took `moveEntity` from **1.13ms to 0.020ms**.

Two things follow, and both matter:

- **Go through the accessors** — `getStack`, `setStacks`, `listCoords`,
  `getChunk`, `listChunkKeys`. Reaching into `map.levels[zk][ck]` is now wrong
  (that index is a chunk, not a stack) and TypeScript will say so.
- **Change detection has three levels now**: map, level, *chunk*, then cell.
  Prefer the coarsest that answers your question — `syncTo` skips whole chunks
  by identity before it looks at a single cell.

The on-disk format stays flat, converted by `parseMap` / `serializeMap` via
`chunkifyMap` / `flattenMap`. Do not persist the chunked shape: the file is
hand-editable and version-controlled, and `flattenMap` deliberately emits cells
in a stable (x, y) order so a one-cell edit is a one-line diff.

Batch multi-cell edits through `setStacks` in one call so each chunk is copied
once — `moveEntity` touches two cells and does exactly that.

### Do not sweep for the player

`requireSinglePlayer` is a full map sweep. `GameSession` memoises it on map
identity, confirms the last-known cell first (`playerStillAt`), then searches
the immediate neighbourhood (`findPlayerNear`) before ever sweeping — a commit
moves the player one cell, never across the map. A single tick can rewrite the
map several times, and without this each rewrite cost a sweep: stepping onto a
pressure plate was **8.1ms, now 0.17ms**.

### Typed arrays, not string-keyed Maps, in hot loops

`Map<string, T>` keyed by `` `${z}:${x},${y}` `` means a string build plus a hash
lookup per probe. In a ray-cast inner loop that dominates everything else.
Build a flat `Float32Array`/`Uint8Array` indexed off the region
(`DenseOcclusion` in `app/lib/lighting.ts`) — it took the light overlay from
1.94ms to 0.63ms.

Same idea one level down: do not iterate an array of tuples in a hot loop.
`SKY_EDGES` was `[[dx,dy,dz,cost], ...]`; destructuring it per edge cost more
than the work it fed. Flattened into one `Float64Array` the sky flood went from
**~95ms to ~13ms** with byte-identical output.

### Per-pixel work belongs in the shader

The light texture is RGBA: block light in RGB, sky factor in alpha, tinted
against `uAmbient` in the fragment shader. Time of day is therefore a uniform
write. Doing that tint on the CPU meant recomposing and re-uploading 17 textures
per frame; in the shader it is free. Before adding a CPU pass over pixel data,
check whether the GPU can do it while sampling.

### Bound the light cache, do not thrash it

`ChunkedLighting` caches baked chunks in world space, prefetches one ring chunk
per idle call, and evicts LRU. Two invariants worth preserving:

- Prefetch must not run on a call that already baked on demand, or the two costs
  land on the same frame.
- Never evict a chunk the current window is drawing — it would rebake next call.

`syncTo` must ignore tiles whose light is painted dynamically *and* that pass
light (the player). Without that, walking dirties the chunks around the player
and rebakes them for output that cannot differ.

## Verifying performance work

**Prove the test can fail.** A parity test that passes at every setting is
testing nothing. Sweep the constant you are bounding — apron width, reach
radius, probe span — and confirm the test goes red when it is too small. One
parity test here passed at `apron=0` because batching had quietly turned the
scenario into the very thing it was comparing against.

**Diff the bytes.** Optimisations to lighting must be byte-identical to what
they replace, verified across all three `AMBIENT_PRESETS` and several player
positions, not eyeballed in a screenshot. If output legitimately changes, say by
how much and where.

**Check which renderer you are measuring.** `/play` uses `GameRenderer` →
`WorldRenderer`. `/map` uses `EditorRenderer`, which has its own lighting path
and does **not** use the chunk cache. Numbers from one say nothing about the
other.

**Frame counters in a headless or backgrounded browser are meaningless** —
rAF is throttled, so the loop only advances when something forces a frame.
Measure in Node, or read the in-game counter on a real screen.

## Known remaining costs

Not yet fixed, and worth knowing before you profile something else:

- **Level geometry still rebuilds wholesale.** `rebuildDirty` finds the dirty
  level by identity, then does `removeLevel(z)` + `buildLevel(next, z)` — every
  cell of the floor because one changed. ~8.7ms, and now the largest single
  spike left.

  The data model is already chunked, so the dirty *chunk* is available by
  identity (`prev.levels[z][chk] !== next.levels[z][chk]`). What remains is the
  renderer side: geometry is batched into one merged group per level, so making
  it per (level, chunk) means re-keying `levelGroups`, `animatedByLevel`, the
  `movableMeshes` key prefixes, motion ghosts, and `applyLevelVisibility`'s
  roof-cut. Worth doing, but it touches depth sorting — verify visually, in a
  real browser, not a headless one.

  Note the player renders as a *separate* animated mesh, so on a step the merged
  batch is often byte-identical across the rebuild. Confirming that cheaply may
  be a shortcut worth taking before the full refactor.
- **The editor is a second, unchunked lighting path** and will hit the same wall
  the play renderer already climbed.
