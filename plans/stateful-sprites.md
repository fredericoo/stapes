# Plan: stateful sprites

> Source: design conversation, not a PRD. The requirements are the decisions
> below; each phase states what it is demoable as.

A second sprite axis beside direction and autotile slice, so one tile can look
different without behaving differently: a deer that walks, a rat mid-swing, a
chest somebody has open, a quest chest you have already emptied.

---

## The rule that decides state vs. swap

**A sprite state is read from the actor or the session. A tile swap writes to
the map.**

That is the whole distinction, and it is a statement about *audience* before it
is one about persistence. The map has one copy and everybody looking at the
world sees it, so a swap can only ever express a fact that is true for
everyone — a door is open, full stop. Anything true of one viewer and not
another has nowhere to go in the map without lying to somebody.

Which is exactly why a quest chest cannot be a swap: "this has been emptied" is
true of one player and false of the next, and a swapped tile would either deny
the second player their reward or show them a looted chest that still pays out.
The fact lives on the actor — `tags`, stored per actor and broadcast only to its
own owner — so the sprite has to be read from there too.

Doors stay swaps. They change walkability, they are authored, they are saved,
and they are true for everybody.

---

## Architectural decisions

Durable across every phase.

### The states

```ts
// Shipped. Grows one member at a time, each with its driver.
export type SpriteState = "idle" | "moving";
```

`idle` is not one state among the rest. It is the tile's sprite, and the others
are sparse overrides on it — see "Data model".

**A state exists in the union only once something draws it.** `attacking` and
`open` are fully specified below and deliberately not in the type: a state nobody
draws is a control in the editor that does nothing when used, and an authored
sprite that never appears is indistinguishable from a bug. Each is added in the
same change as the thing that drives it.

Where each is read from, once it exists:

| state | read from | scope |
|---|---|---|
| `moving` | `ActorSnapshot.walk / fall / slide` | already in the snapshot |
| `attacking` | a new `swung` event | needs one new event |
| `open` (container) | the set of containers somebody has open | **needs new session state** |
| `open` (quest chest) | `resolveReward(placed, def)` vs. the viewer's `tags` | already in the snapshot, per viewer |

`open` covers both chests deliberately. The lifetimes could hardly be more
different — one is a panel somebody has up right now, the other is a reward
taken for good — but the visual claim is identical: the lid is up. A tile only
ever gets one derivation, since `availableStates` branches on predicates that
cannot both hold, so there is nothing to disambiguate at the point of reading.

### Which tiles may have which states

Derived, never authored, from predicates that already exist. One function, used
by the editor to build its state rail and by the resolver to reject a state a
tile cannot be in — so what you can author is exactly what can fire:

```ts
export function availableStates(def: TileDef): SpriteState[] {
  const out: SpriteState[] = ["idle"];
  if (isMobileTile(def)) out.push("moving");
  // Each deferred state adds its own line here, with its driver:
  //   attacking -> def.kind === "battler"
  //   open      -> resolveContainer(def) || resolveRewardDef(def)
  return out;
}
```

`isMobileTile` rather than "has a brain or is a battler": it already means *can
this ever change cell* — gravity, actor, or pushable — and its doc comment
already argues that this must be a property of the tile rather than of whether
it happens to be moving this frame. A pushable crate sliding is movement, and
authoring nothing for it costs nothing.

### Data model — sparse overrides

```ts
/** The sprites for one state, keyed by whichever axis this tile's `type` uses. */
export type StateSprites = {
  sprite?: TileSprite;                                   // type === "simple"
  sprites?: Partial<Record<Direction, TileSprite>>;       // type === "directional"
  slices?: Partial<Record<AutotileSlice, TileSprite>>;    // type === "autotile"
};

export type TileDef = {
  // ...unchanged. These three ARE the idle state.
  sprite?: TileSprite;
  sprites?: Partial<Record<Direction, TileSprite>>;
  slices?: Partial<Record<AutotileSlice, TileSprite>>;
  /** Sparse overrides for the non-idle states. */
  states?: Partial<Record<Exclude<SpriteState, "idle">, StateSprites>>;
};
```

Resolution falls back twice: `states[s]` → the def's own sprites, and within a
state, a missing variant → the same variant on idle. A deer can author `moving`
for `n`/`s` only and reuse idle facing east and west.

**Why idle is implicit rather than `states.idle`.** A required outer level makes
every autotile `states.idle.slices[0..46]`, migrates all 36 tiles in
`data/tiles.json`, and touches every consumer — `allTileSprites`,
`tileLightSignature`, `normalizeTileDef`, the editor. With overrides, every
existing tile is *already correct*: it is all-idle, and `normalizeTileDef` needs
no new branch. The asymmetry is the price and it is worth it.

### Resolution

`getFrames` is the only chokepoint — four call sites, all through
`app/lib/tileResolve.ts`. `TileResolveContext` gains `state?: SpriteState`, and
`resolveTileSprite` picks the `StateSprites` before the existing `type` switch.

**Who computes the state.** `cellItems` and `spriteQuadFor` walk the map
generically and cannot know who is walking or what anybody has open; the
snapshot can. `GameRenderer` computes state per instance and hands `WorldView` a
`Map<instanceKey, SpriteState>` holding only the non-idle entries — the same
keying, lifecycle and plumbing `TileMotion` already uses, and empty for every
frame in which nothing is happening.

### Batch membership

`WorldRenderer.cellItems` merges static tiles into per-floor geometry, and a
merged tile cannot swap sprites without rebuilding the floor.

While `moving` is the only state, `isMobileTile` covers this on its own —
`availableStates` gates `moving` on exactly that predicate, so every tile that
can change sprite is already out of the batch. The test is unchanged:

```ts
const separate = isAnimated || isMobileTile(def);
```

**Phase 3 is what breaks that**, and it is the term to remember to add:
`quest-chest` is a plain `prop` with no gravity, no push and no brain, so an
`open` state on a still tile needs `|| hasSpriteStates(def)`. Keyed on
*capability* when it arrives, never on current state, on exactly the grounds the
existing comment records for keying `isMobileTile` on the tile rather than on the
live motion set: a tile that changed batch membership when it changed state would
rebuild a floor every time somebody opened a box.

`hasSpriteStates` exists already, for a different job — it is what registers a
mesh with the per-frame state pass, which being animated does not imply: a grazing
deer stands on one frame and becomes a four-frame walk when it steps.

### A state shares idle's footprint

**Changed from the first draft of this plan, which said a differing footprint
would rebuild the mesh.** It is validated instead.

`updateAnimations` rewrites UVs only — a mesh's geometry positions are baked at
build from frame 0's `rect` and `base`. So the frames of a single sprite have
*always* had to share a footprint, silently and with nothing checking. Requiring
a state to share it too is the same rule one level up, and stating it out loud in
`footprintMismatch` is an improvement on the status quo rather than a new
restriction: what was an unwritten assumption is now a save-time error naming
both sizes.

The cost is an attack sprite that overhangs its tile — a wide swing arc — which
phase 4 does not need and no art in the game wants yet. Rebuilding a single
instance's quad is the way to lift it when something does: these are separate
meshes by the rule above, so it is one mesh and never a floor. Left undone
deliberately, because the constraint is free today and the machinery is not.

### `animKey` carries the state

Both renderers build it as `${def.id}:${direction}`. Two deer, one grazing and
one running, would otherwise share a frame clock over different frame lists.
It becomes `${def.id}:${direction}:${state}`, and `frameIndices` follows.

### The swing event

`GameSnapshot.attacking` is the **viewer's own mode**, not per-actor, and a mode
is the wrong thing to pose off in any case: a creature in attack mode standing
in range would hold a swing pose indefinitely.

`GameSession.tryAttack` is the single path from "somebody wants to attack" to a
blow. It emits a `swung` `MotionEvent` carrying the attacker id, and the client
holds the pose for a fixed duration — the same shape damage numbers already
have, and for the same reason: a swing *happened* and cannot be recovered by
comparing two readings.

**It must be its own event, not a field on `hit`.** A dodge spends the cooldown
and produces no damage number, so a pose driven off landed blows would skip
every miss — and a creature that only animates when it connects reads as broken
exactly when a fight is going badly.

### Container open becomes session state

This is the one genuinely new piece of machinery, and it reverses a documented
decision. The `InteractionKind` doc says outright that opening a container is
not something the server does: contents already ride on the placement, so
looking inside is local panel state, and `GameRenderer.setOpenedContainer` is a
local field that neither the session nor the protocol knows about.

That decision was correct for what it had to serve. **Showing an open chest to
everybody in the room is a new requirement it never had to serve**, and nothing
currently synced changes when somebody looks inside, so a new signal is
unavoidable.

- The client sends `openContainer: { ref } | null` when its panel opens or
  closes. It already knows both moments — `pushOpenedContainer` recomputes every
  frame and closes on reach loss.
- The session holds *which container each actor has open*, keyed by `itemId` —
  the identity `readOpenedContainer` already checks against, and the one thing
  that survives the box being shoved to another cell.
- **The server validates and expires it**, reusing `canOpenFrom` rather than
  trusting the client, or a disconnect leaves a chest looking open for ever.
- The broadcast is the set of open `itemId`s, not who has what open. The sprite
  only asks *whether anybody* does, and sending the pairing would be telling
  the room who is rummaging in what for no frame that draws it.

The panel itself stays exactly where it is. This adds a second, coarser reading
of the same act for everybody else's benefit; it does not move the container UI
server-side.

### Quest chest open costs nothing new

`tags` are stored per actor in DO storage and already broadcast only to their
own owner. So:

```
state = resolveReward(placed, def) && tags.includes(reward.tag) ? "open" : "idle"
```

No new protocol, no new storage, no migration — and per-viewer for free, which
is the point. `takeReward` keeps working exactly as it does; the placement is
never touched.

**Reach is not part of it.** The predicate is "do you hold the tag", not
`canRewardFrom` — a chest across the room is one you cannot reach *yet*, and
drawing it open would be telling you it is spent when it is waiting for you.

The change signal is free too: `GameSnapshot.tags` is replaced wholesale rather
than appended to, precisely so identity is the signal, so the renderer can
recompute quest-chest states on a reference check.

---

## Scope

**In:** the state axis, and `moving` for actors. The point of the feature is a
deer that looks different walking than standing still.

`SpriteState` holds `idle | moving` and nothing else. Adding a member before its
driver exists would put a state in the editor's selector that does nothing when
picked — so each deferred state below arrives in the same change as the thing that
draws it.

**Deferred, in the order they get cheaper to add:** the quest chest (phase 3 —
no protocol, just a predicate), `attacking` (phase 4 — one new event),
container open (phase 5 — the only one that adds state to the wire). All three
are designed above so the axis does not have to be reopened for them, and none
is built now.

The full editor redesign is deferred too. It is the right shape and phase 2
still describes it, but authoring `moving` needs only a state selector beside
the existing direction tabs, and that is what gets built.

## Phase 1 — the state axis, moving only ✅ done

Demoable as: a deer that stands still while grazing and animates while it walks.

Shipped, with two things learnt on the way:

- **The deer already had a walk cycle running permanently.** Each direction was
  authored as a legs-together / legs-apart pair, animating whether or not the
  creature was going anywhere. So the data change was a split rather than new
  art: idle keeps the first pose alone, `moving` keeps both.
- **The autotile fallback had the bug this axis was most likely to introduce.**
  Asking `pickAutotileSprite` for the override let *its* slice fallback answer
  before falling through to idle, so a tile authoring one shape for `moving`
  would have worn that shape in every neighbourhood while moving. Caught by the
  test written for the documented ordering, not by inspection.

`spriteStatesFor` ended up in `app/render/spriteState.ts` as a pure function
rather than a private method on `GameRenderer`, on the grounds
`readOpenedContainer` gives: *is this thing moving* is a question about the world,
not about drawing, and the loop's job is only to ask it once a frame. That is what
made it testable against a real `GameSession` instead of a fabricated snapshot.

- `SpriteState` (`idle | moving`), `StateSprites`, `TileDef.states` in
  `app/lib/types.ts`; `availableStates` and `hasSpriteStates` beside the other
  predicates in `app/lib/interactions.ts`, where `isMobileTile` lives.
- `TileResolveContext.state` and the two-level fallback in `resolveTileSprite`.
  Tests: missing state falls back to idle; missing variant within a state falls
  back to idle's variant; a state not in `availableStates` resolves as idle.
- `allTileSprites` walks `states` too, so light scans, `isAnimated` and
  `tileLightSignature` see state frames. **Easy to miss and silently wrong**: a
  torch whose `moving` frames emit would otherwise be omitted from the bake.
- `animKey` gains the state, in `spriteQuad.ts` and both renderers.
- `hasSpriteStates` gates the animation-registry entry, so a mesh whose idle is a
  single frame is still reachable by the state pass. It is deliberately *not* in
  the `separate` test — see "Batch membership".
- `WorldView.spriteStates`, computed in `GameRenderer` from
  `ActorSnapshot.walk / fall / slide` — the same predicate `tileMotionsFor`
  already keys off.
- Instance mesh rebuild when a state change alters `rect.w/h` or `base`.

### What phase 1 built in the editor

A `Segmented` state selector above the existing sprite section, offering
`availableStates(draft)`. Flat rather than another nesting level, which is why it
fits without the redesign: the direction `Tabs` and the 47-slice grid stay
exactly as they are and the state simply selects which `StateSprites` they edit.

Picking a state with nothing authored clones the idle sprites into it, following
the pattern the autotile grid already uses when you click an empty slice. A state
whose sprites are byte-identical to idle is dropped on save, so clicking through
the rail to look at it does not silently author it.

## Phase 2 — the editor redesign (deferred)

Demoable as: authoring the deer's walk cycle without leaving one dialog.

Not built now — phase 1's state selector is enough to author `moving`. Kept here
because it is where this has to go once a third and fourth state exist, and
because the climb-from bug below is a symptom of the shape it fixes.

`TileEditorDialog` cannot take a fourth axis as it stands — the Tile tab already
holds identity, height, type, four checkboxes, actor, step duration, climb-from
*and* the whole sprite/frame/light editor, with `Tabs` nested three deep for a
directional tile. Split by axis instead of piling on:

- **Identity** — id, name, type, kind.
- **Appearance** — three panes: state rail (from `availableStates`) │ variant
  picker (nothing / N E S W / the 47-slice grid) │ frame strip with the sprite
  selector and preview. The state axis becomes free and three levels of nested
  `Tabs` collapse into one matrix.
- **Physics** — height, walkable, intangible, gravity, climb-from.
- **Behaviour** — the existing Interactive / Brain / Battle / Item / Respawn
  tabs, unchanged.

Light stays per-frame but moves *into* the frame strip rather than floating in a
box above the sprite selector.

Included here rather than as a follow-up: authoring a state is unreachable
without it, so phase 1 otherwise ships with no way to use it.

## Phase 3 — the quest chest (deferred)

Adds `open` to `SpriteState`, its line to `availableStates`, its hint to
`STATE_HINTS`, and `|| hasSpriteStates(def)` to the `separate` test.

Demoable as: a quest chest that looks emptied to you and shut to the player
beside you.

The cheapest of the four, and deliberately before the container work: it proves
the per-viewer half of the axis with no protocol at all.

- `quest-chest` gains an `open` `StateSprites`.
- `GameRenderer` derives the state from `resolveReward` and `snap.tags`,
  recomputing on tags identity change.
- Tests: two actors with different tags read different states for one
  placement; a placement with no `rewardTag` is idle; reach does not enter into
  it.

## Phase 4 — attacking (deferred)

Adds `attacking` to `SpriteState`, its line to `availableStates`, and its hint to
`STATE_HINTS`.

Demoable as: a rat visibly swinging at you, and missing.

- `swung` `MotionEvent` in `app/net/protocol.ts`, emitted from
  `GameSession.tryAttack` after the cooldown is spent and before the roll — so
  a dodge animates.
- Client holds the pose for `min(poseDurationMs, attackIntervalMs(spd))`, so a
  fast creature does not queue poses it can never finish.
- `attacking` outranks `moving` where both are live.
- The local `/play` session emits it too, so the offline client is not a second
  code path that quietly lacks the animation.

## Phase 5 — container open (deferred)

Demoable as: a chest that shows open to the whole room while anybody has it up.

The largest phase, and last because it is the only one that adds state to the
wire. See "Container open becomes session state".

- `openContainer` client message and its valibot schema.
- Per-actor open container in `GameSession`, keyed by `itemId`, validated
  against `canOpenFrom` each tick and dropped on disconnect.
- The open-`itemId` set on `GameSnapshot`, and a patch for it.
- `GameRenderer` maps placements to `open` by `itemId` membership.
- Tests: two actors open one chest and one closing leaves it open; walking away
  closes it; a disconnect closes it; a client claiming to have open a chest it
  cannot reach is refused.

---

## Drive-by ✅ done

`TileEditorDialog` rendered the climb-from pad for everything non-directional —
which includes autotile — and the autotile branch rendered it again, so an
autotile showed two identical pads. `!isDirectional(draft)` is now
`draft.type === "simple"`. Both were wired to the same state, so it was cosmetic
rather than a data bug.

Phase 2 gives climb-from a single home on the Physics tab and makes the class of
bug structurally impossible — one control, one place, rather than a condition per
branch that has to stay mutually exclusive by hand.
