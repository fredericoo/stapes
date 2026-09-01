# Agent notes — Stapes

## The server is a Bun process that stays up

`server/` runs on Bun and holds one world in memory. `app/` is a static bundle
that runs in a tab. There is no server rendering and no shared runtime between
them — only shared *modules*, which is why `app/game/` and `app/lib/` are
imported by both.

- **`server/GameServer.ts` is the world**, and it is very nearly the file that
  used to be a Durable Object. It takes `{ ctx, env }` in its constructor, where
  `ctx.storage` is a `WorldStore` and `ctx.getWebSockets()` is a `SocketHub`.
  Those names are deliberate: several hundred call sites read `this.ctx.storage`
  and did not have to change, and neither did the suite that guards them.
- **`server/world.ts` is everything the platform used to do around it** — the
  checkpoint loop, the alarm timer, the drain. About two hundred lines, none of
  which is simulation.
- **Nothing under `app/game/` or `server/GameServer.ts` may import Elysia.** The
  framework's whole footprint is `server/index.ts` and `server/api.ts`. That
  containment is what makes the version choice cheap to revisit.

### One process, enforced

The Durable Object guaranteed exactly one instance of the world existed
anywhere, and every line that treats the in-memory board as authoritative
depends on it. Nothing on a virtual machine provides that, and two processes on
one database write a board blended from two timelines — which then persists,
because the checkpoint is preferred over the authored map on load.

`server/lock.ts` opens the database with `PRAGMA locking_mode = EXCLUSIVE`, so a
second process fails at open rather than after two seconds of divergence. It is
tested across real processes in `server/lock.test.ts`, because POSIX locks are
per-process and an in-process test would report a guarantee that does not exist.

**Do not remove this to make a rolling deploy work.** Drain-then-start is the
deployment model; the overlap a rolling deploy wants is the thing being
prevented.

### Storage is one file

`stapes.db`, through Turso — a SQLite-compatible engine, which is the same
storage model the Durable Object had, since `ctx.storage` was SQLite underneath.

- **`server/WorldStore.ts` keeps the Durable Object's key/value shape.** Values
  live in a `kv` table rather than normalised into per-actor and per-chunk
  tables. That is on purpose and is not the end state: reshaping the persistence
  of the most heavily tested file in the repo, in the same change that moved its
  runtime, would have meant the suite proved nothing about either. Normalise
  later, with the suite green on both sides.
- **Writes are buffered and committed together.** `put` records synchronously
  and `flush` commits the batch in one transaction, which is what lets
  `saveActors` stay synchronous inside a tick. It is also what makes a death
  atomic — `pendingDeathWrites` exists to work around a board write and an actor
  write landing separately, and can be deleted once somebody covers it.
- **Turso is not fully SQLite yet.** `WITH RECURSIVE` is unsupported, which one
  test hit. Expect to meet more of these; the production statements are all
  simple.

### Authored content

`DataStore` is unchanged, and `Blobs` still has two implementations:

- **Dev — `DiskBlobs`, over `data/` on disk.** Still the single source of truth
  while developing: an edited PNG is live on the next request, and the editor's
  Save lands in `data/map.json` as a reviewable diff. It is a file read now. The
  Worker had no filesystem, so this used to be an HTTP call to a Vite middleware
  at an origin threaded through the socket handshake — all of that is gone.
- **Deployed — `SqliteBlobs`**, in the `blob` table. A fresh deployment seeds
  itself from the `data/` in its image on first boot, and after that the deploy
  pipeline keeps the store tracking the repo: its last step is
  `POST /api/seed`, which copies the image's `data/` over the store and
  restarts the world on it (`World.reseed`). Merging a map or tile change to
  main is therefore all it takes for it to be live.

**There is still a third copy, and it is still not `DataStore`'s.** The world
being played prefers its own checkpoint to the authored content and carries each
player's kit, tags and masteries across a save on purpose — so writing blobs
alone changes nothing anybody can see; the world has to be replaced with them.
`/api/seed` does that on the editor-save path with positions kept
(`replaceWorld` with `keepPositions`), so a deploy resets the map around the
players without resetting the players. `POST /api/reset` remains the
destructive way out — every position, kit, tag and mastery goes with it.

## `bun dev` runs both halves

One command, two processes: Vite for the client and `bun --watch` for the server,
on ports `scripts/dev.ts` asks the OS for. It picks free ports because several
worktrees run at once — with a fixed server port, the second worktree's client
proxies to the *first* worktree's world, which looks exactly like a state bug and
is not one.

- **The database is a file in the worktree** (`./.dev/stapes.db`, gitignored), so
  worktrees cannot collide. `rm -rf .dev` resets a branch's world.
- **`bun --watch` runs the drain on every restart.** It sends SIGTERM before
  restarting, so a server edit checkpoints the world, closes sockets with 1012,
  and the page reconnects to where you were standing. The most safety-critical
  path in the system is therefore exercised constantly by people not thinking
  about it.
- **Two browser tabs share a cookie**, so they are the same actor and it looks
  like joining is broken. Use `localhost` in one and `127.0.0.1` in the other.
  Unchanged, and still the first thing that will waste somebody an hour.

## `dependencies` is what the *server* needs, and nothing else

React, three, the icon sets and the rest of the client's packages are
**devDependencies**, which looks wrong for a web app and is not. The client is
built in continuous integration and shipped as files; the image runs
`bun install --production` and loads none of them. Leaving them in
`dependencies` made the image 672MB instead of 439MB, all of it code the process
never opens.

The four that stay are the ones `server/` actually reaches: `elysia`,
`@tursodatabase/database`, `valibot` and `unique-names-generator`. If a server
module ever needs a fifth, move it — and if the image starts growing again, this
is the first place to look.

(Unrelated but adjacent: `@react-router/dev` declares `wrangler` as an optional
peer dependency, so a dev install still pulls workerd's binaries. They are
devDependencies of a devDependency and never reach the image — 23 packages go in
it — so this is disk on your laptop, not weight in production.)

## The client is files on the volume, not in the image

`server/clientBundle.ts` serves the built client out of `<DATA_DIR>/clients/`,
where continuous integration posts it — `POST /api/client/upload` takes a tar
archive, `POST /api/client/activate` makes it live. There is no bucket, no S3
credentials and no MinIO: on a single box, object storage would mean either
paying somebody else or running a service to talk to itself over HTTP.

Two properties hold this together, and both have tests because both are easy to
break by accident:

- **A server deploy must not take the client down.** Builds are on the mounted
  volume rather than in the image, and the server writes down which one it is
  serving (`clients/active`) so a fresh container comes back on the same page.
  Trusting `CLIENT_BUILD_ID` instead would roll the client back to whatever the
  first deploy set.
- **Upload and activate are separate.** An upload that half-finished must never
  become the live page, and a tab that loaded five minutes ago must still be able
  to fetch *its* chunks — so old builds stay resident and are still served.

## Known: a rebirth inherits the status that killed you

**Not fixed, and deliberately left for a design decision.** Reported from the
live server: an unarmoured player walks onto a `flame`, takes `burned`, dies —
and on rebirth burns to death again, repeatedly.

The mechanism, so nobody has to find it twice:

- Hit points *are* restored. `lastHpOf` reads a stored value below 1 as
  `undefined`, which `spawn` takes as "ask the tile", so the new body is at
  full. That is why this reads as "health is not restored" and is not.
- **Statuses are restored verbatim.** `burned` runs up to 24 seconds and stacks,
  so a body reborn inside that window is already burning and goes down again
  before anybody sees the full health bar.
- The cause is that `restoredActor` serves two events that want opposite things.
  A **reconnect** is the same body and should keep its statuses; a **rebirth**
  is a new body and should not inherit what killed the old one. `seatActor` is
  on both paths and cannot currently tell them apart.

The small fix is to clear statuses when seating a body whose predecessor died,
leaving kit, tags and masteries alone. It is left undone because "what a death
costs you" is a game design question rather than a bug — see the same tension in
`resetWorld`, which carries kit and masteries across on purpose.

## The wire has a version on it

`PROTOCOL_VERSION` in `app/net/protocol.ts`. **Bump it in the same commit as any
change to the message schemas.** The client sends it as `?v=`; a mismatch gets an
`outdated` message and a close with 4001, and the page reloads once.

Accepted-then-closed rather than refused at the upgrade, because a browser hands
a rejected upgrade to the page as an indistinguishable failure — a client refused
that way cannot tell "reload me" from "the server is down".

## The simulation holds N actors

`GameSession` runs any number of actors. `/play` runs exactly one and never
names it (`LOCAL_ACTOR_ID`); the game server will spawn one per connection.

- **Ownership lives on the placement.** `PlacedTile.owner` is what tells two
  identical `player` tiles apart. Authored maps never carry one — the map's
  single `player` tile is a *spawn marker*, and `requireSinglePlayer` now exists
  only to read it. Nothing in the tick loop calls that function: the invariant
  it enforces is broken deliberately the moment a second actor joins.
- **A resident's name is also its address, and that is load-bearing.**
  `residentOwnerId` mints `npc:<x>,<y>,<z>,<stackIndex>` from the *authored*
  placement, and `residentHome` reads it straight back out. Nothing else records
  where a creature belongs: the id is minted once from `data/map.json`, rides on
  the placement through every checkpoint, and is handed back to whatever respawns
  there — so it survives the reload that a birthplace recorded at adoption cannot,
  because a resumed world adopts a body wherever it had already wandered to. That
  is what the brain's `home` selector reads, and it is why a leashed snake goes
  back to the cell the author put it on rather than to the one it woke up in.
  Change the format in one of those two functions and you have changed it in
  both, three lines apart; change it anywhere else and every creature in the world
  forgets where it lives.
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

**The write must not gate the broadcast.** The platform used to hold outgoing
messages until preceding writes were durable, which was right for anything the
world's consistency rests on and wrong for this: a position is a convenience,
and paying for it with every client's latency thirty times a second is a trade
the world cannot afford. Nothing enforces that ordering now — `WorldStore.put`
buffers and returns — so the property holds by construction rather than by the
old `allowUnconfirmed` flag, and the throttled flush
(`POSITION_FLUSH_INTERVAL_MS`) stays for its own sake — a
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
  you swing with, a `WeaponItem.offhand` thing (a shield) or an `ArtifactItem` (a
  torch) in the other, an `ArmorItem` on your body, an equippable container on
  your back. It is what happens when nobody has said. A drag is somebody saying,
  so `slotAccepts` stays the looser of the two. It reads the parsed union
  directly rather than asking four resolvers in turn, so an arm added to
  `ItemDef` and forgotten here fails to compile.

**The body slot is the one square that refuses a drag**, and the exception is
deliberate. Both hands are generous because a hand *is* generous; defence is the
entirety of what the armour square contributes to a fight, so a sword worn as a
shirt would be a number about nothing. `slotTakes("armor", …)` is
`resolveArmor(def) != null`, which is also the one case where the two questions
above give the same answer. A hand will still hold a breastplate — you can carry
one without wearing it.

`WeaponItem.offhand` is the exact counterpart of `ContainerItem.equippable`:
nothing about a tile says which hand a block of weapon numbers is for, so the
author says it. It used to be guessed from whether the tile gave off light;
`itemUseFor` asked that question too, and now both read the flag.

**`ArtifactItem` is the arm with no fields, and a torch is what it is for.** A
torch had to be a `weapon` because holding a thing needed a block and that was
the only block with an off hand — so a body holding one *fought with it*, and
`weaponInHand` replaces your natural weapon with whatever is held, which made a
torch strictly worse than a pair of fists. The light was coming off the sprite's
frames the whole time; none of those numbers were ever wanted. They are gone
rather than tuned upward: no `resolveWeapon`, so the natural weapon stands and
`offhandDefence` reads zero, and the thing's whole effect is being a placement
that emits light. It needs no `offhand` flag either — nothing inert is ever meant
for the hand that stands in for what you fight with, so `equipSlotOf` sends every
artifact to the off hand and a flag with one legal value stays unwritten.

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
sword, you hold a torch, you wear a mail shirt, you put on a pack. Since both hands take anything, a
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

## A chase is a route, and it stops being one

`step_toward` used to judge one step on its own: of the four directions, take
whichever gets nearer. That is defeated by a single crate. Everything that would
close the distance to somebody due east is east, so a rat with a box in front of
it stood there being unable to reach a player it could plainly see.

`app/game/pathfinding.ts` answers with a route instead, and three decisions
carry it.

- **Every leg is one `canWalk`** — the same call the player's own step goes
  through. Climb bands, level promotion, climb-from flags and whether a body
  fits are not written down a second time, so a route can never contain a step
  the walk loop then refuses. It is also how a route gets heights and floors for
  nothing: a node is a *standing cell*, and two cells on different levels are
  neighbours exactly when a body could walk between them. The cost of that reuse
  is that `canWalk` is a column scan and a fit check per direction, which is
  most of what the two caps below exist for.
- **Arriving is standing beside them, on their own floor.** A body is not
  walkable, so a search for the target's own cell would exhaust the board every
  time. Requiring the same level rather than plan distance alone is what makes
  somebody on the balcony worth walking a staircase for — standing underneath
  them is not standing beside them, and a route that thought otherwise stopped
  dead at the foot of the stairs. An **empty** route is a creature that has
  arrived and is a different fact from there being no way there, which is why
  the two are not both null: the first falls through to the next line of the
  priority list, and so does the second, but only the second is a `stuck` an
  author can transition on.
- **A drop is a one-way edge and it is opt-in**, on the same `allowDrops` the
  action already carried. Where gravity would put the body down is resolved as
  part of the edge, because a route planned from mid-air is a route about a cell
  nobody is ever standing in.

**Two caps, doing two different jobs, and it is worth not confusing them.**
`PATH_DETOUR_SLACK` is about *behaviour*: a route far longer than the gap is not
a chase, it is a creature that has worked out where the door is. `PATH_MAX_NODES`
is about *cost*, and the numbers either side of it are far apart — routes
anybody actually walks settle in seven to twenty-five cells, while proving a
target unreachable means exhausting every cell a body could stand on. Running
out of either reads as no route at all, deliberately: a half-explored search has
a best-so-far cell it could head for, and walking towards that is exactly how a
creature ends up pressed against the nearest wall having made progress.

**Nothing is kept between two decisions.** A route is recomputed each brain
tick rather than followed, because a kept plan is a plan about a world that has
since moved — the target walked on, a crate was shoved into the third step,
another creature filled the fourth. At one decision per step the check that a
kept route was still true would cost about what recomputing it does.

**Fleeing is still greedy, and that is not an oversight.** `step_away_from` has
no destination to route to; "away" is a direction rather than a place, so the
question a fleeing animal asks really is the local one. Inventing a goal cell to
run at would be the pathfinder deciding where something wants to hide.

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
masteries, a natural weapon, what it notices and what it is born carrying, parsed
rather than trusted like every other interaction. The player,
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

### Armour is worn, and it may care what hit it

**Defence has three sources and they add** (`wornDefence`): a `WeaponItem.def`
in *either* hand — a shield, a bracer, a parrying sword — and an `ArmorItem` on
the body. A shield stays a `weapon` rather than becoming armour because it is a
thing you *hold*: making it armour would put it in the square a breastplate
belongs in and let a body wear one instead of the other. Two shields are twice
the shield.

**The main hand replaces rather than adds, within its own slot.** What counts
there is `weaponInHand` — the held weapon or the body's natural one — so taking
up a shield trades your claws' `def` for the shield's along with trading your
bite for whatever the shield swings like. That is the same replacement rule the
swing is under, and it is what stops a main-hand shield being free.

`wornDefence` is the only honest answer to "how protected is this body", and
`effectiveBattler` **assigns** it rather than adding it to what `fightingStats`
worked out — `fightingStats` resolves the weapon and therefore already counted
the main hand. That split is worth knowing about: it is why a comment on
`WeaponItem.def` once claimed a main-hand `def` did nothing, which was false when
it was written.

**A resistance is keyed by the attacker's weapon mastery** (`ArmorItem.resist`),
and that is not a taxonomy invented for it — `WeaponItem.mastery` is already on
every weapon in the world, deciding how it scales and what swinging it teaches.
Inventing a damage-type axis beside it would be a second list of kinds to keep in
step with the first. `FightingStats` therefore carries two new fields: `mastery`,
so a blow can say what it is, and `resist`, so a body can say what it is wearing.
`defenceAgainst` in `app/game/combat.ts` is the one place they meet, and it is
the only thing that should ever read `defender.def` on its own.

**It is the attacker's *weapon* mastery, never the wielder's best skill.** A
novice swinging a sword is still striking with a blade, and mail turns it aside
on the same terms it turns aside an expert's.

**Additive and never a share.** Defence is subtracted from a blow, so a
percentage resistance would be a second arithmetic beside the first and nobody
reading a fight could hold both. The most a piece of armour can do is
`def + resist[kind]`, which an author reads straight off the block. This is what
makes armour a choice rather than a ladder: with a flat number alone every piece
is strictly better or worse than every other, and the only decision left is which
one you have found.

Resistance is **read, never rolled for**, so a warded defender costs a swing
exactly the four draws a bare one does — the same rule everything in a fight is
under.

### A body is born carrying what its tile says

Every battler has a **kit** (`app/lib/kit.ts`), authored on the same block as its
masteries and its natural weapon, and rolled into an `Equipment` exactly once —
when the world puts that body on the board (`app/game/battlerKit.ts`). The player
is not a special case: their backpack is a row on the `player` tile's kit at 100%,
authored the same way a rat's mouthful of meat is authored on `rat`. There used to
be a `STARTING_BAG_TILE_ID` constant beside `PLAYER_TILE_ID` naming that bag
directly, and it is gone — one place decides what a body owns, rather than one for
people and one for everything else.

- **The shape is the slots, not a loot table.** Every row names an equip slot —
  the same squares a player drags things between — so a wolf authored with a
  torch in its off hand *lights the wood it is standing in*, one authored with a
  sword *swings it*, and a goblin authored in mail *is protected by it, in full*.
  Nothing downstream knows a wolf is not a person: `carriedLightTileIds`,
  `weaponInHand` and `effectiveBattler` were already reading an actor's equipment
  and needed no changes at all — armour was one more slot on `Equipment` and one
  more term in `effectiveBattler`, and every creature in the world could wear it
  the same afternoon.
- **Several rows may name one slot, and the first success takes it.** That is how
  a weighted table is written: put the rare blade above the rusty one. Chance is
  a percent and floats are allowed, because a quarter of a percent is the shape a
  rare drop wants and a whole-number scale cannot say it.
- **Every row costs exactly one draw, whatever lands.** A row aimed at a square
  already taken is still drawn for, and so are the contents of a container that
  never arrived — the same rule a swing (three draws) and a decay lifetime (one)
  keep, and for the same reason: a draw count that varied with what an author
  typed would mean adding a dagger to one wolf changed what every creature in the
  world rolled after it. The dice are the world's own (`GameSession.rng`), so two
  worlds on one seed agree about what the wolf was carrying as well as where it
  walked. **Authoring a kit still moves the stream** for everything drawn after
  it, which is not a bug and is worth knowing before reading a seeded test that
  went red: `brain.test.ts` pins its own seed for exactly this reason.
- **A kit may not put a body in a state a drag could not.** The roll asks
  `slotAccepts`, the same answer every drag and every rot asks — so the back
  takes only a pack you can wear, a hand takes anything you can carry, and the
  nesting rule still bites inside a container. A row the world has since made
  impossible (renamed tile, shrunk bag, a chest made unwearable) lands nothing,
  silently, on the terms `restoredEquipment` drops a sword the catalogue lost.
- **A respawned body rolls again**, on exactly the terms its hit points are
  rebuilt from the tile: what grew back is a new creature, not the one that died
  holding what it was holding. So is a body re-adopted after an eviction — same
  bargain hit points and brain memory already take.
- **A creature's kit is never written down.** `saveActors` excludes residents
  from the `equip:` row for the reason it already excluded them from `pos:`:
  a creature is adopted *out of* the board and re-rolls as it is adopted, so a
  stored kit is a copy the next wake overwrites before anything could read it.
  That gate used to be "only a kit with something in it", which came to the same
  thing while every creature had an empty one and stopped the day a rat could be
  authored carrying meat.
- **Dying drops it, and that is one function.** `kill` → `dropKit` never asked
  who the body belonged to, so wildlife dropping its kit needed no new path —
  which is the whole of "a player is just another battler" holding up under a
  feature that could easily have grown a second one.

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
  targeting now free of intent, that would hold the tick loop open for as long
  as somebody stood watching a deer. It is a target *and* the mode that costs a
  world its sleep. The cost is a busy core rather than a bill now, and on a box
  shared with several preview worlds that is still worth not paying.
- **The stance is re-sent, not remembered.** `hello` seats a fresh body that is
  not swinging at anybody, so `RemoteSession` says the mode again on a world
  replacement and the page says it again on a reconnect, exactly as held
  directions are resent. The target is dropped instead of resent, because it
  names somebody in a world that no longer exists.

The colour of the outline follows from the mode rather than from having a target
at all: white while you are only watching, red once it is a fight, and pulsing in
both cases because the pulse is what separates a *chosen* body from one the
cursor happens to be over.

**What a tap means is one setting with three positions, not a pair of switches.**
Interact, inspect and attack are the three, exactly one holds at a time, and the
machine is `app/components/usePlayModes.ts`. They were two independent latches
and the failure was reported rather than guessed at: with no *name* for "neither
one is on", people drew the sword, walked off, and never connected the red
outline under everything they pointed at with a button they had pressed a minute
before. Two consequences worth knowing about:

- **Shift covers the chosen mode rather than replacing it.** The key is momentary
  and the buttons latch, so the chosen mode is kept in its own piece of state and
  shift is read over the top of it — which is the whole of "revert on release",
  with no previous-mode bookkeeping to fall out of step. Holding shift in attack
  mode suspends the fight and letting go resumes it.
- **A body's row is renamed rather than replaced.** In attack mode the row on a
  battler says "Attack Rat" instead of "Target Rat"; it is the same row running
  the same `target` action, because the tap does one thing either way. Which
  means the label is part of what `GameRenderer` diffs before handing the list to
  React — a key of ids and health would recompute the right words and then decide
  nothing had changed.

The formulas live in `app/game/combat.ts`, kept pure so they can be asserted:

- **`acc` widens a band downward; it never raises the ceiling.** Full damage is
  always `atk`. Within the band the roll is triangular, so a middling blow is
  common and both a glancing and a shattering one are rare.
- **`flee` is contested against the attacker's `acc` on a logistic curve**, which
  is what stops perfect accuracy from erasing the stat.
- **`spd` is geometric between 6 and 600 ticks.** Linear would make the whole
  lower half of the stat indistinguishable from zero; on this curve 50 is twenty
  ticks.
- **A swing always costs three draws**, whatever the stats. The dice are seeded so
  a world is reproducible, and a draw count that varied with accuracy would make
  one creature's stats change what every creature after it rolled.

### A blow costs the thrower a step

Swinging is automatic and used to cost the body doing it nothing, so the
strictly better way to fight was to never stand still: hold a movement key, let
the cooldown do the swinging, and a fight was decided by whoever was willing to
keep walking. Every blow now plants its thrower — `ActorRuntime.attackRecoveryMs`,
spent in `tryAttack` beside the cooldown and wound down beside it.

- **The length is that body's own step**, read off the tile through
  `resolveWalkDurationMs`, not a constant of its own. A creature authored to walk
  slowly would otherwise be punished twice for it. It has nothing to do with
  Agility, deliberately: this is the one cost in a fight nobody can train away.
- **Only the *start* of a step is gated.** A walk already in flight when the blow
  goes out finishes — a body cannot be stopped mid-cell without leaving it
  standing between two of them.
- **The turn is free.** A blow costs the step, not the aim, or a cornered fighter
  could point nowhere but at what is already hitting them. `applyStepRequest`
  gates after the facing, and `RemoteSession.predictStep` gates in the same place
  so a planted player faces the same way on both sides.
- **A queued step is `"later"`, never `"refused"`.** A recovery is a wait, so the
  step the client drew is one it is going to get; rejecting it would drag the body
  back to where it swung from.

At the end of the curve a weapon whose blows come round faster than its holder
walks roots them for as long as they keep swinging, because each recovery is
reset before it runs out. Nothing authored is near it — the quickest natural
weapon in `data/tiles.json` is the rat's, a blow every 867ms against a 150ms step
— and that gap is the room the rule leaves for footwork.

**The client has to re-run this rule, which is why `swung` is on the wire.** It
is the only combat fact the browser cannot be told the outcome of: steps are the
one thing it decides for itself, so a client predicting through a recovery draws
a run the server holds a cell at a time and spends the fight being corrected.
The event carries an id and nothing else — how long a body is planted is how long
it takes to walk, and both ends read that off the tile, exactly as neither end is
ever sent a walk's duration. It is its own event rather than a flag on
`strikeStarted` because half the blows in the game do not lean: an archer never
throws itself at anything, and a bow whose holder could keep walking while a fist
could not would apply the rule to whoever picked the wrong weapon.

### Reach is a disc and a lid, and both belong to the weapon

`app/game/distance.ts` measures reach as two independent numbers — a radius on
the plan and a height either side of it — rather than as one radius in three
dimensions. It was a sphere, with height weighted at a whole cell per unit so
the melee box fell out of a single number, and that worked for exactly one shape.
A bow is the same question with a bigger answer and the sphere gives the wrong
one: at six cells' radius, "six cells across the yard" necessarily also means
"six cells straight up", which is three storeys nobody meant to shoot through.
No weighting fixes it — a weighting decides where the sphere bulges, never that
the shape has a flat lid.

The pair is also what the rest of the game was already doing in private:
`affordances` measures what you can touch as a disc plus a level slack, and a
brain's `in_range` measures plan steps plus its sight's up and down. Neither
could be written against the sphere, so neither was.

Height is in **height units** (two to a level) and absolute, never in floors: a
body on a crate is half a level above the floor it shares with you, and half a
level is the only unit an arm's reach can be said in.

**`BattlerDef.range` is gone, not deprecated.** Reach is `WeaponItem.reach`, so a
rat that picks up a bow shoots as far as the bow carries — a body has no reach of
its own, because bare hands are a weapon and a bite is a weapon and each carries
the distance it works at. A `range` left on a tile parses fine and is dropped.

### A ranged weapon is one with a projectile, and the arrow is only a picture

There is no `ranged` flag and there must not be one: a weapon is ranged exactly
when it authors a `projectile` block (`isRanged`). Two fields saying the same
thing is a bow authored to fire nothing, or a sword that lunges *and* puts an
arrow in the air.

- **A ranged weapon never leans.** `swingToward` asks the weapon before it asks
  the distance. The half-tile lunge claims a *contact*, and an archer with
  somebody in their face still looses an arrow — gating it on distance alone read
  correctly only because a bow's target used to always be far away.
- **The dodge hop is gated on neither**, which is the asymmetry: it is the only
  account of a dodge anybody gets, so an arrow avoided at five cells has to show
  something or the shot vanishes.
- **The damage is settled on the tick the shot is loosed**, and the arrow arrives
  later carrying nothing. This is not a shortcut around the physics: a blow that
  lands when the arrow *arrives* depends on a flight drawn on a clock every
  client runs differently, so two people would disagree about when somebody died.
  Damage now and the arrow after is the one arrangement where the picture may lag
  the truth and can never contradict it. A shot at somebody who dies first still
  finishes its flight; taking it back would be the picture editing itself.
- **`canReach` is where a wall costs something, and only there.** Picking a target
  asks neither range nor line, deliberately: you can read a name and a health bar
  through a window you cannot shoot through, and the shot simply does not go.
- **The speed is authored in cells per second, not pixels per millisecond.** The
  first arrows floated across the yard because `0.03 px/ms` is three and three
  quarter cells a second — slower than the five a body walks at — and no reader
  of that number could tell. A speed is only authorable in the unit the map is
  drawn in. `DEFAULT_PROJECTILE_SPEED` is twenty, four times walking pace, which
  puts a six-cell shot at about the length of one melee swing.
- **A flight is one event and never touched again** — two fixed points and a
  duration, on the terms a walk is announced once. No position stream, and no
  actor id at either end, because by the time it is drawn there may be nobody
  there. `GameSession` holds the live flights (aged on the tick clock) and
  `RemoteSession` holds its own (aged on the render loop), exactly as damage
  numbers are split.
- **An arrow in the air holds the world awake**, on the same terms a lean does:
  this loop is the only clock it has, and a slow shot across a courtyard is a
  visible second of somebody's screen.

Drawing is `WorldRenderer.applyProjectiles`: one mesh per flight, made once and
moved ever after, in a group under `world` rather than in a level group — a level
group is destroyed whenever its floor changes, and a mesh parented in one would
be disposed underneath the map still holding it. Group membership decides nothing
about sorting (depth is per-fragment from the box attribute); the one thing it
did decide, roof-cut visibility, is a line of code instead. The mesh takes the
material of whichever level its *height* puts it over, re-asked per frame so a
shot from a balcony is not lit by the room it left for the whole descent.

### Tiles can be eight-way

`TileType` has `directional8` beside `directional`: the same `sprites` field with
the four corners added, because an `Octant` *is* a `Direction` where the two
overlap. A lookup written for four keys reads eight without noticing, and a
missing corner falls back to the cardinal it is nearest before falling back to
south.

Placement, movement and climbing stay four-way and must. A placement faces one of
four ways because walking is four ways; climb variants are four because a body is
walked into from four sides. Only things that travel on an arbitrary bearing —
projectiles, so far — ever supply an eighth.

**Zero hit points deletes the body, and leaves the kit where it fell.** For a
player it also removes their actor, so the server ignores everything their socket
sends. They come back at the door they came in by, on full hit points, wearing an
empty bag, with everything they were carrying lying where they died. The walk
back is the cost.

## Magic is a stone you carry, and there is nothing else to it

There is no mana, no spell book and no spell slots. What a caster can do is
decided by which **arcane stones** they are carrying and how recently each was
used — so the whole of a loadout is two hands and a charm, which is why the
desktop binding is `1`, `2`, `3` and stops there.

A stone is an arm of the item union beside weapon, armour, shield, consumable,
container and artifact, and it is a kind of its own for the reason a shield is:
both hands swing, so anything held that is not meant to be swung has to be
refusable by the rotation. `weaponSwungBy` refuses everything that is not a
`WeaponItem`, and that one existing line is the whole of "a stone in a hand
never swings". One stone and a sword swings the sword every turn; two stones
falls back to fists, because the rotation already skips a hand with nothing in
it. Nothing was written for either.

### The effect vocabulary is three things, and closed

**Heal** the caster, **status** on the caster or the target, **conjure** a tile.
Every one of them is something the simulation could already do to somebody,
which is why casting added no new physics: "luminous" is an ordinary authored
status whose visual block carries a `LightDef`, riding the same emitter path a
carried torch does. Area of effect is deliberately absent — no spell touches
more than one target or more than one cell.

A hand stone reaches for the target the player already picked for attacking, and
a **charm reaches nobody but its wearer**. A conjure lands on the target's cell
or, with nobody targeted, on the cell the caster is facing: the player never
picks an arbitrary square. Range goes through `canReach`, so a spell out of range
fails exactly the way a swing does, wall included.

**A conjure lands *under* a body already standing there**, which is the same rule
`/tile` places underfoot by. What a tile does to a body is read off the stack
below it, so a flame conjured on top of somebody would be a flame nobody is in —
and a flame aimed at a target who is standing still would do nothing at all.

### The cooldown is per stone, durable, and locks the square

`ItemInstance.cooldownMs`, so two identical stones in two hands cool
independently. It rides the kit, which is the one piece of a body's state a world
already owes continuity for — so it survives a reconnection, an eviction and a
deploy for free. **This is the opposite of how hit points' fight state is
treated, and deliberately:** a cooldown rebuilt on load would make reconnecting
the cheapest spell in the game.

It is the one `ItemInstance` field that does **not** round-trip through a
`PlacedTile`, and that is a deliberate hole in the correspondence
`app/lib/itemInstance.ts` exists to protect. A deadline on a placement would land
in `data/map.json` the moment somebody saved from the editor — the same objection
`DecayIndex` makes about keeping its clocks off the map. Nothing is lost by it,
because a cooling stone cannot be put down at all.

**Wound in whole seconds, not per tick.** Winding it means replacing the kit that
holds it, and the kit's identity is what tells the renderer its panel is stale
and the server there is an equipment message to send — so a per-tick countdown
would re-render the page and put a whole inventory on the wire thirty times a
second, for ever, for a number nothing can show that finely.

**A cooling stone is locked in its square**: it cannot be moved, swapped or put
down. This is the second cross-cutting square rule after the two-handed weapon,
and it lives beside it in `app/game/equipment.ts`. Without it a caster carries
six stones in a bag and rotates through them, and the cooldown decides nothing.
The lock is on *player-initiated* moves only — a death drops the whole kit
regardless, and what lands is ready. It is also the only refusal in the item
model that says anything out loud, because it is the only one where a player can
plainly see something in a square and plainly cannot empty it.

### Castability is one pure module, and it answers with a reason

`app/game/casting.ts` answers "which stones can be cast right now, and why not"
for four callers who must never disagree: the phone's buttons and the desktop's
number keys, the session honouring a cast, and the tests. Same arrangement
`itemMoves` and `affordances` are under.

It returns a **reason** rather than a boolean because a button has exactly one
appearance for "you cannot use this" — cooling, out of range, no target and
mastery-not-met all look identical, which is right — and precisely because the
picture collapses them, the accessible name must not.

**An unmet requirement refuses the cast outright**, unlike a weapon's, which
merely makes the swing feeble. A weapon half-understood still swings because
swinging is a body doing what bodies do; a stone either answers you or it does
not, and "it fires at a third strength" is a worse thing to learn from than "not
yet".

### Casting is paid for by what the spell did, over a flat floor

A third earnings function beside the attacker's and the defender's, keyed on an
amount rather than an attack outcome: damage dealt to somebody who is not the
caster, and health **actually restored** to the caster — so a heal at full
health teaches nothing from the heal. Damage to yourself pays nothing, or
training would be something you do to yourself in a corner.

**And every cast pays a small flat fee on top, whatever it was.** Outcomes alone
work for a swordsman, because every swing is aimed at somebody, and do not work
for a caster: a stone of light does nothing measurable to anybody, and a stone
of flame asks Arcane 10 before it will fire. Paid on outcomes alone the bottom
rung of the ladder is missing, and the only way onto it is a stone you are not
yet allowed to use.

So the fee is **flat and unscaled** — not by what the stone asks, not by what
came of it, not by who you were pointing at. Every scale that applies elsewhere
is a scale that could take it back to zero, which is the one thing a floor must
not do. It is paid where the cooldown is spent, for the cast rather than its
result. At `XP_PER_CAST` it is four presses of a light to the first point of
Arcane, and it is deliberately half what a *single point of damage* is worth: a
way into the mastery rather than a way up it.

A flame you conjured pays you when it burns somebody, and that thread is the
longest in the feature: the placement carries `castBy` — a **new** field, never
`owner`, which already means "whose body is this" and is what finds a
connection's actor — the tile puts a status on whoever steps in it, the
`StatusInstance` carries `causedBy`, and the tick spends that memory. A status
with no cause behaves exactly as it did before any of this existed, which is the
property to protect.

### The interface is absent for almost everybody

One button per non-pressed stone, above the direction pad on a phone and in the
side column on a desktop, in square order, showing the stone's own sprite and a
bar counting its cooldown down. **The row is absent entirely for a body carrying
no stones** — not empty, absent — which is the whole reason casting could be
added to a layout already carrying a mode strip, an interaction list, a chat bar
and a pad. An automatic charm gets no button, because there is nothing to press.

Casting is server-authoritative with no prediction, exactly as attacking is: the
client sends "cast the stone in this square" — a square, never an instance id —
and dims from the kit it is sent back.

### A content save reaches the world it describes

`GameServer.load` reads the tile and status catalogues **once per world** — it
is guarded on there being no session — so for a long time saving a tile changed
what the *next* world would be built from and nothing about the one the author
was standing in. Saving a *map* never had the problem, because it goes through
`replaceWorld`, which re-reads both catalogues on its way past.

It was invisible until an authored number that a player *watches* changed. An
arcane stone's cooldown is the first of those: the server went on spending the
old one while a reloaded browser drew the bar against the new one, so it sat
pinned at full and read as frozen rather than merely stale.

So `POST /api/tiles` and `POST /api/statuses` now call `reloadContent`, which
is **an eviction on purpose**: checkpoint, drop the session, load again. That is
exactly what hibernation already does to this object, and everybody's position,
kit, tags, experience, statuses and hit points survive a wake because a great
deal of care was taken to make them — `restoreActors` at the end of `load`
re-seats every socket that is still open, and nothing here has to know that list
exists.

It is deliberately **not** `replaceWorld`, which is about a new *board*: that
one deletes the checkpoint, re-derives the spawn registry and drops every
pending respawn, none of which a content save has any business doing. And not
`resetWorld`, which is destructive by design.

Unlike a wake, it **does** send everybody a `hello`. A wake resumes the same
board against the same catalogue, so a client's copy is still true; here the
tiles have changed meaning and the new session re-settled the board on its way
up, so without one every client would go on drawing a world the server had
moved on from. What a `hello` cannot fix is the client's own catalogue, which
reaches a browser only at page load — an author still reloads to see new art,
and no longer reloads to make the world obey them.

## Balancing happens in the Arena, not in the world

`/arena` is a fight with the world taken out of it: two bodies, a cell apart, on
one floor, facing each other, both in reach, with nothing between them and
nowhere to run. Everything a world contributes — terrain, a brain deciding to
back off, whether somebody was standing on a crate — is left out on purpose,
because none of it is balance and all of it is noise in the measurement. Before
this existed, "is the axe worth drawing" was answered by walking somewhere and
hitting something, which folds the answer together with all three.

**Three modules, and the split between them is the design.**

- **`app/game/duel.ts` runs the fight**, on `GameSession`'s own tick order —
  statuses, then cooldowns, then swings, with both sides starting ready so the
  faster one lands first. It reaches for no dice of its own and re-derives no
  curve: a swing costs what `rollAttack` costs and nothing more.
- **`app/game/combatMetrics.ts` works the odds out**, in closed form. Exact
  rather than sampled, and that is the whole point of it: a balance figure with
  sampling noise in it is one nobody can tune against — move a weapon's accuracy
  by a point, watch the number move by three, and you cannot tell which of the
  two was you.

**No rule of a fight is written down twice.** The obvious way to write a closed
form is to work the arithmetic out on paper and type the result in, and it is a
trap with a long fuse: the day somebody changes how accuracy works, the fight
changes and the table quietly does not — and the table is what they are changing
it *against*. So `combat.ts` names each rule once — `landChance`,
`dodgeChance`, `potentialDamageFrom`, `damageAfterDefence`, `attackIntervalMs` —
`rollAttack` rolls against them and `combatMetrics` reports on them. Where the
closed form needs something the functions do not hand over — *where* in the draw
one whole number of damage becomes the next — it **bisects `potentialDamageFrom`
to find out** rather than inverting the band on paper. A curve changed in
`combat.ts` moves the Arena's table on the next render.

Two things are still assumed, and **both are facts about the dice rather than
about combat**: the draws are independent uniforms, and the damage band's two
draws enter only through their mean — which is what makes the triangular measure
right and `[t, t]` a faithful probe. Both are asserted in
`combatMetrics.test.ts`, against `Rng` and against `damageFraction` itself, so a
band rolled some other way fails loudly instead of drifting. `combat.test.ts`'s
draw-count assertions are the other half of that net: a *new* roll in a swing —
a block, a crit — changes what a swing costs the dice and fails there first.
- **`app/game/arena.ts` assembles a body**, and `app/routes/arena.tsx` draws it.

**There is one duel loop, and `duel.test.ts` uses it.** That file used to hold a
private one, and an assertion about whether the numbers add up to a game is
worth nothing if the fight it ran was an approximation of the one the world
runs. Extracting it left every seeded assertion in that file green, which is the
evidence the two were the same fight.

**Statuses are off unless a catalogue is passed**, and that is a setting rather
than an oversight. An inflicted status costs a draw, so handing `Duel` a
catalogue moves the dice for everything after it — which is why `duel.test.ts`
passes none and gets the stream it always had, and why a caller comparing two
damage curves can take the venom out of the comparison.

**Masteries and equipment are overridable; a natural weapon is not.** The first
two are things the world can produce — a mastery is earned, a weapon is picked
up — so a fight tuned around either is a fight that can happen. A natural weapon
is what the creature *is*: it is the axis that stops every animal being a bigger
or smaller version of the same one, and editing it in a tuning tool would be
authoring a creature with nowhere to save it. It is shown in full, read-only,
naming `/tiles` as where it changes.

Picking a different creature loads **that creature's masteries** and keeps
whatever is in its hands. Those are the two halves of what the page is for: a
body is what it is good at, and a weapon is a thing anybody can pick up, so
"what is this axe worth to a wolf rather than a rat" has to survive swapping the
wolf for the rat.

**"Block" is not a mechanic and the table does not pretend otherwise.** Defence
is a flat subtraction from a blow that has already landed, so what reads as a
block is a blow whose whole worth the armour ate. That is reported as
**Absorbed** — how often — beside **Mitigated** — how much. Both, because a
defence that swallows a third of the blows outright and one that shaves a third
off each of them are very different fights and can produce the same mean.

The seed is on the page for the reason it is in the world: a fight somebody
watched and wants to ask about has to be the same fight when they run it again.

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

## A gate must say what it is, and the rest can be prose

**A figure a player can read is a figure a player will optimise against**, and
this game is played by picking things up and finding out. So the default is that
player-facing surfaces *describe* and the arithmetic stays where it decides
things. That default has exactly one class of exception, and weapon requirements
are it.

### The sentence, and why it was wrong

Requirements went through three shapes. First a panel under the hand slot
listing every mastery against the one you had — "Blade 3 / 5", the worst in red —
which was a spreadsheet. Then one sentence you got by *inspecting* the weapon:
"You can confidently wield it", "You can mostly wield it", "You can barely wield
it". The argument was that a number tells you exactly how far short you are,
which is a thing to compute against, where a sentence tells you that you are
short, which is a thing to go and do something about.

**The sentence is gone, and the argument was wrong about which fact it was
withholding.** A player holding a sword that does nothing does not need to be
told they are short — the sword doing nothing already told them. What they need
is *which mastery* and *by how much*, and no amount of atmosphere carries that.
Worse, the rule underneath stopped being guessable: requirements pool across
every mastery a weapon asks for, and what you get out of one is the **cube** of
what you brought — so four fifths of the way there is barely half the weapon.
Nobody infers that from "you can mostly wield it", and a player who cannot infer
it reads a working gate as a broken sword.

Roleplay is a good reason to be vague about a story and a bad one to be vague
about a gate. `app/lib/weaponDemand.ts` now states it: every requirement, your
level against it, and the share of the weapon that comes to.

Two of the three rules the sentence was built on survive it, and they apply to
the next one of these as much as to this one:

- **Derived in one place and read in every surface.** `weaponDemandFor` is what
  the world's look label and a slot in a panel both call, so the sword on the
  floor and the sword in your bag cannot come to say different things about the
  same hands. A second copy is how a panel and a label end up disagreeing in
  front of a player.
- **Silence is an answer.** A weapon that asks nothing says nothing, because an
  unrequirement is a fact about the weapon rather than about you — and it is
  every natural weapon in the world. A line reading "100%" where there was never
  a question is noise on every fist in the game.

The third rule was that bands are counted in the design's own constants rather
than in fractions, and it went with the bands: there are no bands left to place.
`MASTERY_BRIDGE` went with them, having no consumer once the phrasing did.

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

### A notice is a sentence with nowhere else to go

The bottom of the view carries at most two lines of white text — "Your blade
mastery is now 10", "You open Quest Chest and receive 1 Hand Lantern, 1 Rusty
Sword" — and they are prose for a fact
that has no picture. Three kinds qualify. Something crossed a threshold you were
not watching, so the mastery bars mattered for one frame while you were looking
at a rat. Something happened that the board deliberately does not show — a reward
leaves the chest full and the map untouched, so the only evidence is a line item
in a bag you may not have open. Or something you asked for did not happen — "You
cannot fit there", "Your inventory is full" — and a refusal that shows as
*nothing occurring* is indistinguishable from the input being dropped. Everything
else already has a better telling: a blow is a number off a head, a status is an
icon in the strip. Reach for a notice when there is no picture, not when a
picture would be work.

There are no levels in this game, so a notice must not name one: "Your blade
mastery is now 10", never "level 10". @see `app/lib/mastery.ts`.

These are load-bearing:

- **It is drawn by the render loop, not by React.** There is nothing to do to a
  notice — it cannot be dismissed, focused or replied to — so it has no role, no
  live region, no state and no unmount timer. It is an element in the world text
  layer (`app/render/notifications.ts`), positioned against the bottom edge of
  the square rather than against a cell, and the page has no idea it exists. Text
  over this canvas is DOM for the reason `app/render/textLabels.ts` gives at
  length; a notice is in that layer for the font, the brick and the outline,
  which are declared there and nowhere else. One brick of outline, not speech's
  two: the heavy weight buys a background for text landing over unpredictable
  art, and a notice always lands in the same quiet corner of the frame.
- **Two, capped, newest at the bottom.** A third arriving evicts the oldest on
  the spot rather than queueing behind it: a notice describes a moment, and a
  line held back until a slot frees up is read against whatever the player is
  doing by then. A repeat of the line already showing refreshes its timer instead
  of stacking a duplicate, which is what keeps a mashed key from filling both
  slots with one sentence.
- **One source, and the client infers nothing.** Every sentence is composed
  where the thing it describes happened — a reward as it is handed over, a
  mastery inside `grantExperience` as the experience that crossed it is written —
  queued against the body it happened to, and drained through
  `PlaySession.drainNotices`: the session's own queue in single-player, the
  addressed `notice` message online. A renderer draws; it does not work out what
  occurred.

  The mastery line was briefly a **diff** the client took across successive
  `masteryXp` blocks, because at the time nothing on the wire announced a
  crossing. That stopped being true the moment rewards needed a channel, and the
  diff was strictly the worse half: reconstructing an event from state meant the
  renderer held a private copy of the last block, gated on `hasExperience` so the
  empty block held before `hello` was not read as a lifetime of level-ups, and
  had to be careful that a re-registered listener did not replay them. All of it
  to guess at something the session knew exactly. **When a channel already
  carries events, do not add a second mechanism that infers them.**
- **`notice` is the one fire-and-forget message on the wire.** Everything else
  addressed to a socket carries whole state precisely so a dropped message
  self-corrects on the next one. This carries an event, and a lost line is a line
  nobody reads — the right trade for a sentence that is stale four seconds later,
  but the reason nothing may ever depend on a notice having arrived. What the
  reward actually *did* is confirmed by the `tags` and `equipment` messages
  beside it, which are whole.
- **Only earning speaks, and that silence is structural.** A body is *seeded*
  with the masteries its tile was authored with, and seeding does not go through
  `grantExperience` — so a new player is greeted with nothing, without a gate
  anywhere having to suppress it. This is the whole reason composing at the
  source beat the diff: the old client-side version had to be *told* to be quiet
  about a block it had no way to recognise.
- **The sentence is composed in one place, from what the author wrote.** A
  reward's verb is its `actionName` ("Open"), lowercased into the line, so the
  row you pressed and the line that follows it cannot describe two gestures; the
  giver and the items are named by `TileDef.name`; and items are grouped by tile,
  because a reward is a recipe and "1 Bread, 1 Bread, 1 Bread" reads as a
  rendering fault.

## A command is typed where speech goes, and never said out loud

A line beginning with `/` is an instruction rather than something to say.
`app/game/commands.ts` owns that one rule and the grammar behind it,
`GameSession.runCommand` is the only place it changes anything, and
`app/game/notices.ts` turns every refusal into the sentence the player reads.
Today there are two — `/mastery <mastery> <level> [player id]`, which sets a
mastery on yourself or on anybody whose id you can name, and
`/tile <tile> [x] [y] [z]`, which calls any tile in the catalogue into the
world.

- **Nobody is checked.** Any connected player may set any mastery on anybody and
  put anything anywhere. That is deliberate and temporary: it is a world with no
  accounts and no administrators yet, so a permissions model would be guessing
  at a shape that does not exist. When it does, the gate goes in `runCommand`,
  ahead of the work and after the parse — which is the reason a command is a
  *request* before anything acts on it.
- **The slash is sorted on the client**, in `RemoteSession.say`, which sends a
  `command` frame instead of a `say` one. Deciding it at the point of broadcast
  instead would put a rule about what a player *meant* in the middle of the
  fan-out, and a bug there is a private line read out to the room.
- **A refusal is the whole feature.** A command is typed blind — no menu offers
  it and no row lights up to say it would work — so a mistyped mastery that
  simply does nothing is indistinguishable from a broken server. Every failure
  says which word it could not read, and names it back. @see the notice notes
  above, which this is the sharpest case of.
- **The level is set by writing the experience**, never by storing a level:
  `xpForLevel` is what goes into the block, because `../lib/mastery` derives the
  level from it and a second store of one would be a second answer. The derived
  body is dropped in the same statement, on exactly the terms `grantExperience`
  drops it.
- **A body that does not learn is refused by name.** A creature's masteries are
  authored and there is no runtime block to write to, so `/mastery` on a deer
  says "Deer does not learn" rather than explaining the engine.

### `/tile` puts anything anywhere, on the editor's own terms

- **The sign is the whole of the coordinate grammar.** `3` is the third column
  of the map and `+3` is three columns from where you are standing, per axis and
  independently — so `/tile apple +0 -2 3` is "my column, two rows north, level
  3". An unnamed axis is `+0`, which is what makes `/tile apple +1` mean "one
  east of me, same row, same level" without a second shape for a partly-named
  cell. The cost is that an *absolute* negative cannot be written: column -1 and
  level -1 are reachable only by offset, which is what an admin standing in the
  world types anyway.
- **A cell of your own lands underfoot, not overhead.** Appending to the top of
  your own stack — the obvious reading of "put it here" — balances the thing on
  your head and carries it around the map. Somebody *else's* stack is not
  special-cased: an admin dropping a crate on a rat asked for exactly that.
- **`canPlace` is the editor's fit check, asked here for the editor's reason.**
  A stack that would overflow two levels is not a thing the world can hold, and
  a command that wrote one would leave a cell no renderer or gravity pass agrees
  about. The refusal names the cell back, so the line that failed can be edited
  into the one that works.
- **Summoning a body adopts it on the spot**, rather than leaving it to the
  load-time sweep — the same trade `respawnAt` makes. Placing the tile is the
  whole of putting a creature in the world, and without the runtime it is
  scenery shaped like a deer. Its owner id is the authored one
  (`residentOwnerId`), so a called creature knows the cell it was called into as
  its home; that name is the cell and slot, though, so it can already be taken
  by a body that has since walked off, and a taken name falls back to a unique
  one. Two bodies under one owner is the shape nothing recovers from — `despawn`
  removes a single tile.
- **The `player` tile is the one refusal that is about the file.** A map is
  allowed exactly one, and `requireSinglePlayer` throws rather than choosing, so
  a second one is a world that cannot be opened again.

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

## A transmutation spends what you carry, not what is on the board

`interactions.transmute` turns one carried thing into one or more others — a
flame that cooks `raw-meat` into `cooked-meat`, a rat salesman who takes a
carcass for a coin. It is the reward's near neighbour and the differences are
the interesting part.

- **Wholly on the tile, with no placement half.** A reward splits because what a
  chest gives is which chest it is; what a fire does to meat is a fact about
  fire, and every fire cut from the tile does it. So there is nothing for a slot
  to vary, `resolveTransmute` is the only resolver, and there is no join.
- **The board is not touched, exactly as a reward's is not.** No cell patch, no
  swap, nothing removed — the fire is still a fire for the next person. What
  changes is one kit, which travels as an `equipment` message. `GameSession.transmute`
  therefore does not call `settleBoardNow`: there is nothing to settle.
- **No tag, and that is the whole difference from a reward.** A reward is once
  per player and the tag is what closes it; a fire cooks the second steak too.
  What limits a transmutation is having something to spend, so the recipe simply
  stops being offered when your bag runs out — which is the same "not on offer"
  an emptied chest reads as, arrived at from the other side.
- **A list of recipes, and each is a row.** One tile may cook meat and cook fish
  and trade a pelt. `offeredTransmutations` returns only the ones the player can
  actually run, so a fire you have nothing to cook at offers nothing at all —
  the menu is what you could cook, not what fires can do.
- **The row is named for what is *spent*, not for the tile.** "Cook Raw Meat":
  the verb is the recipe's (`Transmutation.verb`, per recipe rather than per
  tile, because one stall may both trade and cook) and the name and sprite are
  the input's. The `ref` stays the transmuter, so the outline still goes round
  the fire. It is the only row in `listInteractionOptions` whose subject is not
  its `ref`, and the only one that needs a third part in its id
  (`transmute:<ref>:<index>`) because one placement offers several.
- **A recipe is addressed by position**, and `ClientMessage.transmute` carries
  that index. The same argument `SlotRef` makes for indices over instance ids:
  both ends hold the same tile catalogue, so a position is something the server
  can check against a list it already has. An index past the end is a refusal in
  `planTransmute`, not a malformed frame — the schema does not hold the
  catalogue.
- **The input is looked for in the hands first, then in the bag.** What you are
  already holding out is what you meant. Never the bag slot itself and never a
  container in a hand: a pack is not a thing you spend, and a row saying "Trade
  Backpack" that destroyed an inventory is the one footgun this refuses outright.
- **What comes back goes where the payment came from, then overflows onto the
  body.** `returnSlots` lists the destinations best first: the slot that paid,
  then the pack, then the free hands (off hand before weapon, on
  `pickUpDestination`'s reasoning). So a one-for-one swap puts the steak in the
  hand that held out the meat and needs no other room at all, and a trade that
  gives back three finds squares for the other two rather than refusing.
- **Nothing ever lands on the floor.** When the body has no room left the recipe
  is simply not offered — `landingsFor` returns null and there is no row. The
  room check and the placement are one question: whether a recipe may run *is*
  whether every result has somewhere to go, so `TransmutePlan.landings` is what
  the check produced and `runTransmute` only mints and files. A run that worked
  it out again could work it out differently from the check that offered the row.
- **Asked against the kit with the input already gone**, which is what makes the
  ordinary case free: the square the payment vacated is the square its result
  lands in. Cooking the last steak in a full pack needs no room, and neither
  does cooking one held in a hand while the pack is full — and that second case
  is not a corner, because a pickup reaches for a hand only once the pack has
  none, so "input in a hand" and "bag full" are the same moment. `slotTakes` is
  `slotAccepts` asked of a tile rather than an instance, because the results do
  not exist until the recipe is allowed to run.
- **`app/game/transmute.ts` holds the rules and never returns a map.** It sits
  outside `./affordances` because it needs a kit, which the board's questions
  deliberately know nothing about — `reachableTransmuteAt` is the board's half
  (reach, cover, the def) and this joins it to the kit. Both ends read it: the
  client to offer the row, the server to validate the message.

## Food piles, and nothing else does

A pile is a `count` on an `ItemInstance` or a `PlacedTile` (`app/lib/piles.ts`).
There is no pile type, no container to open and no second model of a thing: a
pile of twelve berries is one instance with one id, so every rule already written
about carrying, dropping, rotting and looting one berry applies to twelve without
knowing it. Twelve berries on a tile are one placement, not twelve — a stack is
things standing on each other, and nothing in a pile is standing on anything.

**The cost is that the twelve become interchangeable.** They share one id, one
description and one clock, and there is no way to ask which one you ate. That is
the whole reason only food piles: two swords are two swords with two histories,
and a count would be a lie about them. `pileMax` (`app/lib/item.ts`) is the one
place that is decided — a sword answers `1`, so a pile is a count everywhere and
never a special case. The size is authored per tile (`ConsumableItem.pile`,
twelve berries against three loaves) and defaults through `pileOf` rather than
through the schema, on the same grounds `reachOf` does: the tile editor works on
the raw authored block, so a default the schema filled in would be invisible in
the one place somebody is choosing the number.

**A pile arriving somewhere pours into the first pile of its kind with room for
all of it, and otherwise takes a square of its own.** It never splits across two
and never half-lands, because there is no interface for choosing an amount and a
partial move would be the game deciding a number nobody was offered. Fusing is
gated on an *allow-list* of fields — `tileId`, `id`/`itemId`, `count` — so a
field added to either shape later makes two things stop fusing rather than
quietly throwing one copy of it away. A berry somebody has written on is not one
of a heap.

Three verbs meet it, and the split between the first two is the interesting one:

- **Moving takes the whole pile** — `clearSlot`, and every drag, drop and pickup
  through it. This is also the one place in the game a move lands *on* something
  rather than beside it: a hand holding berries will take more berries, which is
  not a swap, because nothing comes back out.
- **Spending takes one** — `peelSlot` (`app/game/itemMoves.ts`), which a meal and
  a recipe's input go through and which falls through to `clearSlot` for the last
  of anything. Everything that is not food only ever reaches the fallback.
- **Landing on a cell pours** — `appendItem` (`app/lib/piles.ts`), which a drop,
  a body dying and a pile falling down a hole all go through, and which
  `runTileCommand` does by hand for the one cell it writes. Those are the only
  ways an item reaches a cell, which is what makes "two berries in one tile" a
  fact about the board rather than about the verb that put them there — `/tile
  berry` onto a berry leaves two berries in that tile, because a command puts a
  thing in the world and once it is there it should be what the world would have
  had if somebody had walked over and put it down. Stamping a tile in the
  *editor* still places rather than pours: that is authoring, and two berries
  authored side by side stay two placements until something lands on them.

### A heap is drawn as a heap, laid out like the pips on a die

`app/render/pileLayout.ts` decides where each sprite of a pile sits inside the
cell they share, and `cellItems` — the single place a placement becomes geometry
— emits one quad per thing rather than one per placement. Three berries look
like three berries; the `×3` beside the name is what carries the number once the
picture stops being countable.

**Nothing about it is random**, despite it looking like jitter. A heap that
re-scattered on every rebuild would shimmer whenever anything else in its cell
changed, and two clients would draw the same pile differently — the map is the
only state and it carries a count, not a seed.

**Two arrangements, and there have to be two.** Up to six it is the die face,
from a table, because a die's faces are not a fill order and cannot be
generated: the centre pip is present at one, gone at two, back at three, gone at
four, back at five and gone at six. Past six there is no face left to copy, so
it becomes the whole-pixel positions inside a small disc, chosen centre-first by
farthest-point — four lines, never picks a pixel twice, and takes any number.

Three things were arrived at by looking at it rather than by reasoning:

- **The pips sit three pixels out, not two.** A tile's sprite is as wide as its
  cell, so pips four apart overlap by half their own width and a four and a five
  come out as the same blob. A face reads only when the pips are small against
  the gaps.
- **The disc's radius grows with the count and stops at four.** It has to grow —
  the offsets are whole pixels, so a fixed disc holds a fixed number of them —
  and it has to stop, or a full pile reads as berries scattered over the three
  tiles around it rather than a heap on one.
- **Twelve sprites at most**, which is the widest authored pile. Counting by eye
  gives out long before that; past six a heap says *how big* rather than how
  many, which is the honest thing for it to say.

**A heap declares a body, however flat the tile it is made of.** Spreading the
sprites means the southern ones hang over the cell in front, and `boxSurface`
rescues art that hangs down-right only for a box with volume — a *flat* tile's
art past its own foot is more floor, and two coplanar floors are what painter
order is for. That is right about a floor and wrong about a heap of berries,
which is an object lying on the ground: without it the bottom of every pile is
drawn under the floor of the cell in front, bitten along the diagonal the plane
bias runs on. `top > foot` is the only way four numbers can say "object, not
floor", so a pile says it with `DEPTH_LEAST_BODY` — half a stack index once ray
depth has weighted it, which is small enough that it can only win a tie and
never overtake something genuinely above it. The height that decides stacking
and gravity is untouched; this is a fact about sorting and it lives in the
renderer.

**A heap is outlined once per sprite, and the rings know about each other.**
Outlining only the quad the placement would have drawn on its own put a ring
around a single berry in the middle of a dozen — often over the gap where no
berry is, since an even face has nothing in its middle. One ring per sprite says
the true thing, but naively it says it far too loudly: a ring is drawn where its
own silhouette *ends*, which around a heap is mostly inside the heap, and a
dozen of them fill it in solid. So each ring is told where its siblings are and
treats them as more of itself, which turns a union of outlines into the outline
of the union. It can be told exactly, and cheaply, because the sprites of a pile
are the *same* art at different offsets: a sibling's alpha at a point is this
sprite's own alpha one offset away. No second texture and no render target — one
extra sample per sibling, on the fragments around the one thing a pointer is
over. The count is also the one fact about *appearance* in the overlay
signature, which otherwise holds none, because eating a berry out of a heap
somebody is pointing at changes how many rings are right.

Two constraints the code has to keep. Offsets are **whole pixels**, because a
merged static quad at a fractional offset samples off the pixel grid forever —
a walker gets to be between pixels because it is going somewhere. And a tile
with a **mesh of its own draws once** whatever its count says: `tileKey` and
`anim` each name one mesh, so a second copy carrying either would collide in
`movableMeshes` or strand an entry in the animated list. Nothing that piles is
animated or mobile, so that is an invariant kept rather than a limit anybody
meets.

Two deliberate gaps. **A recipe's outputs do not pour** — `landingsFor`
(`app/game/transmute.ts`) decides where a result goes by counting *empty*
squares, so pouring in `runTransmute` alone would leave a plan reaching for a
free hand while the pour it knew nothing about freed the square it had given up
on; both halves want changing together. And **a rolled kit's contents do not
pour**, for the same reason one rung further back: what a body is born carrying
is written straight into the bag.

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
  lifetime would be an hour of ticking, and it is the *longest* end of the range
  that sets it. Lifetimes are authored in seconds so that cost is
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

**A pile rots one out of itself at a time**, not all twelve at once — a heap you
cannot leave alone for a minute without losing the lot is a heap nobody would
gather. The clock is the pile's own: one entry, one roll, one berry, and the
pile is armed again the moment its holder is rewritten, so the next one goes off
a fresh lifetime later. What comes off has to land *beside* the pile, through the
same pour a drag goes through — a square in the container, or a slot in the cell
— which adds a fourth refusal to the three above: **a square on a body has no
beside.** It holds one thing, so a pile in a hand waits until it is down to its
last, and that last turns in place exactly as a single berry always did. The peel
that becomes *nothing* needs no room and happens anywhere. A refused peel is put
back rather than left half-done.

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

## A status is drawn twice: on the body, and over the tile

`app/lib/statusVfx.ts` is the vocabulary — a tint and an emitter — and it is a
fourth file rather than more of `app/lib/status.ts` because **the simulation
never reads it**. A status's numbers are the server's business; what it looks
like is not on the wire, is not ticked, and cannot kill anybody. Keeping the two
in separate files is what stops an effect quietly growing a consequence.

Everything below is **client-side and deliberately amnesiac**. Particles are
simulated by whoever is watching, from their own frame clock and their own dice
(`app/render/particles.ts` — the one place in this codebase that does *not* roll
on the world's seeded generator, on purpose: a per-frame per-spark consumer in
front of the simulation's rolls would desync two otherwise identical clients).
Walking off screen and back starts a new plume rather than resuming one. That is
the whole reason it can cost what it costs.

### The tint is a uniform, so only a separately-meshed tile can wear one

`app/render/spriteTint.ts` mixes in OKLab — an even mix looks even, and pulling
the lightness back out (`keepLuma`) leaves the artist's shading intact, which is
what makes the strong case a *palette swap* rather than fog.

It is a **uniform and not a vertex attribute**, because almost nothing is ever
tinted: an attribute would be four floats per vertex of a map-sized buffer to
carry zero. The price is a material per tint, and the consequence worth knowing
before you reach for this: `WorldRenderer.applySpriteTints` can only reach
placements in `movableMeshes`. That is every actor, because a tile that can move
gets its own mesh. **A bush cannot be tinted yet** — it is merged into its
floor's batch, and tinting that material would tint the ground. The status
editor draws its subject as its own mesh, so a bush on fire can be designed
before it can be lit.

### A spark either lights itself or is lit by the room, per emitter

`StatusParticles.lit` decides, and the default is **off** — a spark is usually
its own light source, and dimming a fire's embers with the light of the cellar
it is in gets it backwards. Turn it on for anything that is merely matter:
smoke, gas, the bubbles off a poisoned body. That case is the reason it exists —
a plume that stayed bright in an unlit room is a poisoned enemy you can track
through the dark.

Lighting it costs a per-particle light sample and, more importantly, **puts the
plume in its level's draw group**. The light map is bound per level, so
`ParticleLayer` buckets live particles by level, writes one geometry group per
level and hands the mesh an array of per-level materials. Usually that is one
group: every plume on screen is normally on the storey the player is standing on.

Two traps in that machinery, both of which draw *nothing at all* rather than
degrading:

- **Groups are intersected with `drawRange`, not a replacement for it.** A
  geometry pinned to `setDrawRange(0, 0)` draws nothing however many groups it
  carries. The range stays wide open; the groups bound the draw, and
  `mesh.visible` covers the frame with no particles.
- **A particle samples the light map at its cell's *integer* coordinate.** A
  texel centre sits at the cell coordinate (see `uLightOrigin`), so a fractional
  position lands on a texel boundary and a nearest sample picks a neighbour at
  random. `aLightScale` stays zero — a particle is smaller than the cell lighting
  it, so there is no gradient to walk.

`app/render/particleLayer.test.ts` asserts all of this against the buffers,
because none of it has a visible failure mode short of looking at the screen.

### A status can cast light, and it rides the road a torch already travels

`StatusVfx.light` is a `LightDef` — the same shape a frame's light is — and it
reaches the world as one more entry on the `EmitterOverride` that
`emitterOverridesFor` already paints for every actor every frame. Nothing about
the *static* bake changes: the overlay is add-only, so this is one more light in
a list that is already being walked. Measured at 120fps with a lit burn running,
worst frame inside budget.

The one thing it must never become is a **flicker**. `emitterOverridesKey` has
the lights in it, so a light that changed per frame would miss the overlay cache
every frame and rebake the window. A status light is therefore steady by
construction — there is no phase on it, and there should not be one without
reading the flicker note above first.

### A plume sorts as a two-high tile on top of the affected stack

Not per particle. Every spark of one emitter carries the same depth box, so a
particle that has drifted a cell away still sorts where the fire is. Boxes
derived per particle would have sparks crossing the sprite's own depth as they
rose, and a fire that flickers *behind* the thing on fire reads as a bug.

Opacity is legal here for one reason: particles are blended into the scene
target **before** `app/render/palettePass.ts` quantises, so a half-faded spark is
composited and then snapped, and what lands on the canvas is a solid palette
entry. Fading *after* the quantise — which is what the editor's level fade does —
puts colours on screen that are not in the palette.

### Anything parented to `world` that a map rebuild does not own must be named

`WorldRenderer.rebuildAll` sweeps every child of `this.world`, removes it **and
disposes it**. The exemption list is currently the projectile group and the
particle mesh. Forgetting to add something there does not degrade gracefully: the
geometry is freed underneath a renderer that goes on thinking it is drawing, so
the feature looks like it was never wired up at all. That is exactly how the
particle layer failed on its first run.

### A status winds down, and one scalar does all of it

`StatusVfx.taperMs` is **milliseconds of remaining lifetime**, not a share of the
whole, and that is the point: a poison stacked to ten minutes and one that rolled
ten seconds should both fade over their final few seconds. A fraction would give
the stacked one a two-and-a-half-minute sunset. Zero means never, which is how
every status behaved before this existed.

`taperAt` turns what is left into one scalar, and everything the status draws is
multiplied by it — emission rate, particle size, tint strength, cast-light
intensity. One scalar rather than four because "this is nearly over" is one fact,
and halves that faded at different rates would read as a bug.

Two things about it are load-bearing:

- **It is quantised to `TAPER_STEPS`.** Not smoothing — a bound on two caches. A
  tint is baked into a material keyed by its strength, and a cast light rides a
  cache key with its intensity in it, so a continuously varying taper would
  compile a material a frame. Sixteen steps caps both.
- **A particle keeps the taper it was born under.** Read live, every spark in the
  air would visibly shrink each time the status ticked down. Frozen at birth, the
  plume emits fewer and smaller sparks while the ones already flying finish the
  size they started — which is what a fire dying down looks like.

The figure driving it is smoothed by `app/render/statusTaper.ts`, because online
a status's remaining time arrives about **once a second**: the server compares at
whole-second grain (`statusReading`) and only sends when that changes, which is
right for a countdown badge and far too coarse for a fade. The clock is carried
forward locally between messages and re-anchored by each one. Two rules there,
both tested: compare the snapshot against the **last snapshot** rather than
against the carried value (or it re-anchors every frame and smooths nothing), and
age each clock once per frame however many passes read it — the tint pass and the
light pass both do.

### Other bodies get the status ids, and no countdown

`app/net/protocol.ts` sends statuses to one socket, addressed to that viewer,
and deliberately keeps them out of the tick patch — a patch is diffed and
serialized once for everybody, and folding per-body statuses in would turn one
serialization per tick into one per player. That was written when nothing drew
another body's statuses.

That reasoning holds for `StatusPatch`, which is why it is still per-socket. It
does **not** hold for the ids: `StatusIdsPatch` broadcasts which statuses each
body is under, keyed by actor, and that is the *same bytes for everybody* — one
diff, one serialization, an empty array on almost every tick. It is diffed by
`GameServer.diffStatusIds` on exactly the terms `diffCarriedLights` is, and sent
in full on `hello` so a joiner sees a rat that is already on fire.

**The countdown is deliberately not broadcast.** A remaining time is a
per-second message per body that only a wind-down would read, so every remote
instance is built with `UNKNOWN_REMAINING_MS` (`Infinity`), which falls through
`taperAt` as "not winding down" with no special case. The consequence, stated
plainly: **somebody else's poison burns at full strength until it ends.** Your
own tapers, because your own countdown is on the wire in full. A local
`GameSession` (`/play`, `/arena`) has neither limit — every actor's statuses are
on its snapshots at tick rate.

`diffStatusIds` is not `drainStatusChanges`. That queue is drained to send a
viewer their own countdown; reading it in the broadcast would take the message
out of their mouth.

### Seeing one without earning it

`/status <id|clear> [player]` and `/health <n|+n|-n> [player]` are admin
commands (`app/game/commands.ts`), typed where speech goes. Every real route to
a status is something that happens to you — eating, stepping into a flame, being
bitten — which is right for a game and useless for tuning what one looks like.
Both go through the same functions the world does: `grantStatus` rolls a real
duration, and a negative health shift goes through `applyDamage` so it shows its
number, tells the brains and can kill. Nobody is checked; see the note at the top
of that file.

Worth knowing while tuning: a burn is genuinely lethal at authored values, so
`/mastery toughness 100` and `/health +999` are what keep a body standing long
enough to look at one.

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

## Testing the world

`server/` runs under `bun test` (`bun run test:server`), on the runtime it
deploys to, against a real database file in a temporary directory. `app/` stays
on vitest, which is far faster for plain logic.

The split is the one this repo already had, and for the same reason: **three
bugs in `GameServer` all lived in the load / restore / checkpoint path and were
invisible to a test against a stub** — the world has to be built from a real
checkpoint for any of them to appear. What has changed is only which runtime is
"real". It was workerd because that is where the code ran; it is Bun now, and a
real on-disk database rather than `:memory:` because WAL behaviour and reopening
are exactly what those paths turn on.

Vitest cannot be that runner. It drives tests through worker threads and the
database is a native module that does not survive the trip — a `connect()` that
throws in a second flat under `bun test` hangs indefinitely under vitest.

`server/testHarness.ts` provides what `cloudflare:test` used to. Two things about
it are worth knowing before writing a test:

- **Each test gets its own world**, on its own database file, created in
  `beforeEach`. This was not true of the workerd suite — every test there shared
  one object, one disk and every socket ever opened, and tests had to use a fresh
  actor id per case (`freshPlayer()`) to avoid inheriting the previous one's
  stored state and a phantom connection. That hazard is gone; the `freshPlayer`
  discipline is now belt and braces rather than load-bearing.
- **Frames are queued, not delivered straight to whoever is listening.** A
  browser buffers what arrives until the page next runs, so `await thing(); await
  nextMessage(ws)` works — delivering eagerly would drop the frame before the
  listener existed. A test that wants only what comes *next* says so with
  `record(ws)`, which discards what is pending first.

Two rules learned the hard way, which still hold:

- **Revert one fix at a time when proving a test can fail.** Reverting all three
  at once made two of the three tests pass, because the first revert changed
  behaviour enough to mask the others — `requireSinglePlayer` treats an *owned*
  player tile as the marker, so without the carried spawn point it deleted the
  very body the duplication test was looking for. Three green tests, nothing
  tested.
- **Assert position, not just count.** "Exactly one body" passes whether an actor
  was re-seated on the body they had or handed a fresh one at spawn. Checkpoint
  them away from the spawn cell so the two outcomes differ; that is what caught
  the accept-before-load bug.

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
- **A creature that has bound a target it cannot reach re-proves it every brain
  tick.** A route search that fails costs the full `PATH_MAX_NODES` — about five
  milliseconds on the shipped map, against well under one for a route it finds —
  and brains all tick on the same frame, so a roomful of creatures watching
  somebody through a window pay it together. The authored way out is a `stuck`
  transition, which every shipped brain has; the structural one would be
  remembering the failure for a few ticks, which is the only piece of route
  state worth keeping and has not been needed yet.
- **The editor is a second, unchunked lighting path** and will hit the same wall
  the play renderer already climbed.
