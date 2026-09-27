# Interface

## Values kept in sync by hand

- The `theme-color` meta in `app/root.tsx` copies `--color-ink`; a `<meta>` cannot read a custom property.

## Touch

- `useMediaQuery` and `useCoarsePointer` return `false` on the server and before hydration. `AppShell`, `ArenaStage` and `GameViewport` account for it; `GameViewport` seeds panel-open state as `null`.
- `GameViewport` swaps the phone's two columns with `flex-row-reverse` when `padSide` is `left`. Anything in the pad column aligned to the screen edge has to flip with `padSide`, as the clock's `justify-end` does; an unconditional one ends up against the list.
