# Interface

## Values kept in sync by hand

- The `theme-color` meta in `app/root.tsx` copies `--color-ink`; a `<meta>` cannot read a custom property.
- The landing page switches layout at 1024px in `app/routes/home.css`, and `Gallery.tsx`'s `sizes` names the same width; an `<img>` attribute cannot read a stylesheet.

## Touch

- `useMediaQuery` and `useCoarsePointer` return `false` on the server and before hydration. `AppShell`, `ArenaStage` and `GameViewport` account for it; `GameViewport` seeds panel-open state as `null`.
- `GameViewport` swaps the pad column to the other side with `flex-row-reverse` when `padSide` is `left`, in both the phone layout and the sideways one, where the board sits between the columns. Anything in the pad column aligned to the screen edge has to flip with `padSide`, as the readouts row's `justify-end` does; an unconditional one ends up against the list.
- `WorldPage` builds the `GameRenderer` once, against the `<canvas>` that is mounted when it connects, and never rebuilds it for a new one. `GameViewport` lays the phone out in two different trees (`WIDE_TOUCH`), so the canvas is portalled into one long-lived node that each layout's `StageSlot` adopts. Rendering the canvas inline in either tree gives a new, blank canvas every time the phone is rotated.
