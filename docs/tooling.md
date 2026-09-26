# Lint and format exceptions

Each rule below is turned off, or each path ignored, because following the tool's default here would break something. Do not turn one back on without removing the reason.

## `.oxlintrc.json`

- **`unicorn/no-thenable`** — `then` is the field a dialog choice carries (`{ label, then: DialogCommand[] }` in `app/lib/dialog.ts`). It is authored in `data/`, sent on the wire, and shown in the editor, so renaming it is a schema migration.
- **`unicorn/no-useless-spread`** — every site is `for (… of [...collection])` where the loop body removes from that collection (`disposeMotionGhost`, `dropChunk`, `liveTransitions`, `SocketHub.all()`). The spread is the snapshot that makes the loop safe. The remaining sites are `[...typedArray.slice(n)]` in tests, which convert to a plain array for `toEqual`.
- **`typescript/no-this-alias`** — the sites are object literals passed to a constructor, some holding a getter (`get closed()` in `app/local/LocalWorld.test.ts`). `this` inside a getter in a literal is the literal, so the alias is the only way to reach the enclosing instance.
- **`unicorn/no-new-array`** — `new Array(n)` is always a fixed-length buffer filled by index immediately after, as in `clumpExtents`. `Array.from({ length: n })` allocates and fills first.

Two inline disables:

- `server/authDialect.ts` `streamQuery` is a generator that only throws, so `require-yield` is disabled on it.
- `app/lib/clock.ts` writes the first keyframe as `0 * 60` to match the keys below it, so `erasing-op` is disabled on that line.

## `stapes/no-comments`

- `lint/plugin.ts` is a local oxlint JS plugin. It is TypeScript, so `bun run lint` runs oxlint with `bun --bun`: CI installs no Node, and the runner's default Node may not strip types.
- The rule allows `oxlint-disable`/`oxlint-enable` directives, a bare `@ts-expect-error`, `/// <reference>` and shebangs.

## `.oxfmtrc.json`

- **`**/*.md`** — oxfmt rewrites `*emphasis*` as `_emphasis_` and pads tables. Markdown is not formatted; `README.md` and `AGENTS.md` are therefore not checked either.
- **`data/map.json` and `data/tiles.json`** — these are written by `serializeMap` (one line per cell) and `writeTiles` (two-space JSON). The editor sends whole files, and saving an untouched file must rewrite nothing (`server/api.ts`, `app/routes/admin/map.tsx`). oxfmt differs from both writers by a space after the colon, which is not configurable.

## `vite.config.ts`

- `dependencyRoot` walks up from the working directory to find `node_modules`, and `server.fs.allow` lists both that directory and the project root. A git worktree has no `node_modules` of its own; without this, the dev server refuses to serve React Router's default `entry.client.tsx` from the main checkout and a worktree loads a blank page behind a 403.
