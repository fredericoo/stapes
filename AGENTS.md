# Agent notes — Stapes

## The server is a Cloudflare Worker

`app/` and `workers/` run in workerd, not Node. There is no filesystem, so
authored content (map, tiles, tilesets, PNGs) is reached through
`app/lib/storage.server.ts`, never through `node:fs`.

- Bindings arrive via React Router 8's context, not the v7 `AppLoadContext`.
  A loader or action gets the store with `dataStore(context)`; both contexts are
  set once per request in `workers/app.ts`. Docs and older examples showing
  `context.cloudflare.env` are written for v7 and will not typecheck.
- `tsconfig.json` covers `app/` and `workers/` and deliberately excludes Node
  types, so a `node:` import fails at typecheck rather than on deploy. Build
  tooling and tests that genuinely run in Node live under `tsconfig.node.json`.

### Two storage backends, one interface

`DataStore` owns every decision about what the bytes mean — parsing a map,
normalising tile defs, guarding a tileset filename. Underneath it, `Blobs` is a
dumb get/put by key with two implementations, and that split is the point: the
backends stay small enough to see through and cannot drift in how they read a
map.

- **Dev — `DevDiskBlobs`, over `data/` on disk.** Art iteration is a tight loop,
  and making it a `pnpm seed` away was a real regression when this moved to
  Workers. Disk stays the single source of truth while developing: an edited PNG
  is live on the next request, an editor Save lands in `data/map.json` as a
  reviewable diff, and there is nothing to sync back. The Worker reaches the
  directory through a dev-only Vite middleware in `vite.config.ts`.
- **Production — `R2Blobs`.** `pnpm seed` uploads `data/` into the bucket; a
  fresh environment loads blank until it runs.

`pnpm dev:r2` (`VITE_USE_R2=1`) runs dev against R2, since the default dev path
otherwise never exercises it.

Do not add a second write path that bypasses `DataStore`. The reason the two
directions stay consistent is that there is only ever one copy of the truth in a
given environment, never a sync between two.

**There is a third copy, and it is not `DataStore`'s.** The Durable Object holds
the world being played, prefers its own checkpoint to the bucket on every load,
and carries each player's kit, tags and masteries across a save on purpose — so
a seed can replace every byte of authored content and change nothing anybody can
see. Nothing reconciles the two, by design: `GameServer.resetWorld` is the one
place that does, over the `/reset` endpoint and `pnpm reset`, and it is
destructive. Reach for it when the world has drifted from `data/`; not for
anything a save could do.

## Two dev servers, and `pnpm dev` is the one you want

`pnpm dev` runs everything, `/online` included: the Cloudflare Vite plugin
proxies WebSocket upgrades through to the Worker and Durable Object, so you get
multiplayer *and* HMR *and* `data/` on disk. Use it.

`pnpm dev:worker` builds and runs real workerd. It is for production fidelity —
actual DO hibernation and checkpointing, actual eviction — not for day-to-day
work, since it serves a build and has no HMR. It runs a file server over `data/`
beside the Worker and points at it with `DATA_ORIGIN`, so the art loop and
git-diffable saves behave the same in both.

Two traps when testing multiplayer, both of which have cost real time:

- **Two browser tabs share a cookie**, so they are the *same* actor and it looks
  like joining is broken. Use `localhost` in one and `127.0.0.1` in the other
  for two cookie jars — which is why the dev server binds `--host`.
- **`curl` is not a WebSocket client.** An upgrade probe against Vite returns an
  empty reply while the same probe against workerd returns 101, and that
  difference means nothing about whether the app works. Test upgrades in a
  browser. A previous revision of this file confidently claimed Vite could not
  proxy WebSockets at all, on exactly that evidence, while a browser tab sat
  there connected.
- **`pnpm dev:worker` needs an absolute `--persist-to`** (the script has one).
  With `-c build/server/wrangler.json` the default state directory resolves next
  to that config, so wrangler quietly creates an empty `build/server/.wrangler`,
  every R2 read misses, and the world loads blank.

## The simulation holds N actors

`GameSession` runs any number of actors. `/play` runs exactly one and never
names it (`LOCAL_ACTOR_ID`); the game server will spawn one per connection.

- **Ownership lives on the placement.** `PlacedTile.owner` is what tells two
  identical `player` tiles apart. Authored maps never carry one — the map's
  single `player` tile is a *spawn marker*, and `requireSinglePlayer` now exists
  only to read it. Nothing in the tick loop calls that function: the invariant
  it enforces is broken deliberately the moment a second actor joins.
- **Locate through `./actors`, never by sweeping.** `locateActor` tries the
  actor's last cell, then the neighbourhood, then the board — the same
  cheapest-first discipline the single-player memo had, and for the same reason:
  a tick rewrites the map several times and almost none of those edits move
  anybody.
- **Per-actor vs per-board state.** Input, walk, fall, slide, hover and the
  location memo belong to the actor. The map, the plate and wire indexes, and
  `settledMap` belong to the session — a plate does not care who stepped on it,
  and settling once per tick rather than once per actor is what keeps that true.
- **Actors tick in insertion order, and the order is load-bearing.** Two actors
  contending for a cell resolve by it, so a stable order is what makes a tick
  reproducible instead of dependent on whose message arrived first.
- **A walk reserves its destination.** A step only commits to the map when it
  lands, so for its whole duration the destination still reads as empty to
  everyone else — two actors pressing the same direction on the same tick both
  passed `canWalk` and both arrived, inside one another. `destinationTaken`
  closes that. The map cannot answer the question, because the answer is not in
  the map yet.

- **Spawning is idempotent against the map, not just the actor table.** A world
  resumed from a checkpoint already holds everyone's tile, so `spawn` re-seats
  an actor on the body they have rather than minting a second — `despawn` only
  ever removes one, so a duplicate would linger forever. Actors in a resumed map
  with no live connection are reaped (`reapAbsentActors`); nothing else would
  ever remove them.
- **A map that has been run cannot be resumed without its spawn point.**
  Starting a session *consumes* the authored `player` marker — adopted or
  removed — so there is no tile left to read it from. `getSpawnPoint` exists so
  it can be carried alongside, and the server checkpoints the two together.

## Where a player comes back in

The checkpoint keeps everyone who is *connected*, because their tiles are in the
map it stores. What it cannot keep is somebody who has left: `despawn` takes
their tile off the board, and at that moment the map stops being the record. So
positions are kept a second time, per actor, under `pos:<id>` — and the two are
not redundant.

**A third row says where they *started*.** `spawn:<id>` is written once, the
first time the world sees somebody, and never rewritten: where you entered is a
different fact from where you are, and it does not move when you do. A death
overwrites `pos:` with it, which is the whole of respawning — asked for from the
death screen's Rebirth button, or by reloading. Today every row
holds the same coordinates — a map has one authored `player` marker — and
keeping it per player is what lets a death answer the question without asking a
map that may since have been re-authored out of it. `replaceWorld` drops the
rows wholesale for exactly that reason: a save can move the marker, and a
remembered door into a building that no longer stands is worse than no memory
at all.

**The write must not gate the broadcast.** A Durable Object holds outgoing
messages until preceding writes are durable, which is right for anything the
world's consistency rests on and wrong for this: a position is a convenience,
and paying for it with every client's latency thirty times a second is the one
trade this object cannot afford. Hence `allowUnconfirmed: true`, and hence a
throttled flush (`POSITION_FLUSH_INTERVAL_MS`) rather than a write per tick — a
walking actor's cell is superseded 200ms later anyway. The guaranteed writes are
the ones on paths that are already rare: a socket closing, and the world going
to sleep. The rejection is swallowed on purpose; there is nothing useful to do
about a position that did not stick, and an unhandled one would take the world
down over it.

**A remembered position is a wish, not a promise.** The world keeps running
while somebody is away — a wall goes up, a box gets pushed onto their cell, the
editor replaces the map entirely — so `findEntryCell` bubbles outward from it
(`ENTRY_SEARCH_RADIUS`, neighbours in WNES order) and falls back to the spawn
point. The predicate is `fitsTile`, the same volume check the editor places
against: a half-height tile dropped where you stood leaves just enough headroom
until there is a roof on the level above, and then it does not. Everything below
the feet is left to gravity, exactly as it is for an actor arriving at spawn.

**Every path that seats an actor consults it, and the map still wins.** `spawn`
looks at the remembered position only when the actor has no tile on the board,
so a resumed checkpoint is always more recent than a memory of one. Both
`fetch` and `restoreActors` pass it: a socket can outlive the world its owner's
body was in — `replaceWorld` drops the checkpoint — and without it those players
came back from the next wake standing at spawn.

The store is capped (`MAX_SAVED_POSITIONS`, least-recently-saved evicted, pruned
on load) for the same reason the chat log is: it grows with *visitors* rather
than with activity, and identity here is a cookie anybody can mint.

Affordances (`./affordances`) are pure functions of board plus actor, kept out
of the session because both ends of the wire ask: the server to validate an
interaction, the client to decide whether to draw one under the cursor. Same
rules on both sides means the client cannot offer something the server refuses.

**What buries a thing is volume, and only volume** (`isLid`). A cell can hold
several things and being under one of them is not, on its own, being out of
reach: a sword lying across another sword hides nothing, and neither does a body
standing on either of them. `physicalHeight > 0` and nobody in it — a crate — is
the whole of the rule, which is the same line the stacking model already draws
between things that take up room and things that merely rest somewhere. Two
swords in one cell are therefore two things you can pick up, and the list offers
both; before this only the top of a stack was reachable, and the lower sword
could not be got at at all.

**A shove is the one action that reaches under a lid**, because nothing is left
behind: `pushedColumn` is the object plus everything stacked on it, the group
travels as one rigid volume (`fitsHeightAtElevation`, `moveColumn`), and the
destination is asked for the column's height rather than the crate's. A stack of
two boxes is two boxes you can push, and shoving the lower one takes the upper
one with it. The exception is a **body riding on top**, which refuses the shove:
somebody standing on a crate has their own motion and their own idea of where
they are walking to, and `commitWalk` would land that step from a cell they are
no longer standing in. A body is not a lid, but it is not cargo either.

**Where a thing belongs and where it will *go* are two questions**, and keeping
them apart is what makes the kit both permissive and legible.

- `handAccepts` answers the second, and answers it generously: **a hand takes
  anything you can carry**, a pack included. If you would rather hold a second
  backpack than a shield, the game has no business refusing you. The one refusal
  is `equippable: false` — an author saying "this is a chest, opened where it
  lies" — and the inside of a bag, where nesting still bites.
- `equipSlotOf` answers the first, from the tile alone: a weapon goes in the hand
  you swing with, a `WeaponItem.offhand` thing (a torch, a shield) in the other,
  an equippable container on your back. It is what happens when nobody has said.
  A drag is somebody saying, so `slotAccepts` stays the looser of the two.

`WeaponItem.offhand` is the exact counterpart of `ContainerItem.equippable`:
nothing about a tile says which hand it is for, since a torch and a sword are
both `weapon` blocks here (light and defence both ride on one), so the author
says it. It used to be guessed from whether the tile gave off light; `itemUseFor`
asked that question too, and now both read the flag.

**Putting a thing on is not picking it up.** `equipSlotFrom` offers the natural
slot only while it is *empty* — equipping never displaces what you are holding,
because a swap is two deliberate acts and a tap that quietly put your sword on
the floor is something you notice a fight later. It is the row that works with
**no bag at all**, which is the whole reason it is a verb of its own: before it,
an unequipped player standing over a sword could do nothing with it. It outranks
`pickUp`, so a plain tap arms you while the slot is free.

**A pack in a hand is a pack you can open**, which is what makes a hand a real
place to keep one rather than a shelf. `SlotRef`'s `contents` arm gained an
optional `of` — absent still means the bag on your back — so a position inside a
container is one arm and one capacity check however many containers a body is
carrying. `ContainerRef` gained the matching `hand` case, and `GameViewport`
holds which hand is open beside `bagOpen`, dropping it the moment that hand is
emptied. `carriedInstances` walks every slot's contents for the same reason: a
thing it misses is a thing the id-minting pass never reaches.

**The verb is read off the item, never off the slot** (`equipVerb`): you wield a
sword, you hold a torch, you put on a pack. Since both hands take anything, a
verb named after the square would have to call a backpack in your fist
"wielding" it. `ItemSlot`'s press hint uses the same function, so the panel and
the world say one word.

**A pickup reaches for a hand last.** `pickUpDestination` is the bag, then — only
once the bag is out of room *and* the thing has no free slot of its own — the off
hand, then the weapon hand. The spare hand first, because what you swing with is
the slot with consequences. The "no free slot of its own" clause is what stops
"Wield" and "Pick up" appearing side by side meaning one hand, and it means
neither row has to ask about the other. `open` outranks `pickUp` for the one tile
kind that is both: a second pack can be carried in a fist now, and a tap that
took it rather than looking inside would answer the duller question.

**A box catches what you throw at it.** `dropDestinationAt` answers with a slot
rather than a boolean: aimed at a container with room, a dropped item goes
*inside* it (through `stashInContainer`, the same write a move into that slot
makes); aimed at a full one, or carrying a container of its own, it lands on top.
Nothing is refused for being aimed at a full chest. That path adds no placement
to the board, so it settles nothing — the reasoning `moveItem` skips its settle
under.

`./interactionOptions` is the third caller, asking the same questions in the
plural: everything actionable right now, rather than the one thing under the
pointer. It is what the list beside the game is drawn from, and it exists
because a thumb has no hover — before it, an affordance was invisible until it
was already being used. Two things keep it cheap. It is **bounded by
construction** — every slot of the nine cells around the actor across three
floors, plus the actors the snapshot already holds — so it never sweeps. Every
slot rather than a chosen few, because which of them a cell offers has three
different answers now and restating any of them beside the affordances would be
a second opinion that can disagree. And `GameRenderer` gates it
twice before it reaches React: once on map identity plus the viewer's cell and
target, which makes standing still free, and once on the resulting list's
contents, because the map takes a new identity on every commit anywhere in the
world and somebody walking across the room must not re-render the page.

**Targeting is bounded by the view, not by reach**, and that is not an
inconsistency with `inAttackRange`. Tapping a body does not swing at it — it
sets the target, and attack mode plus the server decide whether a blow lands
from there. So the
question is "who could I single out", whose honest bound is what is on
screen: choosing your target while walking towards it is how a fight normally
starts. `GameRenderer` owns that test, because the camera is its business —
`targetableActors` applies the same two rules the name tags use (`isVisibleLevel`
plus `isWithinView`, shared with `enforceTargetVisibility`), and keeps whoever
is already being fought regardless, since on a touch screen the list is the only
way to call a fight off.

**A row does not consult motion**, unlike `canInteract`. An actor mid-step
cannot act, but a row that vanished for the 200ms of every stride would flicker
its way through a walk; the session re-asks on the tap, so the worst a stale row
can do is nothing at all. And where a tile is authored with both a switch and a
push, the row names the one `interact` would actually run — the precedence is
read from the same place rather than restated beside it.

Two shaping rules, both about reading it rather than about correctness. It is
**one entry per action, ordered by nearness**: the verb is what is being scanned
for, so a body you can both shove and fight is two rows with one name between
them rather than a heading to look inside, and every row is the same size. The
sort is squared plan distance with a floor weighted far above a cell
(`LEVEL_DISTANCE_WEIGHT`) so nothing through a ceiling comes between you and
what is at your feet, then by `ACTION_ORDER` — which puts "target" above "push"
on the body that offers both — and only then by the entry id. That middle rank
is written down rather than left to the alphabet, which is what it used to be:
"attack" happened to sort before "push", and renaming the verb to "target"
silently reversed the list. Both entries for such a
body are named through `bodyNameFor` (`bodiesByCell`), because reading the push
row's name off the *placement* would announce a tile called "Player" beside a
fight with somebody who has a name. And a switch is
**named by its author** (`SwitchInteraction.actionName`): "Push" and "Target"
belong to the interaction and are the same everywhere, but nothing derivable
from two tiles pointing at each other says which half opens and which shuts. The
field is optional and blank is legal — every switch in `data/` predates it — so
anything offering the action falls back to naming the kind.

## The wire is patches plus motion events

Two kinds of thing travel, and keeping them apart is what makes it cheap.

**Cell patches are the truth.** After each tick the server diffs the map against
the last broadcast with `changedCellsOnLevel` — chunk identity first — so a step
falls out as exactly the two cells it touched on a floor of thousands. Every
socket is at the same map version, so it is one diff and one `JSON.stringify`
per tick regardless of player count.

**Motion events are animation hints** for what the map cannot express yet. A
walk commits only when it lands, so the server announces `walkStarted` at the
start and the cell patch arrives 200ms later, exactly as the client's
interpolation finishes. There is deliberately **no position stream**: a walking
actor costs one event, not one message per tick. Events are emitted on object
*identity* — motion state is mutated in place as it advances, so the same object
across two ticks is the same motion and must not be announced twice.

**Which is why progress travels beside a motion on `ActorSnapshot`, never inside
it.** A snapshot that carries its own progress has to be a fresh object on every
read, and `collectMotionEvents` cannot tell that from a new motion. `slide` was
built that way and announced one shove on all six ticks of its life; each
announcement restarted the client's lerp, so a pushed crate juddered in place
for 200ms instead of sliding — and stayed "busy" on the client long after this
side had freed it, refusing the next step and the next push. `walk` and `fall`
were always handed over live; `slide` and `slideProgress` now match them. Any
new motion goes the same way.

`RemoteSession` reads actor positions off the map rather than tracking them
separately: the map is authoritative and already carries ownership, so there is
no second copy to drift.

**The world ticks only while there is work** (`isAtRest`). `setInterval` blocks
hibernation, so an idle world stops ticking and its object can be evicted with
sockets still open. Going idle checkpoints the runtime map, which is what makes
eviction invisible — without it a wake would reload the authored map and drop
everyone back at spawn.

The renderer is a *viewer*. Camera, roof-cut, hover and pick follow `snap.self`
and deliberately stay single-anchor; `snap.actors` is what gets drawn and lerped.
`GameRenderer` is typed against `PlaySession`, not `GameSession`, so a remote
session can drive it.

## Fighting is stats on a tile, and nothing else

A **battler** is any tile with an `interactions.battler` block (`app/lib/battler.ts`):
six numbers, parsed rather than trusted like every other interaction. The player,
the cat and the deer are battlers; a crate could be one. Being a battler is
independent of `actor` and of `brain` — what a body can take is a separate
question from what drives it, and keeping the three apart is what lets the player
be a battler with no brain and a barrel be one with neither.

**Hit points live on the runtime, never on the placement.** Putting `hp` on
`PlacedTile` would broadcast itself for free through the existing cell patches,
and that is exactly the trap: a map edit invalidates light chunks and rebuilds
level geometry, so every blow landed would dirty the chunks around a creature.
The wire carries hit points as their own diffed `hps` array instead, and damage
as a motion event beside it. The split is the protocol's own: **a health bar is
state, a damage number is an event.** Three hits in one tick leave one new total
and owe three numbers, so neither can be derived from the other.

Hit points are absent from the checkpoint, on the same terms brain memory is: a
world nobody is looking at owes no continuity, and a saved number would have to
survive somebody editing the tile's maximum. What *is* checkpointed is the set of
**dead actors** — a death is a tile that is *not* on the board, so it leaves no
evidence to recover, and without carrying it the first hibernation wake would
find a dead player's socket still open, see no body, and seat them again.

**A death is the moment the session stops being able to answer for somebody**,
and everything a reload hands back is read from storage — so a death has to write
itself down before it destroys the only copy of what it knew.

- **The kit does not die with the body.** `kill` drops it onto the corpse's cell
  first, all of it or none of it: a sword somebody picked up a moment ago is
  still a sword in the world, findable and theirs again if they walk back for it.
  The alternative is not "death costs you your things", it is the world quietly
  being one sword lighter with nothing in it able to put that right. All-or-
  nothing because the two halves — what is on the board and what the body still
  owns — are written to different keys, and a half-dropped kit has no single true
  answer to give either of them.
- **The `Death` carries what the runtime knew**, because `GameSession.kill`
  deletes it: what is left of the kit, its tags and its masteries. Nothing
  downstream can re-derive any of it.
- **A reload or a `rebirth` puts them back at the spawn point, with a fresh empty
  bag.** The
  position row is *overwritten* with `spawn:<id>` rather than left alone —
  leaving it is what put people back wherever the last flush caught them, up to
  a whole `ACTOR_FLUSH_INTERVAL_MS` of walking ago. The kit is the starting one
  rather than the emptied one, because coming back with no bag at all leaves
  somebody unable to pick their own corpse up. It is written rather than deleted
  — a missing row already means "give them the starting kit", but a delete
  cannot ride in the batch, and a second call is a second moment at which the
  board and the kit can disagree. What they still *own* wins over both: a kit
  the floor refused was never dropped, so writing a fresh one over it would
  destroy what the refusal saved.
- **Hit points need nothing.** They are rebuilt from the tile on every load, so a
  respawned body is at full health by construction rather than by a reset.
- **`noteDeaths` forces a flush**, rather than leaving it to the next one. This
  was a real bug and a sharp one: `saveActors` skips an actor with no position —
  which is every dead one — and then writes the board *regardless*, so the batch
  recording "the sword is no longer on the floor" carried nothing saying where it
  went. A sword picked up and carried into a losing fight ended up in nobody's
  kit and on nobody's floor. The forced batch is also what beats the reload: a
  reload is the very next thing a dead player does, and a deferred write would
  leave it reading the pre-death kit.
- **Only somebody with a socket is written.** A dead player sits there connected
  and a creature never had a connection, so the socket is the exact test for "is
  there anyone to hand this back to" — and it keeps a world that respawns
  wildlife from writing a position and a kit per rat. The same test decides who
  is *told*: see the death screen below.

**The client picks the target; the server decides when a blow lands.** A `target`
message names who, and that is all a client is trusted with. Attack speed is the
`spd` stat, so a client sending a thousand attack requests swings at exactly the
same rate as one sending none — which is why there is no attack message on the
wire at all. Whether the target is a battler, alive, or in reach is re-asked on
every swing, because all three change while both parties walk.

**A target is who; attack mode is whether**, and they are two decisions on two
messages (`target` and `attackMode`). They used to be one, and that made pointing
at a creature an act of violence: there was no way to read a name tag or a health
bar without starting a fight. Three things follow from the split and all three
are load-bearing.

- **The mode lives on the actor** (`ActorRuntime.attacking`), not on the client,
  because `runAutoAttacks` is what reads it. The client is still trusted with
  neither the timing nor the range.
- **`isAtRest` is gated on it.** A standing target used to hold the tick loop open
  by itself — correctly, since a fight is a cooldown counting down — and with
  targeting now free of intent, that would keep a Durable Object awake for as
  long as somebody stood watching a deer. It is a target *and* the mode that
  costs a world its sleep.
- **The stance is re-sent, not remembered.** `hello` seats a fresh body that is
  not swinging at anybody, so `RemoteSession` says the mode again on a world
  replacement and the page says it again on a reconnect, exactly as held
  directions are resent. The target is dropped instead of resent, because it
  names somebody in a world that no longer exists.

The colour of the outline follows from the mode rather than from having a target
at all: white while you are only watching, red once it is a fight, and pulsing in
both cases because the pulse is what separates a *chosen* body from one the
cursor happens to be over. Attack mode and look mode are independent — you can
look at things with your sword out.

The formulas live in `app/game/combat.ts`, kept pure so they can be asserted:

- **`acc` widens a band downward; it never raises the ceiling.** Full damage is
  always `atk`. Within the band the roll is triangular, so a middling blow is
  common and both a glancing and a shattering one are rare.
- **`flee` reads against half the attacker's `acc`**, which is what stops perfect
  accuracy from erasing the stat.
- **`spd` is geometric between 2 and 200 ticks.** Linear would make the whole
  lower half of the stat indistinguishable from zero; on this curve 50 is twenty
  ticks.
- **A swing always costs three draws**, whatever the stats. The dice are seeded so
  a world is reproducible, and a draw count that varied with accuracy would make
  one creature's stats change what every creature after it rolled.

**Zero hit points deletes the body, and leaves the kit where it fell.** For a
player it also removes their actor, so the server ignores everything their socket
sends. They come back at the door they came in by, on full hit points, wearing an
empty bag, with everything they were carrying lying where they died. The walk
back is the cost.

## Dying is a screen, and the socket goes quiet behind it

Being dead is the one state a client cannot infer. A body missing from the board
is what an ordinary stale patch looks like, so `died` is a message: sent to the
one socket, carrying the kit, and the last thing that socket hears.

**Three things happen in an order, and the order is the whole design.**

1. The tick that killed them broadcasts its patch *including* to them. That
   frame is the honest one — their body gone from the cell, their kit lying in
   it — and it is what the death screen is drawn over.
2. `announceDeaths` sends `died` and only then adds them to `silenced`, so the
   message is not the first casualty of the rule it announces.
3. From there `broadcast` skips their socket entirely. A dead player watching
   the world carry on is being shown a board they have no body in, and every
   patch of it is bandwidth spent on somebody who cannot act.

**The kit rides on `died` rather than on an `equipment` message.** That message
is read off a live runtime and a death is exactly what deletes it, so an emptied
bag would never be announced and the panel would go on showing a sword that is
on the floor. Normally empty; the whole kit when the cell refused the pile.

**Statuses come down without being sent**, and the asymmetry with the kit is the
point. What is left in a bag is a real question with two possible answers, so
the server has to answer it. What a body off the board is still poisoned with is
not a question — it is nothing — so the client states it locally. `flushStatuses`
could not say it either way: it reads the same deleted runtime.

**`silenced` is a subset of `dead`, not the same set.** `dead` holds every body
the world has taken off the board, wildlife included, and a rat has no socket to
fall silent on — silencing off it would mean asking, per broadcast, which of
thousands of dead deer had a connection. It is not checkpointed either, because
it is derivable: `restoreActors` rebuilds it from the checkpointed `dead`
intersected with the sockets that survived the eviction.

**`rebirth` is the only message a dead client may send**, and it is answered
ahead of the `actorIds` gate every other message is dropped by — that gate asks
the runtime a death deleted. The reply is a whole `hello` to *every* socket that
player has: a silenced socket has been receiving nothing for as long as its
owner sat on the screen, so its map is arbitrarily stale and no diff would catch
it up, and two tabs are one person with one body, so they died together and come
back together. Reloading still works and still does the same thing through
`fetch`; the button exists so that coming back does not mean losing the tab.

**The blocking is `inert`, not an overlay.** The page marks everything under the
death screen inert, which is the browser's own answer to "this subtree is not
interactive": it covers the pointer, the tab order, a keypress reaching a
focused chat field and anything reading the page aloud. An overlay drawn on top
covers none of those — a dimmed panel is still tabbable. The screen itself only
darkens, because the frozen world behind it is the answer to what happened.
`RemoteSession.setInput` refuses while dead for the half `inert` cannot reach:
the keyboard is bound to the window, which no overlay covers.

**Being a battler is what earns a name tag**, and the health bar rides in the
same label. Names used to be a mode the online route switched on, with a check
for the player tile inside it — people were named and the wildlife was not, which
was right while a creature was scenery and wrong the moment it became something
you can pick a fight with. `bodyNameFor` answers it for both, exactly as it
already did for speech.

**A name hangs above the art, not above the height.** A tile's `height` is a
gameplay figure — what you stand on, what you see over — while its sprite is
authored to a cell box and usually fills it: the cat and the player are the same
2×2 drawing and differ only in declaring one height unit against two. Anchored
on height alone the cat's bar landed inside its own fur, so `labelHeadroomPx`
lifts a label by whatever the tile is short of a full level, plus a pixel that
everything gets. World pixels, because what is being cleared is the drawing and
the drawing scales with the zoom.

The bar is a DOM element in that label rather than a quad in the scene, and both
halves of that matter. The world draws at whole world pixels — five or six screen
pixels each at play zoom — so a bar built there has a border five pixels thick
and a fill that steps in huge jumps; out here it gets the same screen-pixel
crispness the type has. And because the bar and the name are two children of one
flex column, "they must not overlap" is true by construction rather than by
arrangement.

**Nothing is drawn until the assets are all here** (`app/lib/gameAssets.ts`).
`/play` and `/online` hold the canvas out of the page behind a loading screen,
which is what makes the renderer unable to start early, and the label font is
part of what is waited for. It has to be asked for by name: `document.fonts`
only knows about faces something has tried to typeset in, and in this page the
only thing in that font is the world's own text — so `fonts.ready` on its own
resolves immediately and proves nothing. That was a real bug, and a
well-disguised one: a name tag sat a few pixels left of its head on a cold load
and correctly on every reload after, because a group's measured box is *held*
and the first measurement had been taken in the fallback face. There is a
timeout on the wait, so `WorldLabelLayer` also drops its measurements on
`loadingdone` — a font that lands after the deadline still gets its labels
re-measured rather than staying wrong for the session.

**There are two waits, and the loading screen covers both.** The gate above
hands the renderer decoded images; the renderer needs GPU textures and fetches
them again on its own account, so `WorldRenderer.renderOnce` paints nothing
until `assetsReady` — a material whose texture has not landed draws
`magentaTex`, and the placeholder is there to make a *missing* tileset obvious,
not one that is still in flight. `setOnFirstFrame` is what takes the screen
down, so it comes off against the world appearing rather than against a guess.
That also makes `preloadTextures` catch per tileset: left to reject, one 404
would mean the flag never flips and the world is never drawn at all.

The loading screen itself is set in a **system** font. Both of the page's own
faces are downloads — the pixel font and the chrome's IBM Plex Mono — and a
loading message that cannot be read until the download lands is a blank screen.

**Name tags stack in the world's own painter order** (`drawOrder`, the
whole-sprite key). Two crossing tags used to be settled by which element was
created first, so a cat that had been on screen longer had its tag over the
player standing in front of it. `WorldLabelLayer` orders the *elements* rather
than writing z-indexes, so the stylesheet's bands — name under speech under
damage — keep deciding everything they already decided.

## The player is told sentences; the simulation keeps the numbers

**A figure a player can read is a figure a player will optimise against, and
this game is played by picking things up and finding out.** So the rule is that
player-facing surfaces *describe*, and the arithmetic stays where it decides
things. It is not a style preference — it is what separates a game about
exploring from a game about arithmetic, and the two want opposite interfaces.

The first thing decided this way was weapon requirements. There was a panel
under the hand slot listing every mastery a weapon asked for against the one you
had — "Blade 3 / 5", the worst one in red — and it was a spreadsheet. It is gone.
What replaced it is one sentence you get by *inspecting* the weapon
(`app/lib/weaponFeel.ts`): "You can confidently wield it", "You can mostly wield
it", "You can barely wield it". A number tells you exactly how far short you are,
which is a thing to compute against; a sentence tells you that you are short,
which is a thing to go and do something about.

Three rules fall out of it, and they apply to the next one of these as much as
to this one:

- **Bands are counted in the design's own constants, never in fractions.** Every
  threshold in `weaponFeel` is a whole `MASTERY_BRIDGE` away from what the weapon
  asks — one, two and four, the same distances either side of the gate — for
  exactly the reason that constant beat a ratio in `app/lib/mastery.ts`: as a
  fraction, "a quarter short" is one point on a starter dagger and twenty on an
  endgame blade, so the ladder would have a different number of rungs at every
  tier. In points it is the same ladder the whole way up. The rungs widen as they
  go out because the precision stops being worth anything there, and the first
  band above meeting it lands on the training ceiling — so "you can confidently
  wield it" and "this has little left to teach you" are one fact rather than two
  that drift apart.
- **The sentence is derived in one place and read in every surface.**
  `weaponFeelFor` is what the world's look label and a slot in a panel both call,
  so the sword on the floor and the sword in your bag cannot come to say
  different things about the same hands. A second copy of the ladder is how a
  panel and a label end up disagreeing in front of a player.
- **Silence is an answer.** A weapon that asks nothing says nothing, because an
  unrequirement is a fact about the weapon rather than about you. A line on every
  item turns the sentence back into a stat readout with words in it.

**Inspecting is a mode, and the mode is what makes the sentence reachable.** Look
mode (shift, or the eye) already meant "I am asking about things rather than
doing them" — a tap on the world reads a door instead of opening it — and the kit
now follows the same rule: while the eye is on, a slot cannot be tapped to wield
or eat what is in it and cannot be dragged, and instead it describes itself the
moment a pointer rests on it (`app/components/ItemSlot.tsx`). That trade is what
makes the words reachable on a phone at all. There is no hover on a touchscreen,
so the description has to come from a press — and a press that both eats your
apple *and* tells you about it is a gesture nobody can use to look at food they
want to keep. Taking the actions away is what makes the same gesture safe.

The tooltip is drawn rather than handed to the browser's `title`, and that is the
whole point of it existing: `title` waits half a second and never appears under a
thumb, where look mode's promise is that pointing at something tells you about it
now. Entering the mode also cancels a drag in flight, since shift is a key that
can be pressed halfway through one.

## A reward happens to the player, not to the board

`interactions.reward` hands over a list of items once per player — a quest
chest, or a person you click and are given something. Every other authored swap
in `app/lib/interactions.ts` edits the map, which is exactly what it cannot do
here: the chest has to still be there, still full, for the next person who walks
in. So **nothing on the board changes at all**. What changes is the taker.

- **The tile is the kind of thing; the placement is which one.** The def block
  carries only `actionName` — the gesture, which is a property of what the thing
  is — and `PlacedTile.rewardTag` / `PlacedTile.rewardTileIds` carry what this
  particular chest gives and marks you with. The same split `EmitInteraction`
  makes with `channel`, and for the same reason: one `quest-chest` tile furnishes
  a whole map. `resolveReward(placed, def)` is the only join, so nothing
  downstream ever holds half of one.
- **The tag is the whole mechanism, and it is one field.** Taking a reward writes
  the tag onto the actor, and holding it is what hides it. One field rather than
  a granted/blocking pair, so a reward cannot be authored repeatable by accident
  — and so that two placements *sharing* a tag are a choice: open the left chest
  and the right one closes. Sharing a tag is the whole of the binding, exactly as
  sharing a channel is the whole of the wiring.
- **`ActorRuntime.tags` sits beside `equipment`, and is written with it.** The
  items go in the bag and the tag goes on the actor in the same call, because a
  reward whose items landed without its tag is an item with no ceiling on how
  many exist. `saveActors` puts `tags:` in the same storage batch as `equip:`
  and the checkpoint for the same reason the kit rides with the map.
- **A tag is never checked against the world, unlike a kit.**
  `restoredEquipment` exists to drop a sword the catalogue no longer agrees with;
  a tag records that something *happened*, which stays true however the authored
  content moves. Checking one would refill a chest whose loot got renamed.
- **`replaceWorld` re-seats everybody with their tags**, beside the kit it now
  carries across for its own reasons. A save re-creates the world, not the people
  in it, and a tag has even less to do with the map than a kit does. The editor
  saves constantly, and dropping them would refill every reward in the world for
  everybody standing in it, once per save.
- **All or nothing on space.** `rewardFits` needs room for every item at once,
  because a reward is taken once and half of one is half of it lost. Containers
  are refused outright — nothing nests, so a bag could only go on a back the
  reward's own items need occupied.
- **Purple is a fifth colour and it says something the other four cannot.**
  Yellow, red, white and blue all name what you would be *doing*; `REWARD_COLOR`
  / `--color-reward` says the offer is finite, which is the one thing neither the
  verb nor the sprite can tell you before you walk away from it. The list row
  wears it unlit, unlike every other row, because "only once" is a property of
  the offer rather than a state you are in.

`interactionKinds` asks `resolveRewardDef` — the def's half — because it is a
question about tiles, and whether a given *slot* gives anything is what the
affordances ask. Reward is first in that order, ahead of even a switch, because
it is the only one that can happen to a given player once: a chest authored to
both give its contents and swing open would otherwise spend its one chance on the
hinge. It falls through cleanly, since a reward already taken is not on offer.

## Decay is a switch whose input is time

`DecayInteraction` turns a placement into another tile, or into nothing, once it
has been on the board long enough. Any tile can carry one; it exists for blood
and bodies, which are spawned constantly and must not accumulate. It reaches
what people are *carrying* on the same clock — a berry ripens the same whether
it is on the floor, in a chest or in your bag. The swap itself is the same one
plates and receivers make — `canReplaceStack`, refuse rather than force — and
everything interesting is in *where the deadline lives*.

**A lifetime is a range, drawn once per placement.** `fromMs`/`toMs` rather than
one number, because the motivating case spawns in bursts: a fight's worth of
blood is placed within a few ticks and would otherwise vanish on a single frame,
which reads as a bug rather than as drying. The draw happens where the placement
is first armed — rolling at expiry would be rolling to decide whether it had
already expired, and rolling on each re-arm would let a busy cell keep winning
itself a longer life. Equal ends are legal and mean an exact lifetime; an
inverted range is malformed and reads as "does not decay", with the editor
keeping the pair ordered so nothing authored through it can land there.

The dice are the world's own (`GameSession.rng`), not a generator of decay's
own — two worlds on one seed must agree about when the blood dried as well as
about where the deer walked. And **a lifetime always costs exactly one draw**,
even where both ends are equal and the answer was never in doubt, on the same
grounds a swing always costs three: a draw count that varied with what an author
typed would mean widening one tile's range by a millisecond changed what every
creature in the world rolled after it.

**Beside the map, never on it** (`DecayIndex`, `app/game/decay.ts`). A `decayAt`
written onto the placement would ride the existing cell patches and the
checkpoint for free, which is precisely the trap: it would also land in
`data/map.json` the first time somebody saved from the editor, and that file is
hand-edited and version-controlled — `flattenMap` goes out of its way to keep a
one-cell edit a one-line diff. Held out here, decay costs the map format
nothing, the protocol nothing and the checkpoint nothing.

What that gives up is continuity across an eviction: a resumed world re-arms
whatever it finds with a full fresh lifetime. Same bargain hit points and brain
memory already take, and bounded by one lifetime.

**The clock is simulated, not wall time.** `DecayIndex` sums the ticks the
session actually ran, so a decay is reproducible from a seed and a tick count
exactly as a fight is; `Date.now()` in `GameSession` would make a test's outcome
depend on how fast the test ran. Three things follow:

- **`isAtRest` is gated on it**, because this loop is the only clock a countdown
  has. A world with anything decaying in it keeps ticking until that lifetime is
  up — half a minute of blood after a fight is the intended cost, an hour-long
  lifetime would be an hour of Durable Object, and it is the *longest* end of
  the range that sets it. Lifetimes are authored in seconds so that cost is
  visible while writing one.
- **An anonymous placement is keyed by cell plus tile id**, not by stack index:
  an index shifts the moment anything is placed under it, and blood in a doorway
  would forget its age every time somebody walked over it. Two placements of the
  same decaying tile in one cell therefore share a deadline and go together.
  Anything carrying an item id is keyed by that instead — see below.
- **Arming is additive, and that is load-bearing.** `reindexCells` runs whenever
  a cell's stack changes, so re-stamping there would reset the timer of every
  splash somebody stepped on — blood in a corridor would never dry. An entry
  whose placement has since gone is left to expire and dropped when the stack
  read finds nothing to turn, which is the same "a stale extra entry costs one
  wasted stack read" the plate index runs on.

Cost per tick is one comparison against the soonest deadline. Only a tick that
actually has something due walks the index, and that walk serves everything due
at once — which is the shape that survives a fight's worth of blood.

**Nothing spawns blood yet.** Decay is the half that removes it; whatever puts
it under a damage receiver has to place the tile *and* `reindexCells` its cell,
or that tile never ages. That is the same index discipline plates and wires
already require.

### A thing is keyed by which thing it is, not by where it is

Anything carrying an item id counts down under that id (`itemEntryKey`). This is
the whole of "food rots in your bag": an item id is minted once and kept across
every pickup, stash and drop, so one entry follows a berry from the floor into a
bag into a chest without the clock noticing it moved. Keying it by cell instead
would have stopped the clock the moment somebody picked it up and started it
over when they put it down — a rule under which the way to keep food fresh is to
carry it, which nobody would have chosen.

The arming discipline is the same, one rung out. `armCell` covers the board and
what is inside containers on it; `armEquipment` covers a kit and is called from
`setEquipment`, the one place a kit is ever written — an arming hook beside the
assignment is a fact about that function, where one spread over every equip,
stash and loot is a discipline that eventually slips. Both are additive, for the
sharper version of the reason `reindexCells` is: a kit is rewritten constantly,
so re-stamping would mean a berry moved from bag to hand came back fresh.

**Applying an item decay sweeps rather than looks up.** An entry names a thing
and not a place, which is exactly what survives a pickup and exactly what leaves
`applyItemDecay` with no address to go to. It could carry a last-known
whereabouts refreshed on every arm; that stays exact right up until the one move
that forgets to refresh it, at which point a berry stashed in a chest becomes
immortal for reasons nobody can see from the code. So it walks the kits and the
board. The cost is charged per *tick that has a thing due*, never per thing —
`takeDue` hands over everything ripe at that instant — and blood, the population
that actually runs to hundreds, is anonymous and never reaches this pass.

Three refusals, all of them "it stays what it is, and is armed again for free the
next time its holder is touched":

- **A slot asks of a rotting thing exactly what it asks of a dragged one**
  (`slotAccepts`, `app/game/itemMoves.ts`), because arriving by rot is still
  arriving. A berry that rots into a crate does not turn while it is in a bag —
  a container may not hold a container — and turns the moment it is on the floor.
  `isItem` on top of that, which moves never need: a move can only carry
  something that was already an item, and a decay is the one way a slot could
  come to hold scenery. Every slot walks its own contents rather than only the
  bag, because a hand takes a spare pack.
- **Nothing decays out from under what it is holding.** A pack that rotted away
  would take a sword and three apples with it silently, so a container with
  anything in it simply waits until it is empty.
- **The floor asks nothing** — the ground holds anything — but a thing that rots
  into a tile nobody can pick up comes out *anonymous*. An item id on scenery is
  a promise the world cannot keep, and it would leave the tile counting down
  under a key nothing can reach; dropping it hands the tile back to `armCell` as
  the plain decaying placement it now is.

## The save is the repair path, so it must not need a working world

`replaceWorld` is the only way to change the world, which makes it the only way
to *fix* one. Two rules keep it able to, and a live world was lost learning
them.

**Validate before persisting.** A map with no `player` tile has no spawn point,
so `new GameSession` throws on it. That check used to run *after* the map had
been written and the checkpoint deleted — so one save of a map whose marker had
been erased in the editor persisted the unstartable map and destroyed the only
startable copy left. The session is now built first, from the incoming map, and
storage is untouched until it exists.

**Never read the world you are replacing.** `replaceWorld` used to open with
`ensureLoaded()`. Once the stored map could not start, that threw — so the
editor could no longer save the very fix that would have repaired it. Putting
the marker back required a world that could not come up. Nothing in there needs
the old session: the tiles are re-read and every actor is re-seated, so loading
it was only ever a way for its failures to become the save's.

Relatedly, `ensureLoaded` clears `loading` in a `finally`. A rejected promise
left in place is handed to every later caller, so a world that failed to load
once goes on failing long after the cause is fixed.

The editor gives no warning before you erase the marker — it is an ordinary
tile in the stack. The server refusing the save is the whole of the safety net.

## Map mutations must be undoable

Every change to map data (`MapFile` / placed tiles) **must** go through `useEditorStore.getState().commitMap(...)` (or a store method that calls it: `eraseAt`, `stampAt`, `stampMany`, `appendArmed`, `removeFromStack`, `reorderSelectedStack`, `setStackDirection`).

- Do **not** assign `map` via `setState`, mutate stacks in place, or call `mapData` helpers and write the result into the store yourself.
- Discrete edits (backspace/delete, stack panel trash/reorder/direction, tile picker append, shape stamp) use plain `commitMap(next)` so each gets its own undo entry.
- Paint drags use `beginStroke` → `commitMap(next, { coalesceInStroke: true })` → `endStroke` so the whole drag is one undo step.
- If you add a new map-editing path, wire it through `commitMap` and confirm ⌘Z undoes it before considering the work done.

## Renderer and simulation performance

The game targets **120fps — an 8.3ms frame budget**, and the whole budget is
spent by the time you have done anything twice. Every rule below was written
after something in this list cost 2–150ms per frame in production code, so
treat them as load-bearing rather than stylistic.

Measure with the in-game counter first: the FPS chip in `/play` expands into a
per-phase breakdown (`app/render/frameProfile.ts`). It reports **p50 and worst**
per 500ms window. Read the worst. A 55ms hitch once every 200ms barely moves an
average, and that is exactly the shape of bug that reaches a player.

### Never sweep the map to answer a local question

This is the single most common way performance has been lost here. It has
happened in at least four independent places.

```ts
// The tell. If you are writing this outside a one-time index build, stop.
for (let z = MIN_LEVEL; z <= MAX_LEVEL; z++) {
  for (const [ck, stack] of Object.entries(level)) { ... }
}
```

Ask what the caller actually needs, then address exactly that region:

- Light bakes need the window plus `MAX_LIGHT_LEVEL` of apron
  (`app/lib/lightingChunks.ts`).
- A dynamic light needs its own radius, not the map
  (`overlayEmitterOverrides`).
- The roof-cut probe needs `VIEW_RADIUS` — **2.5 cells** — and was building
  world-wide occlusion to look at a 5×5 box.
- Finding the player is a cell lookup once you remember where they were
  (`playerStillAt`).

Iterate a rect and look cells up (`level[coordKey(x, y)]`), or iterate the
level's own keys. Do not filter the world down to the part you wanted.

**Bounding the work is not enough if the gather feeding it is unbounded.** The
chunked light bake was correctly scoped and still paid 7ms per chunk to a
`cropMap` that called `getStack` for every coordinate in the padded rect —
62x62x9 probes, two key strings each, to hand over 3144 cells. It cost as much
as the flood it fed. Addressing the overlapping *chunks* and filtering on the
way out made the gather proportional to content instead of to area, and took a
one-chunk bake from 8.3ms to 4.7ms with byte-identical output. When you scope a
computation, scope how its inputs are collected in the same breath.

The cost is invisible on today's ~5k-cell fixture map and fatal at the intended
size. The map is headed for thousands of cells square across 17 levels; anything
O(map) per frame is already broken, it just has not shown up yet.

### Exploit the persistent map

`MapFile` is copy-on-write (`setStacks` in `app/lib/mapData.ts`). Unchanged
levels and unchanged cell stacks keep object identity, which makes change
detection nearly free:

```ts
if (prev === next) return;                      // whole map unchanged
if (prev.levels[lz] === next.levels[lz]) continue;  // level unchanged
if (before?.[key] === after[key]) continue;     // cell unchanged
```

Do not hash map contents to detect changes. A per-frame content hash used to
cost ~1ms; the identity checks that replaced it cost nothing.

### A mutation that changes nothing must return the same object

Downstream, a new map object *is* an edit: it invalidates light chunks and
rebuilds level geometry. `setEntityDirection` rewrote the map every tick a
direction key was held, re-asserting a facing the player already had — that
alone put a full mesh rebuild on **20.8% of frames while walking**. Guard it:

```ts
if (current.direction === direction) return map;
```

Any new mutation helper needs the same no-op guard.

### Levels are chunked; keep it that way

`map.levels[z]` is `Record<chunkKey, Record<cellKey, PlacedTile[]>>`, not a flat
cell record. It was flat, and one populated floor held 4565 cells — so editing a
single tile copied all of them. Chunking bounds a copy-on-write edit to one
chunk (`CHUNK_SIZE` square) and took `moveEntity` from **1.13ms to 0.020ms**.

Two things follow, and both matter:

- **Go through the accessors** — `getStack`, `setStacks`, `listCoords`,
  `getChunk`, `listChunkKeys`. Reaching into `map.levels[zk][ck]` is now wrong
  (that index is a chunk, not a stack) and TypeScript will say so.
- **Change detection has three levels now**: map, level, *chunk*, then cell.
  Prefer the coarsest that answers your question — `syncTo` skips whole chunks
  by identity before it looks at a single cell.

The stored format stays flat, converted by `parseMap` / `serializeMap` via
`chunkifyMap` / `flattenMap`. Do not persist the chunked shape: the file is
hand-editable and version-controlled in `data/`, and `flattenMap` deliberately
emits cells in a stable (x, y) order so a one-cell edit is a one-line diff.

Batch multi-cell edits through `setStacks` in one call so each chunk is copied
once — `moveEntity` touches two cells and does exactly that.

### Do not sweep for the player

`requireSinglePlayer` is a full map sweep. `GameSession` memoises it on map
identity, confirms the last-known cell first (`playerStillAt`), then searches
the immediate neighbourhood (`findPlayerNear`) before ever sweeping — a commit
moves the player one cell, never across the map. A single tick can rewrite the
map several times, and without this each rewrite cost a sweep: stepping onto a
pressure plate was **8.1ms, now 0.17ms**.

### Typed arrays, not string-keyed Maps, in hot loops

`Map<string, T>` keyed by `` `${z}:${x},${y}` `` means a string build plus a hash
lookup per probe. In a ray-cast inner loop that dominates everything else.
Build a flat `Float32Array`/`Uint8Array` indexed off the region
(`DenseOcclusion` in `app/lib/lighting.ts`) — it took the light overlay from
1.94ms to 0.63ms.

Same idea one level down: do not iterate an array of tuples in a hot loop.
`SKY_EDGES` was `[[dx,dy,dz,cost], ...]`; destructuring it per edge cost more
than the work it fed. Flattened into one `Float64Array` the sky flood went from
**~95ms to ~13ms** with byte-identical output.

### Per-pixel work belongs in the shader

The light texture is RGBA: block light in RGB, sky factor in alpha, tinted
against `uAmbient` in the fragment shader. Time of day is therefore a uniform
write. Doing that tint on the CPU meant recomposing and re-uploading 17 textures
per frame; in the shader it is free. Before adding a CPU pass over pixel data,
check whether the GPU can do it while sampling.

### Mobility is a property of the tile, not of the frame

`isMobileTile` (in `app/lib/interactions.ts`) answers "can this ever change
cell", derived from gravity and a push interaction rather than declared. Two
subsystems key off it and both must keep using the same answer:

- The renderer keeps mobile tiles **out of the merged geometry batch**, always —
  not only while they are moving. Membership used to follow the live motion set,
  so a tile joined and left the batch as it started and stopped, and changing
  membership rebuilds the whole floor. That was a full rebuild per step.
- The light cache keeps **actors** out of the static bake, so a step does not
  dirty the chunks around them. The overlay paints them per frame instead.

Never reintroduce a hardcoded `player` check for either. It was true while
exactly one thing moved and silently wrong afterwards.

**The two predicates are deliberately different, and the light one is the
narrower.** Geometry batching asks `isMobileTile`; the bake omission asks
`resolveActor`. The rule for the bake is: **omit only what something paints
back.** `GameRenderer.emitterOverridesFor` produces one override per actor per
frame, so actors are exactly that population — and anything else omitted has its
light vanish outright, because nothing emits an override at a cell nobody is
standing in.

That is not hypothetical. The predicate used to be `isMobileTile`, and a hand
lantern is affected by gravity and passes light, so a lantern lying on the floor
was omitted from the bake and lit nothing at all. Omitting is only ever worth it
for something that moves *every frame*; a dropped item moves on the tick it lands
and dirties a cell doing it, which is a cost it was always going to pay.

**The light omission has a second condition, and it is not optional.** An actor
is omitted only when it is also light-passing. The overlay is add-only: it can
paint a light the bake left out, but it cannot carve a shadow the bake never knew
about, so omitting an occluder would light straight through it. An actor that
blocks light therefore stays baked and pays for its movement — the cat is exactly
this today. Giving mobile occluders dynamic shadows means teaching the overlay to
subtract, which is a much bigger change than widening the predicate.

A carried light takes the same path from the other end: it is on no cell at all,
so its override carries its `lights` explicitly rather than looking them up. See
`EmitterOverride.lights`.

### Size an invalidation by what actually changed

Not every edit is the same size. `ChunkedLighting.editReach` classifies a cell's
change before deciding how far to invalidate:

- **Occlusion changed** — height, physical volume, or light-passing — costs the
  full `LIGHT_APRON`, because shadows and sky spill travel that far. A door
  opening is this.
- **Only emission changed** costs that emitter's own radius. A torch reaches 8,
  not 15, which is usually one chunk instead of four.
- **Neither changed** costs nothing. A pressure plate pressing is this: both
  forms are height 0, solid and light-blocking, so the swap cannot alter a
  single baked cell.

The signature is written in terms of those *properties*, never the tile id.
Keying on the id is what charged a plate press a four-chunk rebake for output
identical by construction.

Two traps when testing this, both of which produced a green test that proved
nothing:

- **A mid-chunk edit passes at every reach**, because dropping the cell's own
  chunk already covers everywhere its light lands. Put the edit near a chunk
  edge.
- **An edit flush against the edge also passes at every reach**, because at
  offset 0 even a reach of 1 crosses into the neighbour. Offset it 2–7 cells in,
  so only a reach that genuinely spans the radius drops the right chunk.

No fixture tile exercises the emission-only branch — every one of them changes
occlusion when its light changes — so that test builds a synthetic lamp pair.
Verify by starving each reach independently and confirming the matching test
goes red.

### A flicker is cached per phase, never rebaked per frame

Light is authored per animation *frame* (`Frame.light`), so a torch can burn
bright on one frame and low on the next. The bake therefore takes the animation
clock — `WorldRenderer.animClock`, the same one the sprites read, so the light
cannot drift out of step with the art.

The clock being a bake input is the dangerous part, and the shape that makes it
affordable is worth keeping:

- **A chunk holds one bake per emission phase**, not one bake. A cycle is short
  and repeats for ever, so after one turn of it every phase is cached and a
  flicker costs a map lookup a frame. Rebaking on each flip would cost a full
  chunk bake (~4.7ms) several times a second, for as long as the torch burns.
- **Only chunks a flicker actually reaches pay anything.** `computeLightingFlood`
  reports the varying emitters it passed (`RawLightGrid.animated`) with their
  widest radius, and `ChunkedLighting` attributes each to the chunks within that
  reach. Everywhere else keys on `""` and never notices the clock — that is what
  keeps an empty field from re-stitching and re-uploading five times a second.
- **`tileLightVaries` is what separates the two.** A lamp whose frames all emit
  the same is not a flicker and must stay single-phase; treating every animated
  emitter as varying doubles the bakes and the memory for no visible change.
- The cache budget is spent in baked *planes*, not chunks, since a chunk near a
  torch holds several.
- **Collecting the varying emitters is its own pass, and must stay one.** Those
  few lines started out folded into the emitter gather, where they cost the
  whole bake ~6ms — not every run, which is what made it confusing: the flood
  compiled at either ~23ms or ~29ms depending on the process. Walking the cells
  a second time is far cheaper than the bake losing its compilation. Measure
  before folding anything else into that loop.
- **Phase lookups are memoised per clock reading** (`ChunkedLighting.defPhase`).
  A frame asks for the same tile's phase once per chunk of the window, up to
  three times over; answering it walks the tile's frames. Without the memo a
  quiet frame cost ~17µs instead of ~5µs.

Emission that varies per frame reaches the dynamic overlay too, and the two
kinds of override take it differently:

- **A body override is a position.** Its light is read from the stack at paint
  time, so `timeMs` threaded through `overlayEmitterOverridesPacked` is what
  animates it — and whether to emit an override at all asks whether the tile can
  *ever* emit (`tileCanEmitLight`), not what it is emitting this instant.
  Resolving the live frame there drops the override on the dark half of a
  flicker and the light never comes back.
- **A carried light arrives already resolved**, since it is on no cell for the
  cast to read. It is therefore resolved against `WorldRenderer.animTimeMs`
  where it is put on the override, or a torch would flicker on the floor and
  burn flat the moment it went in a bag. `emitterOverridesKey` hashes its
  values, so the overlay repaints when it changes.

The editor (`EditorRenderer`) is unchunked and bakes the whole map on a
debounce, so it deliberately stays at frame 0 — animating it would rebake
everything several times a second. Flicker is a play-mode effect.

### Bound the light cache, do not thrash it

`ChunkedLighting` caches baked chunks in world space, prefetches one ring chunk
per idle call, and evicts LRU. Two invariants worth preserving:

- Prefetch must not run on a call that already baked on demand, or the two costs
  land on the same frame.
- Never evict a chunk the current window is drawing — it would rebake next call.

`syncTo` must ignore tiles whose light is painted dynamically *and* that pass
light (the player). Without that, walking dirties the chunks around the player
and rebakes them for output that cannot differ.

### Lighting has an off switch, and off means *not computed*

The top bar of `/play`, `/online` and `/map` carries a Lighting toggle
(`app/components/LightingToggle.tsx`). Off is not a fullbright ambient or a
shader branch with the bake still running behind it: `sync` and `light` are
skipped outright in `WorldRenderer.setView`, nothing is baked, stitched or
uploaded, and `uLightingEnabled` draws the art as authored. Measured on the
fixture map at night it takes the worst frame in `/play` from 15.3ms to 1.9ms,
and the editor from 4.0ms to 1.9ms — which is also what makes it the first
thing to reach for when profiling anything *else* on the frame.

**Turning it back on must discard, not diff.** While it is off the cache stops
hearing about edits — `syncTo` is one of the things being skipped — so every
chunk it holds is suspect the moment light returns. `setLightingEnabled(true)`
therefore calls `invalidateAll` and drops the grid identity; the editor clears
`lightingKey` for the same reason. Anything cleverer here would have to reason
about edits nobody was watching.

## Testing the Durable Object

`workers/` runs under `@cloudflare/vitest-pool-workers` (`pnpm test:workers`),
inside workerd with real DO storage and the bindings from `wrangler.jsonc`.
`app/` stays on the node pool, which is far faster for plain logic.

The split exists because **three bugs in `GameServer` all lived in the
load / restore / checkpoint path and were invisible to a node test** — the
object has to be constructed from a checkpoint for any of them to appear. That
path is not exotic: every hibernation wake runs it.

Two rules learned the hard way here:

- **Revert one fix at a time when proving a test can fail.** Reverting all three
  at once made two of the three tests pass, because the first revert changed
  behaviour enough to mask the others — `requireSinglePlayer` treats an *owned*
  player tile as the marker, so without the carried spawn point it deleted the
  very body the duplication test was looking for. Three green tests, nothing
  tested.
- **Assert position, not just count.** "Exactly one body" passes whether an
  actor was re-seated on the body they had or handed a fresh one at spawn.
  Checkpoint them away from the spawn cell so the two outcomes differ; that is
  what caught the accept-before-load bug.
- **Every test in the file shares one world, one disk and every socket ever
  opened.** Nothing resets the object between tests, and a socket a previous
  test left open still answers `getWebSockets()` — so its owner is still "live"
  at the next wake. Reusing an actor name therefore carries the previous test's
  stored state *and* a phantom connection into the next one, which is fatal for
  anything about outliving a connection: use a fresh id per test
  (`freshPlayer()`). Two permanence tests passed for the wrong reason before
  that, and a third failed for it.

## Verifying performance work

**Prove the test can fail.** A parity test that passes at every setting is
testing nothing. Sweep the constant you are bounding — apron width, reach
radius, probe span — and confirm the test goes red when it is too small. One
parity test here passed at `apron=0` because batching had quietly turned the
scenario into the very thing it was comparing against.

**Diff the bytes.** Optimisations to lighting must be byte-identical to what
they replace, verified across all three `AMBIENT_PRESETS` and several player
positions, not eyeballed in a screenshot. If output legitimately changes, say by
how much and where.

**Check which renderer you are measuring.** `/play` uses `GameRenderer` →
`WorldRenderer`. `/map` uses `EditorRenderer`, which has its own lighting path
and does **not** use the chunk cache. Numbers from one say nothing about the
other.

**Frame counters in a headless or backgrounded browser are meaningless** —
rAF is throttled, so the loop only advances when something forces a frame.
Measure in Node, or read the in-game counter on a real screen.

## Known remaining costs

Not yet fixed, and worth knowing before you profile something else:

- **Level geometry rebuilds wholesale whenever the merged batch really changes.**
  `rebuildDirty` now takes an incremental path first: it diffs the level to its
  changed cells, compares each one's *merged* contribution before and after
  (plus the autotile ring around it), and if none differ it rebuilds only the
  own-mesh tiles in those cells. Gameplay motion always lands on that path,
  because mobile tiles are never in the merged batch.

  An actual edit — placing or erasing terrain — still falls back to
  `removeLevel(z)` + `buildLevel(next, z)`, which is every cell of the floor.
  Level 0 is 4565 cells / 6402 quads, and `listCoords` + `getFrames` over it is
  6.5ms before THREE builds a single buffer. That is the remaining cliff, and
  the per-(level, chunk) batching below is still the answer to it.

  The data model is already chunked, so the dirty *chunk* is available by
  identity (`prev.levels[z][chk] !== next.levels[z][chk]`). What remains is the
  renderer side: geometry is batched into one merged group per level, so making
  it per (level, chunk) means re-keying `levelGroups`, `animatedByLevel`, the
  `movableMeshes` key prefixes, motion ghosts, and `applyLevelVisibility`'s
  roof-cut. Depth itself is safe — it comes from the per-quad box attribute
  resolved in the shader, not from draw order — but verify visually in a real
  browser regardless.
- **The editor is a second, unchunked lighting path** and will hit the same wall
  the play renderer already climbed.
