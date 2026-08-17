# Looking, and signs

> **Built.** Two things ended up differing from the plan below, both found while
> wiring it up:
>
> - **The look pick re-runs per frame**, gated on the camera or map having
>   changed (`repickLook`). Walking with shift held slides a new cell under a
>   cursor that never moved, so a pick held from the last pointer event pointed
>   at the wrong thing. Measured at **0.167ms** against the fixture map, versus
>   3.3ms for a single rebuild of the interactive index it deliberately avoids.
> - **`/play` gained a label layer.** It never had one — names and speech are
>   online-only — so looking drew an outline and no words until the route
>   started passing `labelRef` through to the renderer.
>
> **Since built: a sign reads itself when you stand next to it.** Looking stayed
> the only way to read one for a while, and it is a poor fit for the thing signs
> are *for* — a player who has to find a modifier before the world will speak to
> them walks past. So a described placement within `REACH_CELLS` on the reader's
> own level now hangs its text over itself unasked, in the same blue at the same
> anchor. **The description alone, never the name**: a look answers "what is
> that?" and needs the name for it, while standing beside a sign is not a
> question, and "Sign / DANGER" reads as a museum caption where "DANGER" reads as
> the world talking. See `app/render/nearbyDescriptions.ts`, which owns who
> speaks; the placement you are actually looking at is left to the look label, so
> its words are not printed twice.



Scope for a *look* mode: hold shift (or tap an eye button on touch) and the tile
under the pointer lights up blue and tells you what it is. Plus the authoring
side that gives it something to say — a per-placement `description` — and a
placeholder `sign` tile to hang one on.

Decisions taken up front, so the rest of this reads against them:

- **Any top-of-stack tile is lookable.** Hovering grass says "Grass". Looking is
  a mode you enter deliberately, so noise while it is on is the point rather
  than a cost — the alternative (only tiles with a description light up) makes
  the mode a hunt for hotspots and turns a blank outline into the only way to
  tell "nothing here" from "not lookable".
- **`channel` moves into the placement settings modal** alongside `description`.
- **The mobile eye toggle sits beside the d-pad**, in the coarse-pointer row.
- **The sign is a tile def only.** Nothing placed in `data/map.json`.

---

## 1. `PlacedTile.description`

A new optional field on the placement, sibling to `channel`, for exactly the
reason `channel` is one: what a thing *says* belongs to the slot, not to the
tile filling it. Two signs share one `sign` tile def and say different things,
and a description has to survive every swap of the tile in that slot.

It survives for free, on every path that already exists:

- `activateSwitch`, `pressurePlates`, `signals` and `push`/`moveEntity` all
  spread the placement and rewrite only `tileId` (or the cell). A pushed sign
  keeps its text; a door that opens keeps whatever was written on it.
- `chunkifyMap` / `flattenMap` move whole stacks and never enumerate fields, so
  persistence needs no change.
- The wire parses cell patches as `v.looseObject({ tileId: v.string() })`, so
  `description` reaches every client with no protocol change. `hello` carries
  the map as `v.unknown()`.

Files:

- `app/lib/types.ts` — the field, documented like `channel` is: why it is a
  placement field, and that it must outlive a tile swap.
- `app/lib/mapData.ts` — `updatePlacedDescription(map, x, y, z, stackIndex, text)`,
  mirroring `updatePlacedChannel`: trim, and delete the key when empty so a
  cleared description leaves no residue in the on-disk diff.

**Add the no-op guard while here.** `updatePlacedChannel` rewrites the stack
even when the value is unchanged, which is a new map identity, an undo entry and
a geometry-diff pass for nothing — the exact thing AGENTS.md's "a mutation that
changes nothing must return the same object" is about. A blur commits on every
focus-out, so this fires constantly in the editor. Both functions should return
`map` untouched when the trimmed value already matches. (Tier 1: it is a bug in
code the change is already touching.)

A length cap of ~240 characters, enforced in the editor field. It is authored
content, not player input, so the cap is about layout — a paragraph on a tile
would be a wall across the view — not about safety. The text reaches the screen
through `row.textContent` in `WorldLabelLayer.fill`, which is already the "this
string came from someone else" path.

## 2. Placement settings modal

The stack row in `app/components/SelectedStackList.tsx` is already carrying an
inline channel field, and per-placement state only grows from here. The row goes
back to being a row.

- Each `SortableStackItem` gets a gear button (`IconSettings`) beside the trash,
  labelled `Settings for {def.name}`.
- It opens `app/ui/Dialog.tsx` titled with the tile name, holding:
  - **Description** — a textarea. Uncontrolled with a `key` on the committed
    value, committed on blur, for the same two reasons the channel input is:
    a commit per keystroke is an undo entry and a map identity each, and keying
    on the committed value is what stops the field showing something the map no
    longer holds after an undo or a different cell being selected into the row.
    Enter must *not* commit here — it is a newline in a textarea.
  - **Channel** — moved wholesale out of the row, `datalist` and all. Still only
    rendered for wired tiles (`isWired`), for the reason the current comment
    gives: a channel on a rock is a control that can never do anything.
- Direction stays inline. It is a four-way segmented control people flick
  constantly while placing, and it is visual — burying it behind a modal makes
  the common case worse to buy nothing.
- `app/ui/index.ts` gains a `Textarea` if there is no equivalent to lean on;
  otherwise it is `Input`'s chrome on a `<textarea>`.

Store: `setStackDescription(stackIndex, text)` in `app/editor/store.ts`, routed
through `commitMap(updatePlacedDescription(...))` exactly as `setStackChannel`
is — the map-mutations rule in AGENTS.md is not optional, and ⌘Z has to undo an
edited description.

**One thing to check when the modal lands:** the dialog is portalled, and the
row lives inside a `DragDropProvider`. Opening a modal from a drag handle's
sibling should be inert, but confirm a click on the gear does not start a sort
operation, and that focus returns to the gear on close.

## 3. Look mode

### Where the state lives

Entirely in `GameRenderer`. Not in the session, and not on the wire.

Hover goes through `PlaySession.setHoveredObject` because whether an object can
be *acted on* is a simulation question — `canInteract` needs the actor's cell,
the affordance rules and the board. Looking asks nothing of the simulation: the
name is `tilesById[placed.tileId].name` and the text is on the placement, both
of which the renderer already holds. Putting it in the session would mean the
same field mirrored in `GameSession` and `RemoteSession` to no end.

So: `renderer.setLookMode(enabled)`, and the renderer keeps `lookedAt:
ObjectRef | null` plus the last pointer position.

### Input

- **Desktop — shift.** `shiftKey` already means `faceOnly` in
  `app/game/heldDirections.ts` (turn on the spot, do not walk). The two do not
  collide: one is about a held direction, the other about the pointer, and
  "shift is the careful, deliberate modifier" reads the same in both. The route
  toggles look mode on `keydown`/`keyup` of Shift and on window blur.
- **Pressing shift must re-pick without a pointer move.** The renderer keeps the
  last pointer position for exactly this; otherwise nothing lights up until the
  mouse twitches, and on a still hand that reads as broken.
- **Shift does not count while typing.** The chat bar is right under the game
  and a capital letter must not flick the mode on and off mid-sentence. The
  shift listener goes through `isTypingTarget` — the same guard `bindKeyboard`
  already applies so a held direction aimed at a text field never reaches the
  avatar — rather than around it. Focus is the whole test: a shift pressed at a
  keyboard that is talking to an input is not aimed at the world.
- **Touch — the eye button.** New `LookToggle` component (`IconEye`), rendered
  beside the `DirectionPad` in `app/components/GameViewport.tsx` under the
  existing `coarse` gate. Active state highlights blue, matching the outline it
  turns on. It is a toggle: tap on, tap off.

### Interaction is suppressed while looking

`onPointerDown` currently resolves a target and calls `session.interact`. While
look mode is on it must instead set `lookedAt` and return — a tap on a door in
look mode reads it, it does not open it. This is the whole reason touch needs a
mode at all: a finger has no hover, so looking and acting cannot share a tap.

Which also makes the touch label **sticky**: the looked-at object survives until
another tap or until the mode is switched off. On desktop it tracks the pointer
and clears on `pointerleave` or on shift release.

### Picking any tile, without sweeping the map

`indexInteractive` cannot be widened to cover every placement. It is affordable
today because interactive placements are rare — a handful of entries that
`pickInteractiveAt` brute-forces per pointer move. Every top-of-stack tile on
three levels is thousands of entries, each needing a `spriteQuadFor` per pointer
move, and the index rebuilds whenever map identity changes, which during a walk
is every commit. That is the shape AGENTS.md spends a whole section on.

Instead, bound the *probe* rather than caching an index:

```
pickTileAt(ctx, worldX, worldY, z0)   // new, in app/render/pick.ts
```

- Levels `z0-1 … z0+1`, the same slack the interactive index uses.
- Per level, invert the projection with `screenToCoord` to get the base cell,
  then probe a small rect around it. The span is derived, not magic: a sprite
  can reach up-left by its own rect size plus `elevationScreenOffset` of a full
  overflow stack (4 height units = 16px = 2 cells), so `PROBE_SPAN` comes from
  the largest sprite rect in `tilesById`, computed once.
- For each probed cell, quad-test the top of the stack only (buried tiles are
  not visible and not lookable — the same rule `indexInteractive` applies), and
  keep the front-most by `drawOrder`.

That is ~100 stacks per pointer move with no index to invalidate, and it is
strictly cheaper than what the interactive path does today. The `isActionable`
tiebreak in `pickInteractiveAt` does not apply — every candidate is equally
lookable, so front-most simply wins.

Worth extracting the quad-test-and-rank body so the two picks share it rather
than growing a second copy of the ranking.

**You can look at exactly what is drawn.** The probe covers `z0+1`, and
`hideLevelsAbove` may be hiding it, so the pick has to mirror the same
`levelsAboveShouldHide` / `viewAnchorFor` pair `pushView` already computes —
not as a second rule about what is lookable, but because a hidden level is not
on screen and picking one would be reporting a tile that is not there. The
converse needs no special case and gets none: standing under a roof that *is*
drawn, looking up says "Roof". That is the right answer, not a leak — the mode
names what you are pointing at, and you are pointing at a roof.

### What gets drawn

**Outline.** `overlaysFor` returns the existing `objectOutline` overlay with a
blue `LOOK_COLOR` instead of the yellow `HOVER_COLOR`. No renderer work beyond a
constant. While look mode is on the yellow interaction hover is suppressed —
two outlines in two colours on one object would be asking the player to decode a
legend.

**Label.** A third `WorldLabel` kind, `"look"`, from a new `pushLookLabel` in
`GameRenderer.labelsFor`:

```ts
{ id: `look`, kind: "look", x, y, lines: [
    { id: "name", text: def.name },
    ...(placed.description ? [{ id: "desc", text: placed.description }] : []),
] }
```

Lines flow downward with the group's *bottom* on the anchor, so `[name,
description]` puts the name on top and the description directly under it — the
chat-bubble stacking the request asks for, already built.

Anchored over the object's head: cell world centre plus
`elevationScreenOffset(elevation + def.height)`, the same move `pushNameLabels`
makes for actors. A single id (`look`) rather than one per cell, because there
is only ever one looked-at thing — the element cache then reuses one node and
only refills it when the text changes.

**CSS**, in `app/app.css` beside `--name` and `--speech`: `.world-label--look`
in light blue on the existing black brick outline, which the base
`.world-label` rule already provides. It needs the same clearance transform
`--speech` carries — looking at another player puts this label on the same head
as their yellow name tag, and both hang upward from anchors a pixel apart.

## 4. The sign tile

One entry in `data/tiles.json`: `id: "sign"`, `name: "Sign"`, `type: "simple"`,
height 1, `walkable: false`, sprite lifted from a spare cell of an existing
tileset. Placeholder art on purpose — the tile exists so there is something
sign-shaped to place and describe, and the description is where the content
actually lives.

Note what the sign is *not*: it has no `interactions` entry. A sign is not a
switch and not pushable; reading it is looking at it. That is the point of the
feature — the sign is the first thing that only exists because looking does.

## 5. Tests

- `app/lib/mapData.test.ts` — set, clear (key deleted, not emptied), trim, and
  the no-op identity guard on both description and channel.
- `app/render/pick.test.ts` — `pickTileAt` finds a plain floor tile, prefers the
  front-most of two overlapping, ignores buried stack entries, and reaches a
  tall tile whose sprite overhangs from two cells away. **Prove the span can
  fail**: shrink `PROBE_SPAN` and confirm the overhang case goes red, per the
  "prove the test can fail" rule — a probe test that passes at every span is
  testing nothing.
- `app/render/textLabels.test.ts` — a look group's line order puts the name
  above the description.

## 6. Accepted, not fixed

Two things this scope leaves standing on purpose. Both are decisions, not
oversights, and both are cheap to revisit once something asks for them.

- **A label on a moving tile lags its sprite.** The anchor is read per frame
  from the placement's cell, so a described crate mid-slide has its label at the
  committed cell while the sprite lerps in behind it. Speech solved the
  equivalent by *freezing* the anchor; looking wants the opposite — follow the
  sprite — which means routing the label through the same
  `actorVisualWorld`/motion path the sprite takes rather than the static cell
  centre. Accepted as a delay for now: you rarely look at something mid-shove,
  and the label lands correctly the moment the slide ends.
- **No desktop cue for shift.** The eye button is coarse-pointer-only, so a
  keyboard player is told nothing on screen. This is the tutorial's job, not
  the HUD's — a permanent hint for a modifier you learn once is chrome that
  never stops charging rent.
