# Interface

## Values kept in sync by hand

- The `theme-color` meta in `app/root.tsx` copies `--color-ink`; a `<meta>` cannot read a custom property.
- The landing page switches layout at 1024px in `app/routes/home.css`, and `Gallery.tsx`'s `sizes` names the same width; an `<img>` attribute cannot read a stylesheet.

## Touch

- `useMediaQuery` and `useCoarsePointer` return `false` on the server and before hydration. `AppShell`, `ArenaStage` and `GameViewport` account for it; `GameViewport` seeds panel-open state as `null`.
- `GameViewport` swaps the phone's two columns with `flex-row-reverse` when `padSide` is `left`. Anything in the pad column aligned to the screen edge has to flip with `padSide`, as the clock's `justify-end` does; an unconditional one ends up against the list.

## The game's windows

- `.gump`, `.plate`, `.socket` and `.knob` in `app/app.css` draw every edge in whole bricks of `--ui-brick`. A border or a padding that is not a whole number of bricks puts a bevel on a half pixel.
- The colours in `PALETTE` in `app/components/pixelIcons.tsx`, and the brass and outline in the corner-cap SVG in `app/app.css`, copy the `--color-outline`, `--color-brass` and related tokens in the same file; an SVG path's `fill` in a data URI cannot read a custom property.
- `.gump--parchment` swaps `--color-paper` and `--color-ink` inside the window. A component in it that writes `text-paper` gets the parchment's ink, which is what lets the conversation and craft panels go on parchment unchanged; a literal colour inside one does not swap.
- `.gump` sets `isolation: isolate`. Without it the corner caps' `z-index` paints over popups opened beside the sidebar.
