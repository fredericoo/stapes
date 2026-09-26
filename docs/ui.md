# Interface

## The pixel font

- `NF Pixels` (`app/app.css`) has 10 design pixels per em with whole-pixel advances. Any size that is not a multiple of 10px puts glyph edges on half pixels, which antialias to grey; `--world-label-size` is 20px.
- Its `@font-face` uses `font-display: block` because the fallback has different metrics, and `swap` would reflow labels when the font arrives.
- The subset has no `~`. `sanitizeChatText` (`app/net/chat.ts`) keeps `0x20`–`0x7d` for that reason.

## Values kept in sync by hand

- `--color-interact` and `--color-reward` (`app/app.css`) copy `HOVER_COLOR` and `REWARD_COLOR` (`app/render/GameRenderer.ts`).
- The `theme-color` meta in `app/root.tsx` copies `--color-ink`; a `<meta>` cannot read a custom property.
- `.world-label__bar`'s border width must equal `TRACK_BORDER_BRICKS` (`app/render/healthBar.ts`). The bar is `box-sizing: content-box` because the fill size is computed with the border already subtracted.

## CSS

- The `button, input, select, textarea { font: inherit }` reset stays inside `@layer base`. Unlayered, it beats every Tailwind `text-*` and `font-*` utility.
- `.scrolls-in-chrome` sets `scrollbar-color` so Chromium shows a classic scrollbar instead of an overlay one that is invisible until hover.
- The scrolling transcript in `ConversationPanel` is `position: relative` so its absolutely positioned screen-reader prefixes stay inside it instead of growing the page.
- `ItemSlot`'s tooltip card is portalled because its column scrolls vertically, which makes `overflow-x` compute to `auto` too and clip the card.
- `Tooltip` sets its z-index on Base UI's `Positioner`, not the `Popup`, so it sorts above a dialog's `z-50`.
- Base UI keeps the open delay on `TooltipProvider`. `InfoTip` gets a zero delay by nesting its own provider.

## Touch

- `useTap` (`app/components/useTap.ts`) reads pointer events rather than `onClick`, because iOS synthesises no `click` while a second finger is down.
- iOS's double-tap-and-hold magnify ignores `touch-action`. `DirectionPad` and `useNoZoom` call `preventDefault()` from native listeners added with `{ passive: false }`, since React's touch props are passive.
- `ItemSlot` tracks the resting finger in `dwellingRef`, not in state, because a state updater runs after the click it is meant to swallow.
- `useMediaQuery` and `useCoarsePointer` return `false` on the server and before hydration. `AppShell`, `ArenaStage` and `GameViewport` account for it; `GameViewport` seeds panel-open state as `null`.

## Editor

- `sanitizeSprite` (`app/components/TileEditorDialog.tsx`) spreads the original sprite and replaces only the frames, so fields such as `phase` survive a save.
- `ItemTab` copies `DEFAULT_STONE.effect` when switching a type to `stone`; a shallow spread would share one `effect` object between stones.
- `roundToStep` (`app/ui/numberParse.ts`) rounds through the step's decimal precision so saved files do not get values like `0.30000000000000004`.
- The accessory square's key is `charm` on the wire and in saved kits, though it also takes rings, stones and torches. Only `SLOT_LABELS` (`app/lib/kit.ts`) says "Accessory".
