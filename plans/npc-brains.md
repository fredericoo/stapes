# Plan: NPC brains

> Source: design conversation, not a PRD. The requirements are the decisions
> below; there are no user stories to trace to, so each phase states what it is
> demoable as instead.

Composable NPCs — a deer that idles, wanders, flees you and settles down again;
a cat that follows you while you are close — built as authored state machines on
tile defs. The animating idea is that almost none of this is new machinery:

**An NPC is an actor without a socket.**

`ActorRuntime` already holds input, walk, fall, slide and a location memo.
`GameSession.tick` already advances actors in insertion order, deterministically.
The wire already announces `walkStarted` / `fallStarted` for any actor, and the
client already interpolates them without asking who is driving. So a brain whose
output is a step request inherits gravity, collision arbitration, plate pressing,
falling off ledges, and the entire netcode, unchanged. The only genuinely new
thing is the brain: a function from (world, self, memory) to a direction.

---

## Architectural decisions

Durable across every phase.

### Identity

- **An actor is any placement carrying an `owner`**, not just the `player` tile.
  Actor identity is currently hardcoded to `PLAYER_TILE_ID`; generalising it is
  the structural unlock and the first thing built.
- **`owner` means "which runtime drives this body"**, not "which person". A
  player's owner is their cookie id; an NPC's is minted at spawn from the cell it
  was authored in (`npc:12,3,0`), which reads better in a log than a counter and
  is stable across reloads.
- **No spawner concept.** Any placement whose tile def has a brain becomes an
  actor at load. Authoring a deer is placing a deer.

### Where a brain lives

- **`interactions.brain` on the tile def**, alongside `push`, `switch`,
  `pressurePlate`, `emit` and `receive`. Same trust model as all five: parsed
  with valibot, memoised on def identity, and **a malformed brain means an inert
  NPC rather than a crashed world**. It is by far the largest authored blob in
  the file, so that discipline matters most here.
- Every placement of a tile shares its brain. Instance state lives in the
  runtime, keyed by owner.

### Shape of a brain

Flat state machine. Ordered transitions, first match wins, `any` as a source
state. Hierarchy is deliberately absent — it is the thing to add when a creature
needs `alive{...}` versus `dead`, and not before.

```jsonc
{
  "initial": "idle",
  "states": {
    "idle":   { "do": [{ "action": "hold" }] },
    "wander": { "do": [{ "action": "step_random" }, { "action": "hold" }] },
    "flee":   {
      "onEnter": [{ "effect": "say", "text": "!" }],
      "do": [
        { "action": "step_away_from", "of": "$target", "allowDrops": true },
        { "action": "hold" }
      ]
    }
  },
  "transitions": [
    { "from": "idle",   "if": { "cond": "after", "ms": 5000 }, "to": "wander" },
    { "from": "wander", "if": { "cond": "in_range", "of": "nearest_player", "cells": 4 },
      "bind": { "target": "nearest_player" }, "to": "flee" },
    { "from": "flee",   "if": { "cond": "out_of_range", "of": "$target", "cells": 8 },
      "to": "idle" }
  ]
}
```

- **Array order is priority.** No separate priority field — the list is the
  semantics, which is also why there is no graph (see below).
- **Transitions bind, states read.** `in_range(nearest_player)` writes an id into
  a blackboard slot; `step_away_from($target)` and `out_of_range($target)` read
  the same one. Re-querying "nearest player" each tick would make a deer between
  two players flip target and jitter on the spot.
- **Selectors**: `self`, `nearest_player`, `nearest(tag)`, `$slot`. Tags matter
  early — `nearest(prey)` is how a wolf gets written without hardcoding "deer".
- **No boolean composition** (`and`/`or`/`not`) in v1. It doubles the schema and
  quadruples the editor; two transitions through an intermediate state covers
  most of it. Add `all: [...]` when it actually hurts.

### Shape of a state body

- **`onEnter`** is a list of effects, run once on entry. Effects always succeed,
  which is exactly why they are kept out of the priority list below.
- **`do`** is an ordered priority list of actions. Each returns
  **success / failure / running** — the behaviour-tree leaf protocol. The rule is
  *first action that does not fail*; a running action stops the scan and is
  resumed next brain tick.
- **Re-evaluated from the top every brain tick.** A higher-priority action may
  preempt a running one, and preemption resets the interrupted action's progress.
  The cost is that a flickering condition above `walk_n_steps(3)` keeps
  restarting it; the benefit is that NPCs stay reactive inside a state.
- **An action may hold a counter or a timer. It may not hold a decision.**
  `walk_n_steps(3)` and `wait(2s)` are fine. `patrol_between(a, b)` is a state
  machine hiding inside an action, and the moment one exists, half the creature's
  behaviour is invisible to the transition table. This line is the whole
  difference between sequencing actions and a scripting language.

### Registries

Conditions, actions and effects are **TypeScript registries keyed by name**;
authored JSON references them by name and never contains code. That is what
keeps brains serializable, the editor a set of dropdowns, and untrusted authored
content safe to load.

### Runtime and cost

- **Brains tick at 200ms**, six simulation ticks — one decision per walk length.
  A whole number of ticks, because a fractional one would not be reproducible.
  Bodies keep moving at the 30Hz simulation rate; movement actions simply report
  `running` while a step is in flight.
- **Brains freeze when no player-driven actor is connected.** An empty world must
  stay at rest so the Durable Object can still hibernate — a single deer on a
  timer would otherwise hold a 30Hz interval open forever, in an empty world,
  for nobody. The at-rest condition becomes "no players present, and nothing
  still in motion": **brains stop deciding, bodies finish the step they are on**.
  Freezing mid-walk would checkpoint an actor halfway between two cells, and the
  entire session is written around a step only being real once it lands.
- **The session must not learn about sockets** to do this. If NPCs are actors,
  the question is "is any player-driven actor present", which the session can
  already answer — and it stays testable in node.

### Persistence

- **Position persists; the mind resets.** Bodies are placements, so NPC positions
  already ride in the checkpoint for free. Brain state — current state, blackboard,
  action scratch — resets to `initial` on load. No observer, no continuity
  obligation: a deer that forgets it was fleeing while the world was empty is
  unfalsifiable, and this deletes both a serialization surface and the migration
  problem of a checkpoint holding slots a since-edited brain no longer has.
- **The PRNG seed travels with the world**, alongside the map and spawn point.
  `step_random` cannot use `Math.random()` or every eviction reshuffles the herd.

### Protocol

**No new wire messages.** NPC motion is already expressible as the existing
`walkStarted` / `fallStarted` events plus cell patches. Clients do not need to
know which actors are people. Brains run server-side only and are never
predicted.

### Authoring

**Tables, not a canvas.** Order is the semantics and a node graph renders edge
ordering badly — it would draw five edges out of `idle` with no indication which
wins. The editor is a states table and an ordered transitions table with
drag-reorder, in the shape the tiles editor already has. No new graph dependency,
no persisted node positions to keep honest across renames.

### Out of scope

Boolean condition composition, multi-cell creatures, pushable NPCs, and
everything player→NPC — dialogue, trade, tapping one. Those ride the existing
`interact` path and are a separate design.

### Pathfinding: deferred, not dismissed

Movement actions choose a **direction**, not a route: the best step towards or
away from a target, evaluated fresh each brain tick. Greedy chasing is fine in
open ground and visibly stupid against a wall — round a corner and a cat pins
itself flat against it, following you in spirit. For a pet in a room that reads
as charming; for a guard it will read as broken, and that is when A\* earns its
place.

Deferring it costs nothing later because the seam is already in the right place.
A movement action's contract is "given the world and a target, produce a step",
so a router can be swapped in behind exactly that interface without the state
machine, the schema, the editor or the wire noticing. What A\* will bring with it
is a per-tick budget question — paths are the first thing here that cannot be
recomputed for every NPC on every brain tick — and that is the real reason it is
its own piece of work rather than a line item.

---

## Phase 1: A body with no mind

**Demoable as**: place a deer tile in the editor and it appears for everyone
online. Build the floor out from under it and it falls. Reconnect and it is
still where it landed. The world with only deer in it still goes to sleep.

### What to build

Generalise actor identity from "the `player` tile with an owner" to "any
placement with an owner", and spawn one actor per placement of a tile marked as
an actor at world load. No brain, no state machine — the deer stands there and
obeys physics.

This is the whole structural change, shipped and provable before any behaviour
rides on it. Three existing behaviours need to learn the difference between a
player and an NPC: the reaper that removes bodies with no socket must leave NPCs
alone; restore-after-eviction must re-seat them; and the at-rest check must not
count a motionless NPC as a reason to stay awake.

One easy thing to miss: the renderer keeps mobile tiles out of the merged
geometry batch and the static light bake, and decides what counts from gravity
and pushability. An NPC is mobile by definition. A deer with gravity is covered
by accident, but a hovering one would be baked into the floor and smear across
it when it moved.

### Acceptance criteria

- [x] A placement of an actor-marked tile becomes an actor at load, with an owner
      minted from its authored cell
- [x] NPCs fall, land, and press pressure plates exactly as players do, with no
      new code on those paths
- [x] Eviction and restore leaves NPCs on the board and in position; the reaper
      removes disconnected players only
- [x] A world containing NPCs and no players reaches at-rest and hibernates
- [x] NPC placements are excluded from the static geometry batch and light bake
- [x] Two clients see the same NPC in the same cell

---

## Phase 2: The wandering deer

**Demoable as**: a hand-authored deer in `tiles.json` idles for five seconds,
then wanders. Two browsers see it wander identically. Everybody leaves, the world
sleeps mid-behaviour, and it picks up on the next join.

### What to build

The brain block, its parser, and the state-machine runtime — the tracer bullet
through the entire architecture, with the smallest vocabulary that makes a
creature move: one condition (`after`), two actions (`step_random`, `hold`), no
blackboard, no effects.

The runtime is the durable part: `initial` state, ordered transitions with an
`any` source and first-match-wins, and a `do` priority list whose actions return
success/failure/running, re-evaluated from the top each brain tick. Plus the two
policies that make it affordable — the 200ms brain tick, and freezing when no
players are connected — and the seeded PRNG that makes `step_random`
reproducible across a checkpoint.

A brain that fails to parse produces an NPC that stands still, and says so in the
editor rather than at runtime.

### Acceptance criteria

- [x] `interactions.brain` parses with valibot; a malformed brain yields an inert
      NPC and never throws mid-tick
- [x] A deer transitions `idle → wander` after its authored delay and steps to a
      random walkable neighbour
- [x] Brains evaluate every 200ms — a whole number of simulation ticks — while
      bodies continue to move at tick rate
- [x] Two sessions fed the same seed and inputs produce identical NPC paths
- [x] When the last player disconnects, brains stop deciding, any in-flight step
      completes, and the world reaches at-rest
- [x] On reload, NPC positions are restored and brain state resets to `initial`
- [x] The priority list falls through a failing action to the next one

---

## Phase 3: It notices you

**Demoable as**: two creatures from one vocabulary. The deer from the original
sketch — walk towards it and it bolts, back off and it settles. And a cat that
follows you while you are within three cells, and loses interest when you are
not.

### What to build

The blackboard, and the conditions and actions that use it. Transitions gain an
optional `bind` that writes a selector's resolved id into a named slot; states
read it back as `$slot`.

The cat is the more valuable of the two demos despite being the same size,
because it is the first thing built that nobody designed the vocabulary around.
`step_toward($target)` is `step_away_from($target)` with the comparison flipped,
and the cat's brain is the deer's with two states renamed — which is the evidence
that this is a system rather than a deer with settings.

```jsonc
{
  "initial": "idle",
  "states": {
    "idle":   { "do": [{ "action": "hold" }] },
    "follow": { "do": [{ "action": "step_toward", "of": "$target" }, { "action": "hold" }] }
  },
  "transitions": [
    { "from": "idle",   "if": { "cond": "in_range", "of": "nearest_player", "cells": 3 },
      "bind": { "target": "nearest_player" }, "to": "follow" },
    { "from": "follow", "if": { "cond": "out_of_range", "of": "$target", "cells": 3 },
      "to": "idle" }
  ]
}
```

Note the two thresholds are equal there, which will make a cat at exactly three
cells flip state every brain tick. Whether that is fixed with hysteresis — a
wider release range, as the deer's 4/8 does — or left as authored is worth
deciding here rather than discovering later; the deer's asymmetry is currently
the only thing hiding the problem.

That a flee or follow state keeps tracking *the same* player is the entire point
of binding, and the cheapest way to see the design working: re-resolving
`nearest_player` every tick makes a creature standing between two people
oscillate between them.

`in_range` needs a metric, and the cheap one is right: Manhattan distance on the
viewer's level ±1, matching the reach slack that interaction already uses. No
line of sight — that is a raycast through a chunked voxel map and a much larger
conversation, and neither animal needs it.

Expect the cat to press itself into corners when you round one. That is the
greedy step working as specified, and the demo that argues for A\* later.

### Acceptance criteria

- [ ] A transition can bind a selector to a blackboard slot; states resolve
      `$slot` back to the same actor
- [ ] A deer flees, and a cat follows, the player who triggered the transition —
      not whoever is nearest this tick
- [ ] Both creatures are authored from the same conditions and actions, differing
      only in data
- [ ] `out_of_range($target)` returns each to idle
- [ ] A bound target that leaves the world is handled — the condition fails
      rather than throwing, and the creature settles
- [ ] A cat held at exactly its threshold distance settles on one state rather
      than flipping every brain tick
- [ ] Blackboard contents reset with the rest of brain state on load

---

## Phase 4: Cornered

**Demoable as**: back a deer into a corner and it cowers instead of jittering
against the wall. A fleeing one takes a drop it would never have grazed over.

### What to build

Expose action failure to the transition table. Once actions report failure,
"every action in this state failed" is just another predicate, and cornered,
blocked, arrived and nowhere-to-go all collapse into it — no nested conditions,
no branching inside a state.

Plus action parameters, of which `allowDrops` is the first: a fleeing deer
permits a descent a wandering one would refuse. That is a property of the
behaviour, authored once, rather than a decision taken per tick.

### Acceptance criteria

- [ ] A state whose every action fails is available as a transition condition
- [ ] A cornered deer reaches a distinct state rather than retrying a blocked
      step every brain tick
- [ ] `allowDrops` changes which steps a movement action will take, and is
      authored per action rather than per creature
- [ ] A deer that flees off a ledge falls and recovers under the existing gravity
      path, with no brain-specific handling

---

## Phase 5: Actions that take time

**Demoable as**: a deer that grazes for three seconds, takes four steps, then
looks around — and that abandons all of it the instant you get close.

### What to build

Scratch storage for actions that hold progress across brain ticks, keyed per
actor, state and position in the list, and cleared both on state exit and on
preemption by a higher-priority action. `walk_n_steps(n)` and `wait(ms)` are the
two that prove it.

The preemption reset is the subtle half. Because the list is re-scanned from the
top every tick, an action that was running and is then skipped must not resume
mid-count when it is next selected — it starts over, which is the behaviour that
matches what an author sees in the table.

Nothing here reaches the checkpoint: action scratch is brain state, and brain
state already resets on load.

### Acceptance criteria

- [ ] An action can return `running` across multiple brain ticks and resume where
      it left off
- [ ] Entering a different state clears the previous state's action progress
- [ ] A preempted action restarts rather than resuming when next selected
- [ ] Action scratch never reaches the checkpoint
- [ ] A long-running action does not prevent a transition from firing

---

## Phase 6: A deer that yelps

**Demoable as**: startle a deer and it says "!" over its head. Startle the herd
and an alarm channel opens the gate at the far end of the field.

### What to build

`onEnter` effects, drawing on two systems that already exist. Chat bubbles are
pinned to a cell and keyed by actor, and are already sent per level — an NPC
saying something needs no new wire message and no new renderer work. Signal
channels already drive doors and receivers, so an NPC that emits on entering a
state composes with every mechanism already authorable in the map.

That second one is the highest-leverage item in the plan for its size: it makes
NPCs part of the existing puzzle vocabulary rather than a parallel system beside
it.

### Acceptance criteria

- [ ] A state can emit speech on entry, visible to players on that level and
      subject to the same sanitisation and caps as player chat
- [ ] A state can drive a signal channel on entry, and an authored receiver
      responds
- [ ] Effects run exactly once per entry, and never contribute to the priority
      list's success or failure
- [ ] An NPC that emits and then leaves the state releases the channel as the
      existing settle pass expects

---

## Phase 7: Authoring without JSON

**Demoable as**: build a new creature — states, actions, transitions, ordering —
entirely in the tiles editor, and watch it come alive online without a reload.

### What to build

Two tables in the tile def editor, beside the existing interaction blocks: states
with their `onEnter` and `do` lists, and the ordered transition list with
drag-reorder. Conditions, actions and effects are dropdowns fed by the registries,
so the editor cannot author a name the runtime does not implement.

Validation is surfaced here rather than at runtime, since this is the point where
it is actionable: unreachable states, transitions to states that do not exist,
and an empty or missing `initial`.

Ordering is the one thing the UI must make obvious, because it is the semantics
and it is invisible in any other rendering.

### Acceptance criteria

- [ ] States, actions, effects and transitions are all editable without hand-editing JSON
- [ ] Transition order is visible and reorderable, and the saved order is what the
      runtime evaluates
- [ ] Condition, action and effect pickers offer only registered names
- [ ] Unreachable states, unknown transition targets and a missing `initial` are
      reported in the editor
- [ ] A saved brain reaches connected players through the existing world-replace
      path
- [ ] A brain authored in the UI round-trips through `tiles.json` unchanged
