# Interface

## Values kept in sync by hand

- The `theme-color` meta in `app/root.tsx` copies `--color-ink`; a `<meta>` cannot read a custom property.

## Touch

- `useMediaQuery` and `useCoarsePointer` return `false` on the server and before hydration. `AppShell`, `ArenaStage` and `GameViewport` account for it; `GameViewport` seeds panel-open state as `null`.
