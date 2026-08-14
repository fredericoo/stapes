# Plan: equipment slots and items

> Source: design conversation, not a PRD. The requirements are the decisions
> below; there are no user stories to trace to, so each phase states what it is
> demoable as instead.

> **Status: phases 1–4 are built; 5 and 6 are not.** Notes marked *As built*
> record where the code and this document came apart, and why. They are written
> where the original decision is rather than collected at the end, because the
> reason a thing changed is only legible next to the reason it was that way.
>
> | | |
> |---|---|
> | 1 — Kind, and an item you can author | done |
> | 2 — Instances, equipment, two panels | done |
> | 3 — Pick up, and open from the ground | done |
> | 4 — Moving items between slots | done |
> | 5 — Drop | next |
> | 6 — Carried light, persistence, edges | |

Items are tiles. A weapon lying on the floor is a placement like any other — it
has sprites, it can fall, it can be pushed — and picking it up moves it off the
board and into somebody's bag. That is the animating idea, and it is what keeps
the machinery small: no item registry, no second art pipeline, no parallel model
of a thing in the world.

The corollary is the whole of the data model:

**An item instance is a placement without a position.**

A `PlacedTile` is already `tileId` plus the metadata that belongs to the *slot*
rather than to the tile def — `channel`, `description`, `direction`. An item
carries exactly that, because a sign you pick up is still the sign that said what
it said, and a wired lever in your bag is still wired to its channel when you put
it down. So an item instance is that same record plus an identity, and picking
something up is lifting the placement out of the map rather than translating it
into some other shape.

---

## Architectural decisions

Durable across every phase.

### An item instance, and what makes it traceable

```ts
export type ItemInstance = {
  /** Minted once, and kept for the life of the thing. */
  id: string;
  tileId: string;
  direction?: Direction;
  channel?: string;
  description?: string;
  /** Bags only. Nested instances, each with its own id. */
  contents?: ItemInstance[];
};
```

`PlacedTile` gains `itemId?: string` to carry that identity while the thing is on
the board, joining `channel`, `description` and `owner` as a placement field —
and for the same reason all three are placement fields: it belongs to the slot,
not to the tile def filling it.

The two shapes are deliberately convertible in both directions with nothing lost.
Pick up reads a placement into an instance; drop writes an instance back into a
placement. Anything added to one has to be added to the other, and that
correspondence is the thing to protect as the model grows.

**Ids are minted at world load**, in the same pass that already sweeps
placements to adopt actors — so no new sweep, and every item in the world has an
identity from the moment it exists rather than from the moment somebody first
touches it. That is what "traceable" costs: an id minted on first pickup would
leave everything nobody has handled anonymous, which is exactly the population
you would want to follow.

Not derived from position, unlike an NPC's `npc:12,3,0` owner id. That id names a
*runtime*, which does not move; an item's names a thing whose whole purpose is to
be carried around, and a coordinate baked into it would be a lie one tick after
it was minted. A short random id (`itm_…`) says nothing it cannot keep saying.

Load-time minting writes `itemId` into the runtime map, which the checkpoint
persists and an editor save would write through into `data/map.json`. That is
acceptable and arguably right — it is how an authored item keeps its identity
across a world restart — but it does mean **a save can dirty the map file with
ids nobody typed**, and that should be a deliberate decision rather than a
surprise in a diff.

### An item in a bag is off the board

It drives nothing. `wiredCells` indexes placements, so an emitter in your pocket
is not on the wire and a receiver in your pocket follows nothing. The `channel`
is *preserved*, not *live*, and it works again the moment the thing is put down.

Stated because the alternative is a genuine question — a remote detonator is a
reasonable thing to want — and because the answer needs to be written down
before somebody authors one and finds out.

### A tile has a kind, and it is written down

`TileDef.kind: "prop" | "battler" | "item"`, required, authored by a select at
the top of the Interactive tab. It replaces the Battler on/off switch that
currently lives on the Battle tab.

- **Prop** is today's non-battler tile. It can still have a brain, a push, a
  switch, a plate, a wire — being a prop says what it *is*, not what it does.
- **Battler** shows the Battle tab. The tab loses its own switch; the six stats
  are simply what a battler has.
- **Item** shows a new Item tab.

Stored rather than derived, which is the one place this plan departs from the
codebase's usual instinct (`resolveActor`, `isMobileTile`). The reason is that
the three are mutually exclusive and derivation cannot express that: with kind
read off the blocks, "battler" and "item" are two booleans that can both be true,
and the select would be lying about a state the model allows.

**No migration code.** `data/tiles.json` is edited inline — thirty tiles, each
gaining a `kind`. The field is required on `TileDef` rather than optional, so
every construction site in the codebase has to say which it is and the compiler
finds them all. A read-time fallback would be a second, quieter definition of
what a tile is, kept alive for a file that can simply be corrected.

The field is authoritative and the blocks are subordinate: `resolveBattler` and
`resolveItem` gate on the kind, so a tile whose kind is not `battler` has no
stats even if a stale block survives in the file. Switching kind in the editor
clears the block being left behind, and `interactionsForSave` writes at most one
of the two.

`TileDef.actor` is untouched and orthogonal. A prop can be an actor with a brain;
so, in principle, can a battler. The select is about what a tile is *for*, not
about what drives it.

### The item block

```ts
export type ItemMastery = "blade" | "ranged" | "blunt" | "magic";

export type WeaponItem = {
  type: "weapon";
  /** Added to the wielder's base atk. */
  atk: number;
  /** Added to the wielder's base def. */
  def: number;
  /** Costs speed and accuracy — see `effectiveBattler`. */
  weight: number;
  mastery: ItemMastery;
};

export type ContainerItem = {
  type: "container";
  /** How many instances fit inside it. */
  size: number;
  /**
   * Whether it can go in the bag slot. A backpack can; a corpse or a chest is
   * a container you open where it lies.
   */
  equippable: boolean;
};

export type ItemDef = WeaponItem | ContainerItem;
```

**"Container" rather than "bag"** because a dead monster's body is one too — a
corpse with a slot or two in it is the same thing as a backpack with four, and
naming the general case now costs nothing while renaming it later would touch
the wire, the panels and the authored file. A bag is a container that happens to
be `equippable`; that flag is the whole of the difference.

Corpse *generation* — what dies, what it leaves, which tile the body becomes —
is out of scope. What is in scope is that the model has room for it.

Lives at `app/lib/item.ts`, beside `battler.ts`, on the same terms as every other
interaction block: a valibot `v.variant("type", …)` parsed rather than trusted,
memoised on def identity in a `WeakMap`, and **a malformed block reads as "not an
item" rather than as a crashed world**. `resolveItem(def)` is the only way in.

A discriminated union rather than a flat bag of optional fields, so a weapon
cannot have a size and a bag cannot have a mastery. `mastery: "magic"` is
authorable now and does nothing yet — a slot in the model, deliberately, so the
enum does not have to change when it starts mattering.

Note the split: `ItemDef` is what every copy of a tile shares, `ItemInstance` is
what one copy carries. A sword's `atk` is on the def; its `description` is on the
instance.

### Equipment lives on the runtime, never on the placement

Same argument that keeps hit points off `PlacedTile`: a map edit invalidates
light chunks and rebuilds level geometry, so equipping would dirty every chunk
around the player. Equipment goes on `ActorRuntime`.

```ts
type Equipment = {
  weapon: ItemInstance | null;
  bag: ItemInstance | null;   // an equippable container; its `contents` is the inventory
};
```

The bag slot holds an instance like any other, and the inventory *is* that
instance's `contents`. No parallel array, no "the bag's tile id here and its
contents there" — one thing, in one place, whether it is on your back or on the
floor.

**Slots are auto-filled in order.** `contents` is append-on-pickup,
splice-on-remove. There is no reordering, so there are no holes and no need for a
nullable array. Position in it is not meaningful and nothing may come to depend
on that ordering.

**Containers do not nest — at all.** Not "no nested backpacks": no container may
hold a container, full stop. Depth is exactly one, everywhere, which is what
makes `contents` a flat list rather than a tree and keeps every capacity check a
single comparison. The consequence is that a corpse cannot be pocketed and
carried off — you loot it where it fell — which is the behaviour you would have
had to write a rule for anyway.

### A container can be opened from the ground

Walking up to a bag or a corpse and opening it shows the same panel the equipped
bag shows. The panel takes a subject rather than being about one particular
container:

```ts
type ContainerSubject =
  | { kind: "equipped" }
  | { kind: "placement"; ref: ObjectRef };
```

**Opening needs no server message.** A ground container's `contents` ride on its
placement, so they are already on the client via the cell patch that put the
thing there — opening is local panel state and nothing else. Only *moving* items
talks to the server.

Two things follow:

- **Reach is pick-up's 1.5 cells**, and it is re-checked as the world moves under
  it: walk out of range and the panel closes. The server re-validates on every
  transfer regardless — the panel closing is a courtesy, not the guard.
- **Looting dirties a cell.** Taking an item out of a ground container rewrites
  its placement, which is a cell patch and a chunk invalidation, once per item
  moved. That is the same cost a push already pays and it is bounded by how fast
  somebody can click, so it is accepted rather than batched. A take-all button is
  the lever if it ever matters.

> **As built.** Three corrections, two of them from bugs this shape invited.
>
> `ContainerSubject` is `ContainerRef` in `game/itemMoves.ts` — the same two
> cases, named for the container rather than for the panel, because the slot refs
> a panel builds are derived from it (`slotIn`). Beside it, `OpenedContainer` is
> the instance and its reference travelling *together*: a panel holding the
> contents without the reference can show what is in a chest while being unable
> to name a slot in it.
>
> **"Re-checked as the world moves under it" was too loose, and the first
> implementation read it as "when the container's cell changes".** The map is
> copy-on-write, so a chest nobody touches is the same object for as long as it
> sits there, and walking away never re-asked — whether the panel closed depended
> on whether anything happened to the box while you were gone. Two things can
> change the answer and the gate now admits both: the placement, and the cell the
> viewer is standing in.
>
> **Closing forgets the reference.** Walking back into range does not reopen a
> panel — a window that appears without anybody asking for one is worse than one
> you have to open twice. That also settles a leak the original shape allowed: a
> reference names a *slot*, so a box carried off leaves its slot to whatever
> comes next, and a kept reference would show the inside of it. **You must not
> see what is in a bag somebody else has picked up.** The identity check
> (`itemId`) stays regardless, because a box can be swapped while you stand right
> over it — which is exactly when nobody walks anywhere to trigger a close.
>
> The rule is `game/openedContainer.ts`, pure and tested; the render loop only
> decides when to ask it. It lives outside the loop because this was the second
> defect in it and it was not reachable by a test where it was.

### Carried light does not dirty a chunk

The light a carried torch throws is the reason to get this shape right now rather
than later, and the good news is that the path already exists.

An actor's own light is *never* in the static bake. `GameRenderer.emitterOverridesFor`
builds one `EmitterOverride` per actor per frame, `paintDynamic` casts them into
the packed grid additively, and `ChunkedLighting.syncTo` deliberately ignores
tiles painted this way — which is precisely what stops a walking player from
dirtying and rebaking the chunks they cross. **A carried emitter is the same
problem and takes the same path**, so equipping a lantern costs a dynamic paint
and not a rebake.

One thing has to change to allow it. `collectOverrideEmitters` currently derives
an override's light by reading the *placement stack* at that cell — and carried
items are not on the board, by construction. So the override has to carry its
lights explicitly rather than looking them up:

```ts
type EmitterOverride = {
  …position as today…
  /** Lights to cast here. Absent → read the stack, as today. */
  lights?: LightDef[];
};
```

Summing falls out for free: `castEmitter` already accumulates, so N carried
lights at one position is N emitters pushed at the same `fx/fy/fz`, and the
addition is the cast's own. There is no blending rule to invent.

**This is what decides the wire.** Full equipment is *self-only* — nobody else's
inventory is drawn, and sending everyone's to everyone would break the
one-serialization-for-all property that makes patches cheap. But a carried light
is visible to everybody, so a second, much smaller projection is broadcast:

```ts
/** Tile ids of the light-emitting things this actor is carrying. */
carriedLights: string[];
```

Tile ids rather than `LightDef`s, because every client already holds the tile
catalogue and `resolveLight` is right there. It is a pure function of `Equipment`
(`carriedLightTileIds(equipment, tilesById)`, memo-friendly), it changes only
when somebody equips something, and it is a handful of short strings.

The *behaviour* is deferred — Phase 2 ships equipment with no light — but
`Equipment`, the override shape, and the snapshot field are built for it from the
start, because retrofitting the wire is the expensive half.

### Effective stats

```ts
// app/game/equipment.ts
export function effectiveBattler(base: BattlerDef, equipment: Equipment): BattlerDef;
```

Pure, so it can be asserted, and in `app/game/` beside `combat.ts` because it is
a rule of a fight rather than a shape on disk.

- `atk += weapon.atk`, `def += weapon.def`
- `spd -= weight`, `acc -= weight / 2`, both rounded and clamped to 0–100

Weight costs speed at full rate and accuracy at half: a heavy weapon slows how
often you swing more than it spoils the blow.

**Everything that reads stats reads them through this.** `GameSession`'s swing
path calls `resolveBattler` today; it gains the actor's equipment on the way in.
The two that must not be missed are the damage roll and `attackIntervalMs`, since
`spd` is what sets the cooldown.

The Battle tab's readouts keep describing the *base* tile, because that is what
is being authored there. The Item tab gets its own readout saying what a weapon
does to a wielder — read out of the same functions the simulation rolls with,
the discipline `describeDamageBand` already follows.

### Reach is two radii, and neither is push's

Push and switch reach exactly one orthogonal neighbour, because a shove needs an
unambiguous "one cell further away". Neither item action does.

- **Pick up: 1.5 cells, round.** `dx² + dy² ≤ 2.25` — the eight neighbours plus
  your own cell. Plus the existing `INTERACT_LEVEL_SLACK` and top-of-stack rules.
- **Drop: 5 cells, round, and line of sight.** `dx² + dy² ≤ 25`, plus
  `hasLineOfSight`, plus the target stack having room.

> **As built: "plus the top-of-stack rules" was wrong, and it broke the case the
> radius exists for.** The round reach takes in the cell you are standing in on
> purpose — and that is exactly the cell your own body covers, so the sword at
> your feet could not be picked up and the chest you had stepped onto could not
> be opened.
>
> **A body is not a lid.** Cover is now anything without an `owner`, so a crate
> buries a thing and a person standing on it does not — whoever that person is,
> since "whoever stepped on it owns it" is a rule nothing else here plays by.
> For items only: `interactiveDefAt` keeps the strict rule, so push and switch
> are unchanged and a crate under a deer still cannot be shoved.

Both go in `app/game/affordances.ts` as pure functions of board plus actor —
`canPickUpFrom(map, tilesById, actor, ref)` and
`canDropAt(map, tilesById, actor, coord, def)` — for the reason everything else
in that module is there: **the client draws the affordance and the server
validates the action from the same code**, so the client cannot offer something a
tap would refuse.

`objectOptions` currently scans four neighbouring cells across three floors.
Pick-up widens that to a 3×3 across three floors — 27 stack reads, still bounded
by construction, still not a sweep.

### Pick up is a kind; open is only an action

The existing split does the work here unchanged. An `InteractionKind` is
something the `interact` message runs on the server; an `InteractionAction` is
something the list offers — which is already `InteractionKind | "target"`,
because targeting is a row without being a server-side interaction.

- **`"pickUp"` is a kind.** It gets the hover outline, a row, and a server
  message. The precedence `interactionKinds` returns becomes **switch → pickUp →
  push**: an authored switch is an explicit intent and wins, and picking a thing
  up is a better guess than shoving it.
- **`"open"` is an action only**, joining `target` on the far side of that line,
  for the reason above: opening is local panel state, so there is nothing for
  `interact` to run.

`objectOptions` keeps its shape — one kind row per cell, named by whatever a tap
would actually run — and additionally emits an `open` row when the top placement
is a container in reach. So a bag on the floor reads as two rows, **Open** and
**Pick up**, which is the same "one row per verb" rule bodies already follow.

> **As built.** "The top placement" had the same body-is-a-lid bug, and could not
> be fixed by skipping bodies: a body is a subject in its own right, since the
> `player` tile is shovable. A cell therefore offers **at most two slots** — its
> top, and, when that is a body, the topmost thing under it. Not the whole stack:
> reaching under a body is reaching past something soft, and a cell of four
> things does not offer four rows. "Never offer to pick yourself up" now falls
> out of one skip rather than needing a rule of its own.
>
> **The open row is a toggle.** It reads *Close* and lights up while it names the
> box you have open, rather than a second row beside the first — one row per verb
> per thing. `active` was documented as only ever true of a `target`; it now means
> "the state this row names is the one you are in", which is what makes the
> shared lit style a rule rather than a coincidence. It is lit in
> `--color-interact` (the yellow the world's hover outline already wears) and
> **not** in the target's red, which belongs to a fight: a chest that went red
> when you drew your sword would be saying something untrue.

The wrinkle worth naming: `interactionKinds(def)` is a function of the def alone,
and pick-up's reach differs from the other two kinds'. The reach test already
lives per-kind in `affordances`, so this costs nothing structurally — but
`canPickUpFrom` must not be routed through `pushDirectionFrom`, which is where
the orthogonal rule is hardcoded.

### Equipment survives a disconnect

Checkpointed with the world, and stored per actor under `equip:<id>` alongside
`pos:<id>`, with the same cap-and-evict discipline.

A dead player keeps their kit: death deletes the body, a reload hands them a new
one at full health, and this store is what makes their bag still theirs when they
come back. It is also what keeps the world's items conserved — floor items
persist because they are map data, and an inventory that reset on every
disconnect would mean a bag you dropped outlived the one on your back.

Unlike positions, this write is not on a hot path — equipping is rare — so it
needs neither `allowUnconfirmed` nor a throttled flush.

### The wire

Three new client messages, each parsed rather than cast, coordinates bounded to
finite integers exactly as `interact`'s are:

```ts
type SlotRef =
  | { kind: "weapon" }
  | { kind: "bag"; index: number }
  | { kind: "ground"; ref: ObjectRef; index: number };

| { type: "pickUp"; ref: ObjectRef }
| { type: "drop"; from: SlotRef; to: Coord }
| { type: "moveItem"; from: SlotRef; to: SlotRef }
```

> **Decided for Phase 5: the equipped bag needs a name of its own.** It is about
> to become a thing you drag — out of an equipment slot, onto the floor — and
> there is no `SlotRef` that means *the bag itself* rather than a position inside
> it. The shape becomes:
>
> ```ts
> type SlotRef =
>   | { kind: "weapon" }
>   | { kind: "bag" }                                    // the bag on your back
>   | { kind: "contents"; index: number }                // inside that bag
>   | { kind: "ground"; ref: ObjectRef; index: number };
> ```
>
> A rename rather than a fourth case bolted on, because `weapon` and `bag` are
> then exactly the two fields of `Equipment` and `contents` is exactly what it is
> called on an `ItemInstance` — the names line up with the model instead of one of
> them meaning "inside the thing the other one names". Nothing has shipped, so the
> wire is free to change; the cost is mechanical churn through `itemMoves`, the
> protocol schema, both panels and their tests.
>
> Through Phase 4's rules the bag slot is **source-only**: it holds a container,
> and no container may go in a container or in the weapon hand, so nothing accepts
> it until `drop` gives it the floor.

**The line is the board.** `pickUp` and `drop` cross it — a placement becomes an
instance, or the reverse — and carry the world-shaped validation that goes with
it: reach radius, line of sight, whether the target stack has room. `moveItem`
never touches the board; it moves an instance between two slots and validates
capacity and nesting. Equipping, unequipping and looting a corpse are all the
same operation under that reading, so they are one message rather than three
near-identical ones.

A ground container's slots are reachable from `SlotRef` because its contents are
slots like any other — but the `ref` in one is re-validated for reach on every
call, since the panel that produced it may have been open while its owner walked
away.

Slots are addressed **by index, never by instance id**. A client naming an id
would be naming a thing the server has to go looking for; an index is validated
against a container whose size the server already knows. Ids exist for tracing,
not for addressing.

> **As built.** `equipment` did not go on `hello`/`patch` as a field: a patch is
> diffed once and serialized once for everybody, which only works because
> everybody is told the same thing, and a kit differs per socket. It rides its
> own `equipment` message to the owner alone. `hello` does carry one, since a
> joiner has nothing to patch against.
>
> Three notes on `moveItem`, all of them about the index:
>
> - **A destination always appends.** Slots fill in order and position in a bag
>   means nothing, so the index is meaningful at the *source* end only and is
>   ignored at the far end. One type for both ends is worth the wart; two would
>   be two schemas for one operation.
> - **A move within one container is refused.** There is no reordering, so a drag
>   from one square of a bag to another is asking for something the model does not
>   have. This is also what makes the capacity check sound against the state
>   *before* the source is emptied: two different containers cannot free each
>   other's room.
> - **The weapon slot takes weapons.** The nesting rule and this one live in a
>   single gate (`slotAccepts`), which is what lets the test for "no container may
>   hold a container" be exhaustive rather than hopeful — bag → chest, chest →
>   bag and chest → chest all ask the same question.
>
> `moveItem` is **not** gated on the actor being idle, unlike `pickUp` and
> `push`. Those move the board and are held against the actor so they cannot be
> machine-gunned; this rearranges what somebody is carrying, and refusing to let
> a walking player draw a sword would be a rule with nothing behind it. Reach for
> a ground endpoint is re-asked regardless, against the cell the actor has
> committed to.

On `hello` and `patch`: `equipment` (self-only, sent when it changed) and
`carriedLights` per actor (broadcast, same diffed-array treatment as `hps`).

`pickUp` deliberately has no reply of its own: the cell patch removing the item
from the board and the equipment patch adding it to the bag are both already
being sent, and together they *are* the confirmation.

### Drag and drop is pointer events, not HTML5 DnD

The HTML5 drag API does not fire on touch, and half of this feature is a thumb
dragging a sprite onto the world. One shared pointer-events hook, one drag layer
above the canvas, used by every drag here: inventory → world, inventory → slot,
slot → world.

The drop ghost is the renderer's business, not React's. The page hands the
renderer the dragged tile id and the pointer position; the renderer resolves
screen → cell with the existing `pickTileAt`, asks `canDropAt`, and draws a
translucent quad or nothing. Routing a ghost through React state would re-render
the page on every pixel of the drag.

> **As built** (`components/useItemDrag.ts`, `components/DragLayer.tsx`). The
> same discipline applies inside the panels: the dragged sprite is positioned by
> writing a transform onto its node, not through React state, so a drag re-renders
> the page only when what it would land on changes.
>
> Slots register their elements with the hook and drops are hit-tested against
> those rectangles. `@dnd-kit/react` is already a dependency — the editor's
> sortables use it — and was not used here, because Phase 5 needs a ghost drawn
> by the *renderer* over the canvas, which is outside its model. Worth
> re-deciding before Phase 5 rather than after.
>
> **Every slot is also a button: press one to lift, press another to place.**
> Pulled forward from Phase 6 deliberately (see there), and it is the same pair
> of questions the drag asks — may this move, and do it — so there is one rule
> and no second implementation to drift from it.
>
> The two nearly ate each other, and the bug is worth knowing before touching
> this file. With something lifted, *every* subsequent press releases a pointer
> somewhere; a release handler that assumed a drag was ending put the item down
> before the click that was about to place it ever ran. The release turns on
> whether a pointer is **carrying** the thing, not on whether anything is in hand.

---

## Phases

Vertical slices. Each is demoable on its own and leaves the build green.

### Phase 1 — Kind, and an item you can author  ✅

No play behaviour. The deliverable is that a weapon and a bag exist in
`data/tiles.json`.

- `TileDef.kind`, required. `data/tiles.json` edited inline; every `TileDef`
  literal in app code and tests updated until it compiles.
- `app/lib/item.ts`: the union, the schema, `resolveItem`, `DEFAULT_WEAPON`,
  `DEFAULT_CONTAINER`.
- `resolveBattler` gains its kind gate.
- `InteractiveTab`: the Prop | Battler | Item select at the top, above Push.
  Switching kind clears the block being left behind.
- `BattleTab`: loses its switch; renders the six stats unconditionally.
- New `ItemTab`: the type select (Weapon | Container), then the weapon fields
  (atk, def, weight, mastery) or the container fields (size, equippable), with a
  readout of what the weapon does to a wielder.
- `TileEditorDialog`: Battle tab shown only for kind `battler`, Item tab only for
  kind `item`.
- `interactionsForSave` / `hasAnyInteraction` learn about `item`.
- Authored content: a `rusty-sword` and a `basic-bag` (container, size 4,
  equippable) with placeholder sprites off an existing tileset, both flat and
  intangible so they lie on the floor without blocking it. A `crate-chest`
  (container, size 2, not equippable) is worth authoring too — it is the cheapest
  stand-in for a corpse and it exercises the non-equippable path before there is
  any corpse to test against.

Files: `app/lib/types.ts`, `app/lib/item.ts` (new), `app/lib/battler.ts`,
`app/lib/interactions.ts`, `app/components/InteractiveTab.tsx`,
`app/components/BattleTab.tsx`, `app/components/ItemTab.tsx` (new),
`app/components/TileEditorDialog.tsx`, `data/tiles.json`.

> **As built.** The placeholders are gone: the sword, the bag and the chest are
> drawn in `tiny-ranch-tiles` beside everything else the world is built from. The
> sword and bag are 1×1 where the chest is 2×2, which is the art's own call and
> not a rule about items.

### Phase 2 — Instances, equipment, and two panels to see it in  ✅

Still nothing to pick up. The deliverable is that you spawn with a bag on your
back and can see it.

- `ItemInstance`; `PlacedTile.itemId`; the placement ↔ instance conversion pair,
  in one module so the correspondence is visible.
- Id minting in the world-load adoption pass.
- `Equipment` on `ActorRuntime`, seeded at spawn with an empty weapon slot and a
  `basic-bag` instance. Named constants, not literals, in `app/game/constants.ts`.
- `effectiveBattler` in `app/game/equipment.ts`, wired into the swing path and
  `attackIntervalMs`.
- `equipment` on `GameSnapshot` (self-only) and on `hello` / `patch`;
  `RemoteSession` holds it. `carriedLightTileIds` written and unit-tested now,
  broadcast wired now, *consumed* in Phase 6.
- **Equipment panel**: the weapon slot, empty. **Container panel**: a contents
  grid sized by its subject's `size`, built against `ContainerSubject` from the
  start even though Phase 2 only ever passes `{ kind: "equipped" }` — the ground
  case in Phase 3 should be a new caller, not a rewrite.
- Action strip gains two buttons: a toggle-equipment button, and a backpack
  button drawn as the *literal tile* of the equipped bag (`TilePreview`, which
  already does this for interaction rows).

> **Reversed in Phase 5, and the reason it was written is the reason it goes.**
> The literal tile was there because bags differ from each other and a button
> that looked the same whichever you wore would hide the only fact about it you
> can see at a glance. The equipment panel is about to grow a **bag slot** beside
> the weapon slot, drawn as that same literal tile — so the fact is on screen
> either way, and the strip button no longer has to carry it. It becomes a plain
> Tabler backpack glyph, matching the shirt beside it, and reads as *a button
> that opens a thing* rather than as a small picture of your luggage.
>
> The fullness badge stays: that is a fact about the bag the slot does not show.
> Phase 2's "the bag is deliberately not in the equipment panel" no longer holds
> — it is worn, the panel is what you are wearing, and dragging it out of a slot
> is how you take it off.
- Layout. Desktop: both panels open by default, in the aside between the modes
  row and the interaction list — the 224px aside will need to widen, or the grids
  stay compact. Mobile: both closed by default; an open panel replaces the main
  area (arrows + interaction list) but never the button row, so it can always be
  closed again. **Opening one closes the other**, since they want the same space.

Files: `app/lib/types.ts`, `app/lib/item.ts`, `app/game/GameSession.ts`,
`app/game/equipment.ts` (new), `app/game/constants.ts`, `app/net/protocol.ts`,
`app/net/RemoteSession.ts`, `workers/GameServer.ts`,
`app/components/EquipmentPanel.tsx` (new), `app/components/BackpackPanel.tsx`
(new), `app/components/GameViewport.tsx`, `app/routes/online.tsx`,
`app/routes/play.tsx`.

### Phase 3 — Pick up, and open from the ground  ✅

The first end-to-end slice: an item on the map ends up in your bag, with its id
and its metadata intact — and a chest on the floor can be looked into.

- `canPickUpFrom` in `affordances.ts`: the 1.5-cell round radius, the level
  slack, the top-of-stack rule, "is an item", and "there is somewhere to put
  it" — which for an equippable container means *no bag currently equipped*, for
  a non-equippable one means never (containers do not nest), and for anything
  else means a free slot.
- `canOpenFrom`, sharing the same radius.
- `"pickUp"` in `InteractionKind` and `interactionKinds`; `"open"` in
  `InteractionAction` only.
- `objectOptions` widens to the 3×3, grows a `pickUp` row, and emits an `open`
  row beside it for a container in reach. Two icons needed.
- The container panel gains its `{ kind: "placement" }` subject and the
  walked-out-of-range close.
- `PlaySession.pickUp(ref)`; the `pickUp` client message; server validation
  re-running the same affordance.
- Picking up a container lifts the whole instance, `contents` and all.

Files: `app/game/affordances.ts`, `app/lib/interactions.ts`,
`app/game/interactionOptions.ts`, `app/components/InteractionList.tsx`,
`app/components/ContainerPanel.tsx`, `app/game/GameSession.ts`,
`app/net/protocol.ts`, `app/net/RemoteSession.ts`.

### Phase 4 — Moving items between slots  ✅

- The pointer-events drag hook and the drag layer.
- Drag bag → weapon slot: a ghost when it would fit, nothing when it would not.
- Drag weapon slot → bag as the unequip inverse.
- Drag ground container → bag, which is looting, and the reverse, which is
  stashing.
- **No container may hold a container**, checked in one place that every one of
  those directions goes through.
- `moveItem` and its server-side validation: capacity, nesting, and — for a
  `ground` endpoint — reach, re-asked rather than trusted.

> **As built, plus four things this phase grew.**
>
> - **The keyboard two-step**, pulled forward from Phase 6. See there.
> - **The bag button in the action strip is a drop target.** A bag you have to
>   open before you can stash anything is two gestures for one intention, and on
>   a phone the open panel covers the game — so the shortest path from a chest on
>   the floor to your back should not go through a panel that hides the floor. It
>   registers under its own key rather than the slot's, because the bag's first
>   slot may already be on screen and two elements cannot share one registry
>   entry; both resolve to the same append.
> - **It also carries its own fullness**, as a `2/4` in the corner that inverts to
>   paper when full — full is the state that stops the next pickup, and it should
>   be read off the colour rather than by comparing two numbers.
> - **Containers are drawn as containers**: walls and a floor around the whole
>   panel, the tile's own sprite beside the name, and a square close button inside
>   the walls that every container has — the bag on your back included, where it
>   only puts the panel away.
>
> Not done here and worth knowing: **`/online` was never exercised end to end by
> hand.** Every layer has tests and the client is verified in `/play`, but no
> connected pair of browsers has moved an item between slots.

### Phase 5 — Drop

- `canDropAt` in `affordances.ts`: 5-cell round radius, `hasLineOfSight`, and the
  target stack having room.
- Renderer: `setDropGhost(tileId, screenPoint)` resolving through `pickTileAt`,
  drawing a translucent quad where the drop is legal and nothing where it is not.
  No UI says why a drop is refused; the absent ghost is the whole answer.
- `drop` message; the server writes the instance back to a placement on top of
  the target stack and lets gravity settle it, exactly as any other placement.
- Dropping a container writes the instance — contents and all — into the
  placement, which is the exact inverse of the pickup in Phase 3 and should share
  its conversion pair.
- **Strip `itemId` and nested `contents` ids on the way to `data/map.json`**, and
  re-mint them at load. See open question 1. It belongs to this phase because
  this is the phase that makes a placement rewritten by *play* land in the
  authored file.
- The backpack button in the action strip is a drag *source*, so a bag is dropped
  by dragging it out of the strip onto the floor.

> **Decided before starting.** Three answers, and the first one changes the last
> bullet above.
>
> **The backpack button stays two things, not three: tap opens, drop-on stashes.**
> Dragging your bag out of the action strip is dropped entirely — instead the
> **equipment panel gains a bag slot** beside the weapon slot, and the bag is
> dragged out of it like any other item. One rule for taking things off, and the
> most-tapped button in the strip keeps a single meaning. The strip icon becomes
> a generic Tabler backpack, since the slot now carries the literal tile.
>
> **`SlotRef` is renamed to make room for it** — `bag` becomes the slot, the old
> `bag` becomes `contents`. See *The wire*.
>
> **No keyboard equivalent for dropping at a cell, deliberately.** Placing into a
> slot is a second press; placing into the world is a coordinate, and inventing
> an aiming affordance for it is a bigger question than this phase. Phase 5 ships
> drag-only for the world, which is a *known* gap rather than an oversight — see
> Phase 6. Everything else stays keyboard-operable, including taking the bag off,
> since that is a slot-to-slot move until the moment it leaves for the floor.
>
> Still true and still the one structural addition: the drag hook hit-tests
> against registered slot *elements*, and the world is not one.

### Phase 6 — Carried light, persistence, and the edges

- `EmitterOverride.lights`; `collectOverrideEmitters` honouring it;
  `emitterOverridesFor` folding an actor's `carriedLights` in beside their body's
  own. Verify against the thing this is all shaped to avoid: **walking with a lit
  torch must not rebake a single chunk.**
- `equip:<id>` beside `pos:<id>`, capped and pruned; equipment in the checkpoint;
  re-seated on spawn on the same "the map wins over the memory" terms positions
  already follow.
- Accessibility pass on both panels: a drag-only interface is unusable by
  keyboard, so every drag needs a non-drag equivalent (a row action, or a
  focus-then-activate two-step). This is not optional and it is far easier to
  design in Phase 2 than to retrofit here.

> **Mostly done in Phase 4, on that advice.** Every slot is a button carrying a
> lift-and-place two-step, announced through `aria-pressed` and a label that says
> what pressing it would do. What is left here is an audit rather than a retrofit
> — and two known gaps, both deliberate:
>
> - **The strip's bag button takes drops but not a lifted item.** It toggles the
>   panel instead, which reaches the slots in one extra press.
> - **Dropping into the world is drag-only.** Decided in Phase 5 rather than
>   discovered: aiming a cell without a pointer needs an affordance nobody has
>   designed, and guessing at one is worse than naming the gap. Whatever it turns
>   out to be — a "drop at your feet" row, a cell cursor — it belongs here.

---

## Testing

Existing culture is pure modules asserted directly; this fits it.

- `item.test.ts` — schema, malformed blocks reading as null, kind gating, and a
  container's `equippable` surviving the round trip through `interactionsForSave`.
- Instance round trip — placement → instance → placement preserves id, channel,
  description, direction and nested contents. The test that catches the next
  field somebody adds to one side only.
- `equipment.test.ts` — `effectiveBattler` at the clamps, weight's asymmetric
  cost to spd and acc; `carriedLightTileIds` over an empty bag, a lit weapon, and
  a bag holding two lit things.
- `affordances.test.ts` — pick-up radius includes diagonals and excludes 2 cells;
  open shares that radius; drop radius, LoS blocked by a wall, stack with no room.
- `interactionOptions.test.ts` — the pickUp row, its precedence against switch
  and push, the open row appearing beside it for a ground container, and the 3×3
  bound.
- `GameSession.test.ts` — pick up removes the placement and fills a slot; drop
  does the inverse; a container's contents survive the round trip; a second bag
  is refused; a container inside a container is refused in every direction
  `moveItem` allows; a full container refuses a pickup; looting a ground
  container out of reach is refused; two instances of one tile keep distinct ids.
- `protocol.test.ts` — the three new messages parse, malformed ones drop, an
  out-of-range slot index is refused, and a `ground` slot ref with a
  non-integer coordinate is refused.

> **As built.** The session tests are in `sessionEquipment.test.ts` rather than a
> `GameSession.test.ts`, and the move rules got their own file
> (`itemMoves.test.ts`) because they are pure and shared by both ends of the
> wire. `protocol.test.ts` did not exist before this and now does.
>
> One correction to the list above: an **out-of-range slot index is not refused
> by the schema**. What an index may be depends on the size of the container it
> is read against, which the session knows and a schema does not — so it parses,
> reads as an empty slot, and is refused in the one place capacity is understood.
> The schema's job is only to keep it a whole number that is not negative.
>
> `openedContainer.test.ts` is new and covers the rule that gave the most
> trouble: in reach, out of reach, and the substitutions that must not be shown.

---

## Open questions

Not blocking Phase 1, but each needs an answer before the phase that hits it.

1. ~~**Does an editor save writing minted `itemId`s into `data/map.json` bother
   you?**~~ (Phase 2.) **Settled: strip them on the way to disk, keep them in the
   checkpoint.** `data/map.json` is authored content and its diffs have to stay
   reviewable — the property the dev disk backend exists to preserve — and
   looting a chest now rewrites placements through ordinary play, so ids were
   about to arrive in that file by simply playing the game. A running world keeps
   its ids across an eviction, because the checkpoint is runtime state and that is
   what identity is; a world reloaded from the file re-mints, which costs
   traceability across a from-disk restart that nothing currently reads.
   Applies to nested `contents` ids too, on the same terms: a chest's contents are
   authored by tile, not by identity.
2. **Can a creature carry anything?** Nothing in the model prevents it — an
   `ActorRuntime` is an `ActorRuntime`. This plan seeds equipment only for
   players, and a deer with a sword is out of scope, but the door is open.
3. **Should a bag's own weight matter?** Bags have only `size` per the scope. A
   heavy full bag slowing you is the obvious next lever and would go in the same
   `effectiveBattler`.
4. ~~**Does the desktop aside widen, or do the grids get compact?**~~ (Phase 2.)
   **Settled:** the aside stayed at 224px and the grids are compact, so the game
   square still does not resize as you walk.
5. **Can you walk with a container open on a phone?** (Phase 5/6.) Today you
   cannot: an open panel replaces the arrows, so the close-on-out-of-reach rule
   is unreachable by thumb and the ✕ is the only way out. Left alone for now —
   the game square stays visible above the panel, so dragging an item from a bag
   onto the world still works on touch, and only *walking* is blocked. Revisit if
   it bites.
6. ~~**What colour is focus, and what colour is a drop target?**~~ **Settled:
   both stay green.** The four world colours say what a thing *is* — yellow acts,
   red fights, white singles out, blue looks — and green is deliberately outside
   them: it is chrome, worn by focus and by a drop target, neither of which is a
   state the world has. Being a fifth colour is what keeps it from being mistaken
   for one of the four.

Two and three are the only ones still open, and neither blocks anything: both
are doors the model leaves ajar rather than decisions anybody is waiting on.

## Explicitly out of scope

Named so they do not creep in: reordering items between slots, stacking or
quantities, durability or charges, nested containers, armour or any slot beyond
weapon and bag, anything `mastery` actually does, a visible weapon on a body,
trading or giving items to another player, a live `channel` on a carried item,
respawn behaviour, and **corpse generation** — what a death leaves behind, which
tile the body becomes, and any notion of a loot table. The container model has
room for a corpse; nothing in these phases creates one.
