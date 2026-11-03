# Interface

## Values kept in sync by hand

- The `theme-color` meta in `app/root.tsx` copies `--color-ink`; a `<meta>` cannot read a custom property.
- The landing page switches layout at 1024px in `app/routes/home.css`, and `Gallery.tsx`'s `sizes` names the same width; an `<img>` attribute cannot read a stylesheet.

## Touch

- `useMediaQuery` and `useCoarsePointer` return `false` on the server and before hydration. `AppShell`, `ArenaStage` and `GameViewport` account for it; `GameViewport` seeds panel-open state as `null`.
- `GameViewport` swaps the phone's two columns with `flex-row-reverse` when `padSide` is `left`. Anything in the pad column aligned to the screen edge has to flip with `padSide`, as the clock's `justify-end` does; an unconditional one ends up against the list.

## The game's windows

- A `.gump` is framed by a 9-slice image in `public/frames`: 16 pixels square, 6-pixel corners, drawn at one image pixel per brick (`--ui-brick`, 2px). An image of any other size or corner width needs the `border-image` slice and width in `app/app.css` changed with it, or every window's border scales by a fraction and blurs.
- A frame is named in `WINDOW_FRAMES` (`app/lib/windowFrames.ts`), which is what a container tile's `frame` is validated against, and its fill colour is in `windowFrame.ts`. A new frame is its image, its name in that list and its fill.
- The colours in `PALETTE` in `app/components/pixelIcons.tsx` and in the frame images copy the `--color-outline`, `--color-brass` and related tokens in `app/app.css`; an SVG cannot read a custom property.
- `.gump--parchment` swaps `--color-paper` and `--color-ink` inside the window. A component in it that writes `text-paper` gets the parchment's ink, which is what lets the conversation and craft panels go on parchment unchanged; a literal colour inside one does not swap.
