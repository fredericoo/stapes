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
- **Two browser tabs share a cookie**, so they are the same actor, and opening
  the second closes the first — see "One connection per actor". To play two
  characters, use `localhost` in one and `127.0.0.1` in the other.

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

## A field the phone focuses has to be 16px

Safari on iOS zooms the page in when it focuses a text field whose font is
smaller than 16px, and `app/root.tsx` sets `width=device-width, initial-scale=1`
with no maximum and no `user-scalable=no` — so the page has no way back out. A
player who tapped the talk button was left playing a cropped, off-centre board
for the rest of the session.

The chat field therefore carries `pointer-coarse:text-base` on top of its
`text-sm` (`app/components/ChatBar.tsx`). The variant rather than a breakpoint,
because the phone shape of the interface is chosen on `(pointer: coarse)` and
not on width — see `useCoarsePointer`. **Any new field a finger can reach needs
the same thing.** The shared `app/ui/Input` and `Textarea` are still `text-sm`
and would zoom the same way; they are only used by editor surfaces nobody opens
on a phone, which is the reason and not an argument that the rule is optional.

Adding a maximum scale to the viewport meta would also stop the zoom, and is the
wrong fix: it takes pinch-zoom away from everybody, including anybody who needs
it to read.

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

**A preview builds both halves from the head commit, and is checked for it.**
`preview.yml` used to build its client from `refs/pull/N/merge`, which is what
`actions/checkout` takes on a pull-request event, while Coolify built the server
from the branch head. That only matters when main has moved, and the version is
the thing that notices: a branch cut before a `PROTOCOL_VERSION` bump got a
merge-ref client speaking the new version and a head server speaking the old
one, so the preview served its page and then closed every socket with 4001. It
happened on #119 after #118, and again on #152 after #150. Both halves now come
from the head sha.

**And the workflow asks them afterwards whether they agree.** Health alone could
never catch this — which is why both those previews went green: a world nobody
can enter answers `/api/health` with `ok` like any other. The server is asked
from `/api/session`. The client is asked by following the served page to its
route manifest to the `online-main` chunk and reading the `?v=` it sets, which
is the chain a browser follows, so a client that failed to activate is caught by
the same step.

**The number on the `outdated` message is the only thing that says which side is
behind, and the two want opposite advice.** A tab older than the server is the
usual case — an open tab through a deploy — and reloading fixes it. A tab
*newer* than the server is the preview failure above, and there reloading is a
wait that never ends. So the page compares `serverVersion` against its own
before deciding: only a server that is ahead earns the automatic reload.

Whichever it is, it ends at `app/components/OutdatedScreen.tsx`. Before that
existed the refusal had no picture: the reload guard fired, the page sat behind
`LoadingScreen` saying "Loading…" for ever, and the only thing on screen naming
the problem was the word OUTDATED in a chip beside the clock. **A wait that will
never end has to say so.** The preview check above is what stops us shipping the
mismatch; this is what a player sees on the ones we do not catch.

## One connection per actor

Identity is the actor cookie, so a second tab in the same browser is the same
actor. `GameServer.join` closes every socket the actor already has, with 4002
(`CLOSE_REPLACED`), before it seats the new one. The newest connection wins,
because it is the one somebody just opened or reloaded.

- **The displaced socket's attachment is cleared before it is closed.** Its
  close handler runs later, and until then `getWebSockets` still lists it. With
  no id on it, it stops counting as the actor at once — in the head count, in
  `rebirth`, in `hasSocket` — and its close, when it lands, returns early in
  `dropSocket` instead of despawning an actor who has not gone anywhere. This is
  also what a reload now looks like: the new socket displaces the old one, and
  the old one's late close does nothing.
- **The displaced tab must not reconnect.** Every other close sends the page
  into its backoff loop, and two tabs that each reconnect would take the actor
  from each other on every retry. On 4002 the page tears down and shows
  `app/components/ReplacedScreen.tsx`, whose button reloads — which closes the
  other tab, on purpose.
- **`PROTOCOL_VERSION` went to 9 for this, though no message changed.** A bundle
  from before 4002 existed treats it as an ordinary close and reconnects, which
  is the loop above. The bump reloads every open tab onto a bundle that knows
  the code.

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
- **A walk reserves its destination, as strongly as its arrival would.** A step
  only commits to the map when it lands, so for its whole duration the
  destination still reads as empty to everyone else — two actors pressing the
  same direction on the same tick both passed `canWalk` and both arrived, inside
  one another. `destinationTaken` closes that. The map cannot answer the
  question, because the answer is not in the map yet. Since people may share a
  cell, a person reserves it against creatures and against nobody else: a
  reservation stronger than the arrival it stands in for would put cell-sharing
  back in force for one step in every two. See "A body is not terrain".

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

## A body is not terrain

Blocking used to be an accident rather than a rule. Actors are placements in the
stack, `player` is exactly `HEIGHT_PER_LEVEL` tall, and every sum in `mapData`
added it up with the walls — so a person standing still was a wall, and the only
thing that had ever said so was arithmetic. One player at the top of a ladder was
a lid on it, and logging in on top of a friend bounced you to the next cell.

The rule now has two halves and they are in two places:

- **A body has no volume, and that is unconditional.** `isPlayerBody` — the
  `player` tile *with an owner*, so an author's spawn marker still stands up in
  the editor — is skipped by `stackHeight`, `elevationAt`, `walkableElevInStack`,
  `walkableTileAtElev` and `solidTopOfStack`. Nothing stands on a person, nothing
  measures its feet against one, nothing lands on one. This is the half that had
  to be unconditional: a second body in a cell whose volume still counted would
  be drawn a level up, would think the first was holding it, and would plan its
  next step from an elevation nobody is at. Patching the two places the ask
  started from — a login and a portal — would have left all three of those.
- **Who may enter is asked once, in `validation`.** `FitOpts.throughPlayers`
  turns the body check in `fitsTile` and `fitsHeightAtElevation` off, and exactly
  three callers pass it: `canWalk` when the walker is the `player` tile,
  `findEntryCell`, and `teleportFits` when the traveller is. So a person walks
  through a person; a creature, a shoved crate, a thrown item and the editor's
  brush are stopped by a body exactly as they always were.

**Creatures stay opaque, both ways, and that is a decision.** A wolf you can walk
through is not a threat and a corridor nobody can hold is not a corridor — body-
blocking is a tactic worth keeping, and this is the rule Tibia arrived at too.
It is why the flag is a fact about the *pair* rather than a property of the tile:
"can be walked through" is not true of a body, only of a body *by a person*.

**One measurement still counts a body, and it is `canReplaceStack`.** Everywhere
else the question is what somebody may walk into, and there a body weighs
nothing. There the question is what a tile may *become* underneath whoever is
already standing on it — a door swinging shut in an occupied doorway, a plate
whose pressed form is taller than its resting one — and a weightless body would
let both close through the person in them. Closing a door on somebody is refused,
and it is refused for two people as firmly as for one.

They do not stack on each other there either, which is the half the crowd made
necessary: two people in a doorway are side by side, not shoulder-on-head, and
summing them puts four units of person in a two-unit level. That refused every
plate, signal and decay in the cell for as long as two people stood in it — a
pressure plate you could jam by standing on it with a friend. Only the tallest
body counts, and it counts from the scenery under it.

**What pays for the crowd is `guardShare`, not the floor plan.** Standing in one
cell used to be impossible, so nothing had to price it; now eight people can
share a doorway. They are already paid for — see "Eight rats used to be one rat,
eight times" — because being outnumbered scales a defender's guard down whether
the crowd is beside you or on top of you.

**Two bodies in one cell draw one over the other**, in stack order, with no
offset. That is what Tibia does and it reads correctly: the pile is legible as a
pile, and separating them would put a body somewhere it is not.

**Every elevation walk goes through `terrainHeight`, and that is not tidiness.**
"Sum the physical heights up a stack" was written out by hand in five places —
`stackHeight`, `elevationAt`, `walkableElevInStack`, `walkableTileAtElev`, and
`WorldRenderer.cellItems`. The first four were taught to skip a body and the
fifth was not, so the simulation had two people standing on one floor while the
renderer drew the second one's feet on the first one's head. Nothing caught it:
every test asserted against the four that agreed. `terrainHeight` is one
placement's contribution and it is the only definition; the loops are sums of it.
A rule spelled out five times is a rule that is only ever four-fifths true.
`EditorRenderer` has three more of those loops and they go through it too — the
editor reads `map.json` and never sees an owned body, so it is consistency
rather than a fix, which is the point.

## A dialog is a script, and the brain only asks whether anybody is talking

`interactions.dialog` (`app/lib/dialog.ts`, run by `app/game/dialogRuntime.ts`)
is how an NPC holds a conversation: an ordered list of commands, the way an
RPG Maker event is — `say` a line, `anchor` a label, `goto` one, offer
`choices`, `request_trade`, `add_status`, `remove_status`, `tag`. A choice
holds the commands each button leads to; a trade holds what happens when it
goes through and when it is cancelled. The interpreter runs one list at a
time from a counter, descends into a branch on the player's press, continues
after the block when the branch runs out, and stops when the root does.

**Why a script, and not a tree of buttons.** The first cut was a tree —
every button with its own condition, reply and effects — and it could say
one thing per press and nothing between presses. A script says as much as it
likes, in any order, and a new kind of command is one more arm rather than a
new field on every option. `if` is the arm coming next; the interpreter
already treats every nested list the same, so it will be a block like
`choices` is. And before the tree there were typed keywords, which did not
survive a phone: what an NPC can be asked is what is on the buttons, and chat
is for people.

**What the player sees is a transcript.** Every `say`, every button pressed
(in the button's own words) and every trade that happened stays on the
panel, and the only controls are the ones the command the script is waiting
on needs. Running off the end, or a branch with no `goto` back, leaves the
transcript up and the close button as the only thing left — the script
stopped, and the panel says so by offering nothing.

**A conversation is the player's, not the NPC's.** `ActorRuntime.conversation`
— `{ npcId, tileId, pc, transcript }` — lives on whoever pressed Talk, so any
number of people can be running one salesman's script and none sees the
others' panels. The NPC knows only whether anybody is (`anyoneTalkingTo`),
which is the brain condition `talking`. Not checkpointed, on brain memory's
terms: a conversation is a state of play.

- **`pc` is a `CommandPath`**: indices alternating a command's position with
  which branch to descend, `[2, 0, 1]` being the second command inside the
  first branch of the third. One shape for the interpreter's counter, the
  editor's cursor and a drag's destination, so none can disagree about what a
  position means. A list running out pops to the command that held it and
  continues after it.
- **`goto` lands anywhere.** The anchor is found across the whole script and
  the counter jumps to just past it, unwinding out of any branch — which is
  how a branch comes back to its menu. A `goto` naming no anchor is carried
  past, and the lint names it. A loop with no wait between its anchor and its
  `goto` would run forever; `MAX_STEPS_PER_PRESS` stops it, which reads as
  the script ending, and the author finds out the moment they try it.
- **A tap on the NPC is the Talk row.** The renderer's body pick
  (`pickBodyAt`) accepts a dialog as well as hit points. It used to accept
  battlers only, and `dialog` is not one of `interactionKinds`, so the object
  pick passed over a salesman too: a tap walked towards him, and Talk could
  only be pressed from the list.
- **The script is never on the wire.** The server sends the whole
  `Conversation` to the one socket it is about (`flushConversations`, shaped
  like `flushTags`) and null to close; the client reads the waiting command
  off the counter against the tile catalogue it already holds. `talk` is one
  message with a verb inside — open, choose, trade, cancel, close — because
  the five are one thing.
- **A trade is previewed where the kit is.** `request_trade` waits with a
  preview: sprite and count per side per unit, a quantity between `min` and
  `max`, and warnings from the client's own `carriedCount` and `planTrade`
  against the viewer's real kit — the same calls the server makes, so a
  greyed Trade button here is a refusal there, a round trip early. The server
  re-runs the plan on Trade and, in the race where it refuses, notes it in
  the transcript and keeps waiting.
- **Effects that cannot be are skipped, not fatal.** A status nobody
  authored is a command that did nothing; the line the author wrote after it
  is still worth saying.
- **Talk has its own reach.** `canTalkFrom`: line of sight, always; 3.5 cells
  of plan distance, wider than an arm because a counter between you is the
  ordinary case; and elevation within 3 height units — three quarters of a
  level, measured in elevation rather than levels because a stall on a step
  is the case and a balcony is not. Re-asked by `tickConversations` every
  simulation tick, so walking off closes the panel silently the tick you
  have left.
- **The panel takes the reach list's place**, on desktop and on a phone
  alike: a conversation is what is in reach, said longer. It gets the
  identity-gated push the kit gets (`pushConversation`), so `/play` and
  `/online` both have it.
- **Passed through the tile save untouched**, like the brain and for the same
  reason: the script is `./dialog`'s to know.

### A trade is `app/game/trade.ts`, and it is deliberately not a transmute

Several things on each side, counted, because a price is a number and a
number is what a pile already is: fourteen shards may be one pile or three
and `takeUnits` peels across them. Every square a body has — hands, the worn
bag, *and bags held in a hand*, which `carriedSlotOf` deliberately skips for
a recipe: offering what you carry is a different act from asking to be paid.
Gives land worn-bag → hand-held bags → off hand → weapon hand, pouring onto
piles first. **The plan is the kit**: there is no separate run, because
finding room for every last thing is the check and having found it there is
nothing left to decide. All or nothing, and nothing ever reaches the floor. A
container is never on either side: the schema refuses it with a catalogue in
hand, and the runtime refuses it without one.

**A trade has one side that is a kit, and the other side is nowhere.**
`GameSession.attemptDialogEffects` resolves the *player* and runs `planTrade`
against their equipment alone; the NPC is never asked, and its id is not even
passed in. So what a trade takes is destroyed and what it gives is minted on
the spot with a fresh `mintItemId`. A shop has infinite stock and infinite
money, and **a shopkeeper needs no kit at all** — the blacksmith and the
armourer are props with no `battler` block, so they have nowhere to keep one,
and they sell every rung of every rack regardless.

That is worth writing down because the opposite is the obvious guess, and it is
the guess an author would act on: authoring a shopkeeper carrying one of
everything it sells would do nothing except roll a kit nothing reads. If stock
is ever wanted, it is a feature to build and not a field to fill in.

### A shop with a catalogue is a menu of menus, and two limits shape it

Two shops are authored this way: the blacksmith (`blacksmith`), who sells
three rungs of each of four weapon families plus a rack of shields, and the
armourer (`armourer`), who sells every piece of armour there is. The shape
they settled on is worth knowing before authoring the next one, because two
authored ceilings decide it.

- **A price cannot exceed `MAX_DIALOG_AMOUNT`, which is ninety-nine.** That
  bound is on a `TradeSide.count`, so the whole of what one trade takes per
  unit is capped at it. Ninety-five shards is therefore the most expensive
  thing anybody can sell for shards in one side, and the ladder is 20 / 50 /
  95 rather than something that doubles indefinitely. Spelling a higher price
  as two sides of the same tile would work and would read as two prices in
  the preview, which is worse than a cheaper top rung.
- **A family per button, a rung per button under it, is exactly as deep as
  `MAX_DIALOG_DEPTH` allows.** The nesting runs choices → choices →
  `request_trade` → its `traded` branch, which is three blocks — the last
  depth `validateDialog` does not warn about. A fourth level of menu would
  warn, so a shop that grows a fifth family adds a button rather than a
  drawer.
- **Every rung's `traded` and `cancel` go back to their own rack's anchor**,
  not to the top menu: somebody who has just bought a sword is more likely to
  want the next sword than the bow list. Each rack carries a last button,
  Back, whose only job is the `goto main` the branches deliberately do not do.
- **A rack is only limited in depth, never in width.** `choices` takes as many
  options as an author writes, which is what lets the armourer put all eight
  body armours on one menu rather than inventing a sub-menu they do not need.

The weapons are ordinary `item` blocks — see `app/lib/item.ts` — and the
ladder is a requirement ladder rather than a damage one: roughly 6, 20 and 34
in the family's mastery, which is what `OUTGROWN_FALLOFF` wants, since
standing still on one rung stops teaching you long before the next one is out
of reach.

**Armour is racked by slot rather than by rung, and that follows from armour
not being a ladder.** Defence is a flat subtraction and a resistance answers
one mastery, so steel plate is not simply better than a warded robe — see
*Armour is worn, and it may care what hit it* above. What a rack has to do is
therefore put the pieces that compete for one square next to each other, so
the armourer's menus are Body, Head, Feet and Charms, priced off what each
piece actually does rather than off a rung.

**A shopkeeper is a `prop`, not a `battler`, and that is load-bearing.**
`resolveActor` is satisfied by a `dialog` alone, so a body that only talks is
adopted, driven and reachable exactly like one that fights. Being a battler
would give it hit points, and hit points are killable: a world where somebody
has punched the blacksmith to death is a world with no way to buy a weapon,
and nothing respawns him. The potion salesman predates this and is still a
battler, which is the same exposure.

### Authoring a dialog is a list of commands, with the real panel beside it

The Dialog tab (`app/components/DialogEditor.tsx`) is one row per command in
the order the interpreter runs them, a choice's buttons and a trade's two
outcomes indented under the command that holds them. A row is dragged by its
grip to reorder among its neighbours or into any other list on the page —
one `DragDropProvider` over the whole script, each list a dnd-kit sortable
*group* named by its path, and a droppable under every list for "at the end
of this". The one move refused is into a list the row itself holds. Any kind
of command can be added at the end of any list, which is what makes the
thing composable.

- **Every edit is a rewrite by path.** `updateCommandAt`, `insertCommandAt`,
  `removeCommandAt`, `moveCommand` are exported and tested
  (`dialogEditor.test.ts`), on the terms `../lib/conditions` edits an `if`: a
  row is a copy React already rendered, and naming the position is the only
  way a nested one can say which node it means. `moveCommand` removes first
  and re-reads the destination after — an index named against the old script
  lands one off.
- **`ConditionTreeEditor`, `EditorIssues` and `DragHandle` came out of the
  brain editor** so a second authored block could share them rather than grow
  its own; the tree editor waits for the dialog's `if`.
- **The catalog is the picker.** `app/lib/dialogCatalog.ts` mirrors the brain
  catalog — one entry per command kind, with `make` — so the editor cannot
  offer a verb the interpreter lacks. `make` takes what a fresh entry has to
  point at, because unlike "the nearest player" there is no tile every world
  has; the editor hands over the first item and the first status it knows.
- **Try it is the game's panel.** `DialogTryOut` renders `ConversationPanel`
  with the draft passed in over the catalogue's copy, driven by the same
  interpreter the server runs, against a pretend kit the author fills in — a
  real `Equipment` wearing the roomiest bag the catalogue has, so the trade
  preview's warnings are the trade module's own and a full bag is full for
  the same reason it would be online.
- **Save refuses what would load mute.** `validateDialog` with the catalogues
  in hand, on the brain's terms, so a button naming a tile nobody authored is
  caught where it is actionable.

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
against: a tile dropped where you stood leaves headroom for a body three units
tall, which is the whole of why a level is four — see *A level is four height
units, and a body is three*. Everything below
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

**The pointer pick takes the same rule, and did not used to** (`render/pick.ts`,
`candidateIn`). It read the top of each stack and nothing else, so anything you
were standing on was unclickable: a body is a placement like any other, and on a
ladder the topmost slot in that cell is *you*. `interactOver` teleports were the
worst of it — climbing is the one gesture you can only make from on top of the
thing — and they showed as a "Climb up" row the interaction list offered while
the same tile in the world stayed dark and swallowed the tap. The pick now walks
down from the top and stops where `coveredBySomething` says a lid begins, so what
the cursor can reach and what a hand can reach are one rule with one
implementation. Within a stack an *actionable* slot outranks an inert one, which
is what actually gets your feet out of the way: the player tile carries a `push`
block, so it is an interactive candidate wherever it stands — but nobody can
shove themselves, so it has no row, and the rung underneath does.

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
`targetableActors` applies the same two rules the name tags use (`isCellVisible`
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

## A level is four height units, and a body is three

**A level is a ceiling as well as a floor**, and that is the whole of this. An
interior is exactly one storey tall, so a body as tall as a storey has its head
in the floor above the instant anything raises it, and `fitsHeightAtElevation`
refuses to put it there. That is not a bug in the fit check — it is the honest
answer to a body with no headroom. Every chair, stool, table and crate inside
every building in `data/map.json` was unstandable-on for that reason, and a
wolf could get onto the pub chair that the player could not, because a wolf is
half a level and the player was a whole one.

**Two units to a level could not say the fix.** The only height below a full
level was one — half a level, the height of a rat — so "a person is a little
shorter than a storey" was not a sentence the world had the vocabulary for. At
four it is: `player` is 3, and standing on a 1-unit stool puts its head exactly
at the floor above, which `fitsHeightAtElevation` allows because standing on a
surface is not intersecting it.

**The bill is paid in pixels, and it is the constraint to remember when
authoring.** `PX_PER_HEIGHT` is `CELL_SIZE / HEIGHT_PER_LEVEL`, so one unit is
2px. Anything a three-high body stands on *under a roof* has to be a single
unit — 2px of apparent lift. That is the whole indoor furniture vocabulary:
`chair` and `stool` are 1, and `table`, `barrel` and the crates stayed at 2
(half a level) and are deliberately still things you walk around indoors rather
than onto. Outdoors, with nothing overhead, any height climbs as before.

**Nothing stored had to be migrated.** A map holds tile ids and stack order,
never elevations — every height in the world is derived from `data/tiles.json`
at read time — so doubling the authored heights moved the whole board at once
and a checkpoint written before the change reads correctly after it. Saved
player positions are `(x, y, z)`, levels rather than units, and were untouched
for the same reason.

**What derives, and must go on deriving.** `PX_PER_HEIGHT`, `RAY_DEPTH_ELEV`,
`MAX_CLIMB_HEIGHT` (half a level), `CLIMB_HEIGHT_UNITS`, `FALL_MS_PER_HEIGHT`
(from `FALL_MS_PER_LEVEL`, so a storey still falls in 400ms) and
`MELEE_REACH.height` are all written as expressions over `HEIGHT_PER_LEVEL`
rather than as numbers. They were numbers, and every one of them would have
silently halved the thing it measures. If you subdivide a level again, the test
of whether you have finished is that none of these needed touching.

**An intangible tile holds nothing up, and that is the whole of intangibility.**
`physicalHeight` has always read one as 0, so it adds no elevation, but "adds no
elevation" and "is not something to stand on" were two separate facts and only
the first was written down in one place. `solidTopOfStack` knew the second;
`isSupported` and `findLandingAbs` did not, and each had its own `isPlayerBody`
guard that let anything else in the stack count. So a ladder top with nothing
underneath held up whoever climbed onto it, an item lay on an intangible floor
tile instead of dropping through it, and a level filled by a four-unit
intangible read as a landing at its own base. All three are now one predicate —
`../app/lib/mapData`'s `isSolidPlacement`, which the surface search, the support
check and the landing search share. **Every new question about what holds a body
up goes through it**, or it will grow a fourth guard that forgets.

The consequence is an authoring rule, and it is the useful half: **art that you
walk through is never a floor**. A ladder top, a doorway, a patch of water, a
hole you can see down — all of them are scenery hanging in a cell, and if you
want somebody to stand there you put a solid tile in the stack first and the
intangible one on top of it. That is what makes an intangible floor tile
readable as a hole rather than as a floor with a picture of a hole on it, and
`data/map.json`'s ladder tops each grew a `wooden-floor` under them when this
landed.

**Things sharing one space sort by stack order, not by geometry**
(`../app/render/depthClump`). This is the one thing that broke on the way here,
and the fix is worth understanding because the rule is more general than the
bug. An intangible tile with height takes up no *elevation*, so whatever is
stacked on it stands **inside** it rather than on it — a person in an open
doorway, a barrel shoved into one. Two things in the same place cannot be sorted
by geometry, because geometry says they are in the same place: at any pixel in
the band the door alone reaches, the door has a real surface and its co-tenant
has only art hanging outside its own box, which `../lib/geometry`'s `boxSurface`
can rescue with a *tie-break* at best. A tie-break loses outright to a real
surface, so the door was drawn across the face of whoever stood in it, and
across the top of a barrel left in it.

`clumpExtents` merges an overlapping run into one extent, so every member sorts
at the same depth and `depthStackBias` — stack order — settles which is in
front. That is the only honest answer available. **Only what actually
overlaps**: a body standing *on* a crate rests on it rather than in it, so the
two stay separate and sort by height exactly as before.

It surfaced when the player went from a full level to three, but it was never
about the player. A shoved crate in a doorway had it too, and no rule about how
tall a *body* is drawn would ever have reached that.

**A clump sorts, and sorts only.** Anything hanging over a head — a name, a
health bar, a damage number — anchors to the body's *own* height and never to
the clump's, or a person standing in a doorway wears the door's health bar.
`GameRenderer` keeps the two apart as `clumpHeight` and `bodyOwnHeight`; they
were one function once, and the bar drifted two pixels up-left every time
somebody stood in a door.

**A walker joins the clump it is arriving into halfway through the step**
(`steppingClumpHeight`), not when the simulation commits one. Committing is the
honest instant for the board and the wrong one for the picture: a body walking
north into a doorway is drawn over that doorway long before it arrives there, so
a door that only gets out of the way at the end clips the head for most of the
step. The destination's clump does not exist on the board yet, which is what
`clumpExtentOnArrival` is for — the extent the step *will* make, computed
without building the stack it will make.

**What does not scale, and must not be scaled.** A pressure plate's `height` is
a threshold at the boundary between "nothing solid" and "something solid", so
`gte 1` still reads as "something is standing here" and doubling it would have
stopped a stool tripping a plate. `BattlerDef.sight.up`/`down` count **floors**,
not units. Both were left alone on purpose.

**A full-height stack tops out on the floor plane of the level above, and the
level above owns that plane.** Two stacks can claim one elevation: a
`height: 4` tile at level z tops out at exactly `(z + 1) * HEIGHT_PER_LEVEL`,
which is also where a height-0 floor plate at level z+1 sits. That is not an
edge case — it is how every cave in `data/map.json` is roofed, and the tie has
to resolve the same way everywhere or the two answers describe different worlds.
The plate is what a body's feet are on, so the **highest** level that surfaces
at an elevation is the one that answers. `listStandingSurfaces`
(`../app/game/movement.ts`) has always said so; `surfaceTileAt` and
`climbFromSourceAt` (`../app/lib/mapData.ts`) walked levels upward from
`MIN_LEVEL` and answered with the lower one, and now walk downward from
`MAX_LEVEL`.

Answering with the buried tile read the wrong tile's flags. `isWalkableSurfaceAt`
is the landing check, so a `height: 4`, non-walkable `arcane-crystal-1` in a
cave at L-1 made the grassed cell above it unwalkable: a player who fell onto
that meadow was told there was nothing to stand on and dropped through into the
cave. Nothing about the surface cell was wrong, which is why it presented as
scattered holes in a forest tens of cells from anything that looked responsible.
The same tie in `climbFromSourceAt` let a ramp sealed under a floor decide which
way you could climb out of the cell above it.

Two things follow for anything new that reads a column. A full-height tile is
still a floor for the level above when nothing is on top of it — the loop finds
it once the upper levels come up empty, which is what keeps the caves walkable.
And a non-walkable one is not a hole any more, but it is also not a floor: cover
it and the cover answers, leave it bare and it answers itself, correctly, as
something you cannot stand on.

### A placement may say where its own foot is

A stack is a list of things standing on each other, so until now the only
elevation a placement could have was the sum of what was under it. Half-height
floors are what breaks that. A wooden floor two units up is a thing an author
wants directly, and the only way to say it was to bury a two-unit block
underneath — a tile nobody ever sees, chosen for its height rather than for what
it is, that every walk over the column has to step past, and that shows up in
`map.json` as scenery somebody meant to place.

`PlacedTile.foot` is the placement saying where it sits within its level.
Absent on every placement in the world today, and absent is what it should stay
wherever the stack already answers correctly.

**It only ever raises, and that is a property of the shape rather than a rule
the editor keeps.** Every read goes through `footElevation`
(`../app/lib/mapData`), which takes the greater of the authored number and the
elevation underneath. So a stale foot — one written before somebody slid a
taller tile in below it — lifts the placement instead of sinking it into what
now holds it up, and a hand-edited map cannot express a tile buried inside
another one. `fitsFoot` (`../app/lib/validation`) enforces the same floor at the
point of writing, plus a ceiling the read side does not: a lifted placement must
still end inside its own storey. "Raise this floor" is not allowed to become an
overflow into the level above with a gap holding it up.

**The gap it leaves is solid.** That is the whole of the model, not a corner cut:
`stackHeight` counts it, `stackOcclusion` and `stackBlockHeight` count it, and a
raised placement therefore carries the space beneath it upward for walking, for
light and for a look alike. Nothing has to answer what a body standing *under* a
raised floor would be standing on, because there is no under. Solid is not the
same as drawn, though: the projection has no side faces to give a gap, so a lone
tile lifted over open ground reads as floating with a hole beneath it. Lifting is
for a floor with something around it — a wall, a bank, a doorway — and the tile
under the gap is what fills the picture, not the arithmetic. It matters most in
`stackBlockHeight`, which measures where a creature's own eyes are as well as
what is in its way: a rat on a floor raised two units looks out from two units
up, and disregarding the gap would leave it staring at the inside of everything
around it.

**Two rules follow, and both were bugs before they were rules.** The
zero-height tie-break (*A tile with no volume does not own the plane it lies
on*) stops at a raised foot: a flat tile lifted clear of what is under it made
the plane it is on, so it owns it, and `solidTopOfStack` no longer walks down
past it to the bush it was raised over. And **a foot does not travel** —
`landedPlacement` drops it wherever a placement joins a stack it was not
authored into, which is `appendTile` and `moveColumn` between them, so every
walk, fall, shove, drop and spawn. A crate authored two units up and then shoved
one cell east would otherwise go on hovering two units up over whatever it
landed on. Copying a whole cell in the editor deliberately goes through neither:
stamping a column somewhere else is authoring, and the feet are part of what is
being copied.

The lighting bake reads the field too — `occlusionSignature` carries it, because
a foot moves both the elevation every emitter above it sits at and the solid gap
it leaves under it. Leave it out and lifting a floor relights nothing.

### A ramp between two levels needs a hole above it

`ramp` and `stone-stairs` are two units tall, and two units is exactly
`MAX_CLIMB_HEIGHT` — half a level. That is what lets one of them join two levels
at all: a body climbs a whole level in two ordinary steps, floor → ramp → the
floor above, and neither step is a fall or a special case.

**The cell directly over the ramp has to be empty.** A body standing on the ramp
has its feet two units up and its head a unit *into* the level above, so a floor
plate up there is a ceiling and `fitsHeightAtElevation` refuses to put anybody on
the slope — the ramp becomes scenery you cannot stand on, with no error anywhere
to say so. So a ramp from level *z* to *z+1* is three cells, not one:

```
(x, y,   z  )  [dirt, ramp]      facing the way you came from
(x, y,   z+1)  empty             the hole, and the way in from above
(x±1, y, z+1)  [dirt]            what you climb out onto
```

That empty cell is not a defect to be tidied up later. It is the top of the
slope: from the floor above you step into it, land on the ramp two units down —
an ordinary walk, not a drop — and carry on down. The animal den's mouth is the
same three cells with the surface as its upper level, which is why walking off
the road into it feels like walking into a cave rather than like using a door.

**The facing is the opposite of the way you climb.** `climbFrom` on both tiles
reads "from a ramp facing *n*, you may climb north-**wards**… no": variant `n`
permits travel `s`. So a ramp you ascend heading north is placed facing south.
Get it backwards and the ramp is walkable, reachable, and refuses to go up.
`scripts/carve-caves.ts` derives it (`RAMP_FACING`) rather than typing it, and
then proves every ramp it placed by asking `canWalk` to climb one.

### A step never crosses a sealed floor plane

`canWalk` lands a step on any standing surface in the destination column within
`MAX_CLIMB_HEIGHT` of the walker's feet, on whatever level that surface is. The
band alone could not tell a staircase from a ceiling: a lone `half-stone`
(height 2) under a bare floor tops out two units below that floor, which is
exactly a climb, so a body on the block stepped **up through the ground** onto
the grass, and a body on the grass stepped **down through it** onto the block.
Nothing was wrong with either cell. Only the stack next door decided it.

It presented as two unrelated complaints. Two rats sat on the spawn cell killing
whoever stood there: den rats at L-3 climbed onto single half-stones and stepped
up through the L-2 floor, took the real ramps to L-1, and then `homing` took
over — `within` applies the creature's `sight` (`up: 0, down: 0` for a rat), so
a body off its home level is never `in_range home` and always `out_of_range
home`, and it walks to the *plan* position of a burrow three floors down and
stays. Two burrows are under the spawn room. Separately, a snake authored on
the field over the ladder room blinked in and out of L-1 next to the ladder:
a half-stone at (-1,42,-1) sits under grass, and it stepped down onto it and
back up 65 times in twelve simulated minutes. Players could do all of this too.
The reproduction is `scripts/bench-server.ts`'s setup with one idle player at
spawn: 66 deaths in 30 simulated minutes, all to two rats from L-3.

The rule now lives in `surfacesInClimbBand` (`app/game/movement.ts`), which
`canWalk`, the route search's ground check and the brain's `stepLeavesGround`
all read, so the three cannot disagree. A surface is dropped from the band when
reaching it would cross a sealed plane — `stackOcclusion().sealsLevel`, the same
fact that stops light and a look travelling vertically (*A floor is a lid*). A
light-passing tile seals nothing, so a ladder shaft and a pond bottom stay open.

**Which column the vertical travel happens in is the whole of the rule, and it
is asymmetric on purpose.** A step *up* rises in the column being left: that is
what makes a ramp work — the cell over it is empty (*A ramp between two levels
needs a hole above it*), so a body climbs out of the hole onto the floor beside
it, while the same two-unit climb from under a ceiling is refused. A step *down*
drops in the column being entered — into the den mouth, where nothing is
overhead, and not through the field beside it. Measuring the drop in the column
being left would find the very floor the body stands on and refuse every step
off a ledge. Planes strictly above the lower end and up to the higher end count:
the plane a body finishes standing on is arrived at, not crossed.

What this does not touch: `push.ts` still picks a shove's destination from the
raw `listStandingSurfaces`, so a crate can in principle be shoved through a
ceiling the same way. Gravity was never affected — `findLandingAbs` stops at the
highest solid below the feet, so a fall lands on the plate rather than under it.
And a creature already stranded off its home level is not rescued by this; it
only stops any more from joining it.

### The topmost tile decides what a stack is

`walkableElevInStack` reads the top of a stack and nothing under it. Whatever
is on top is what a body would put its feet on, so its `walkable` flag answers
for the whole stack.

Two earlier rules got this wrong in opposite directions, and both are worth
knowing about because both looked correct in isolation.

**Taking the highest walkable top** let a dropped item become the surface. An
apple is `height: 0`, so it tops out at exactly the height of the bush it was
laid on, and the search found the apple. Any hedge, fence or counter-top was
passable to anybody carrying food, with the eight tangible `height: 0` tiles in
`data/tiles.json` — `apple`, `berry`, `bread`, `cheese`, `raw-meat`,
`cooked-meat`, `stale-berry`, `arcane-shard`.

**Sealing every elevation a non-walkable tile topped out at** fixed that and
broke bridges. A deck is a `wooden-floor` over a `fence` over `water`, and the
fence is exactly what holds the deck up at a height a body can climb to from
the bank. A rule that lets anything below the top refuse the cell refuses the
deck too. The three-wide crossing at (32–34, 11–13) in `data/map.json` is built
this way, with `lift` under the middle lane and `fence` under the two edges.

The current rule handles the railings on that crossing for free: the edge
stacks are `water, fence, wooden-floor, fence`, so their top is the railing and
they are closed, while the middle lane's top is the deck and it is open.

**Water is `height: 0` and `walkable: false`, and both matter.** Water over
grass is two `height: 0` tiles, so nothing but stack order says which one is
underfoot — it is the case no rule reading elevations alone can decide, and the
reason the rule reads order instead. Giving water a height of 1 also closed it,
by a different mechanism, and cost more than it fixed: the water stood proud of
its own bank, and a deck built on it sat at 3, which is past `MAX_CLIMB_HEIGHT`
from the bank at 0. Every bridge in the world was unreachable.

**A raised `foot` does not change the answer, and stack order still gives it.**
A foot only ever lifts a placement and a height is never negative, so
`elevationAfter` never falls as the walk goes up the stack: the last solid
placement is also the highest-topped one. The only case where measuring and
reading backwards could differ is a shared plane — a wooden floor laid flat on a
bush tops out exactly where the bush does — and there the tile lying on top is
the one that answers, which is the whole rule. Lifting that same floor clear on
a `foot: 3` moves the surface from 2 to 3 and changes nothing about which tile
owns it.

**Two kinds of placement are skipped rather than treated as the top.** An
intangible tile has no surface, so the search looks through a sword on the
ground or an open door to the tile beneath — `door-open` is the only tile in
the catalogue that is both intangible and `walkable: false`, and a rule that
consulted intangibles would seal every open doorway. A body is somebody
standing in the cell rather than part of it, so a wolf on grass leaves the
grass as the surface; without that skip every occupied cell would report no
surface and nothing could fall onto one. Authored NPCs carry no `owner` until a
runtime adopts them, so the test is `isPlayerBody(placed) || resolveActor(def)`
and not the presence of an owner.

**`solidTopOfStack` has to agree with it.** `canWalk` asks one question through
the climb-band search and the other through its walk-into-a-hole fallthrough,
so a tie-break in one and not the other shows up as a cell one branch closes
and the other opens. That is exactly what happened while the sealing rule was
in place, and it is why the fix has to land in both or neither.

**A plane is closed from above, and by something with no height of its own.**
Water is `height: 0` and `walkable: false`, so a stack of nothing but water adds
nothing to its column and has no walkable elevation to offer — it used to say
nothing at all about the plane it lies in. That was fine over grass, where the
grass is in the same stack and the topmost-tile rule settles it, and wrong the
moment the ground was a *level* rather than a tile: a full walkable level below
claims the plane twice over, once as the top of its own stack and once as the
floor it forms above itself, and both claims went unopposed. A pond laid on a
stone roof was dry ground, and 183 cells of `data/map.json` could be walked
across. `planeCoveredAt` is the rule that closes it: what is lying in a plane is
what a body's feet would be in, whoever else claims that plane. Only a placement
that tops out *on* the plane counts — a wall standing on a floor leaves it a
floor, and what keeps a body out of that cell is the fit check.

### Players do not put things down where nothing can stand

Because the topmost tile decides, a berry dropped on a bush would make the bush
walkable. The rule is enforced where a *player* acts — `dropDestinationAt` in
`app/game/affordances.ts`, and `dropKit` in `GameSession`, which is a body
dying — and deliberately not in `canReplaceStack`, which the editor asks too.
An author stacking a plank on a fence is building a bridge deck, and that is
the same stack shape.

The other ways a thing reaches a cell need nothing: an `extract` yield goes
into the puller's kit rather than onto the board, and `push` picks its
destination from `listStandingSurfaces`, which has no entry for a cell with no
standing surface. A body dies where it was standing, which is walkable by
definition, so the `dropKit` check only fires for a death somewhere a body
arrived by falling — into water, most likely — and it keeps the kit rather than
spilling it.

## A roof over a cave is not what keeps the daylight out of it

Anything underground that is meant to be dark has to be *checked* dark, against
the baker, at noon. Walling it in does not do it, and every one of the reasons
is invisible from the cell that ends up lit.

`isSkyExposed` answers a narrower question than it looks like it does: whether
the shaft straight up is sealed. The flood that follows spreads light sideways
*and vertically* between levels, so a cave is lit by geometry a dozen cells away
and three levels up with nothing wrong overhead. Three ways in, all found by
lighting one:

- **Past the edge of the map.** Outside the surface's own footprint there is no
  content to occlude anything, so the bake's domain margin is open air at every
  depth, seeded at full sky. It spills `MAX_LIGHT_LEVEL` cells inward, which is
  why `carve-caves.ts` keeps that far back from the edge rather than walling
  against it.
- **Any empty column.** A column with nothing in it takes the shaft all the way
  down, and the flood then walks out of its foot into whatever it touches. A
  wall beside a cave does nothing about a gap *over* the cave: the light goes
  round. The fix is a lid — rock in those columns at the topmost cave level,
  which is enough for every level under it, because the shaft stops at the first
  full block and there is then no lit cell underground to spread from.
- **A floor with something standing on it.** A bare floor hard-seals the
  vertical flood edge; the same floor with a bush, a sign or a fence on it is
  half opaque, which disqualifies it, and daylight comes through the ground at
  half strength. Most of the map's surface has something on it. This one is a
  bug rather than a rule — the seal is a property of the floor and the opacity
  is a property of the thing standing on it — and until it is fixed, a cave
  simply does not run under those cells.

The check that catches all three is the last thing `scripts/carve-caves.ts`
does: bake the map it just wrote and assert no carved cell has any sky in it
away from the mouth. Everything above was found by that assertion failing.

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
- **A drop is a one-way edge, and which legs may take one is one setting with
  three values.** `PathOptions.drops` is `"never"` (the default), `"toGoal"` or
  `"anywhere"`; a creature's `allowDrops` maps onto the outer two and reads
  exactly as it always did. Where gravity would put the body down is resolved as
  part of the edge, because a route planned from mid-air is a route about a cell
  nobody is ever standing in. `"toGoal"` is a click's answer and is written
  below.
- **A cell that fires when you land on it is not a way through.** A flame burns
  whoever lands in it and a portal sends them elsewhere, both on the `step`
  trigger with nothing to press, and `unsafeToStepOn` takes both out of
  `neighbours` — so a chase, a flight and a clicked walk all route round them.
  The case that prompted it was a player following a rabbit into a fire: the
  flame was on the short line, so the route took it, and both of them died.
  - *The two halves are avoided for different reasons and it matters.* A
    teleport is always refused, because a route through one is not a route —
    you arrive somewhere the search never considered and the plan is void. A
    status is refused on its `tone` being `bad`, so a route goes round a fire
    and straight over a shrine. Reading the tone is why `findPath` and
    `findRefuge` take the status catalogue **positionally** rather than in
    their options bag: a routing rule that silently stopped applying because a
    call site forgot an optional argument is the failure that shape rules out.
    A status the catalogue has no entry for is not a hazard, on the reading
    `resolveAddStatus` already carries — an id nothing answers to is an effect
    that does not happen — so a caller with no catalogue routes exactly as it
    did before this existed, and a portal is still avoided.
  - *The goal is exempt, and has to be.* A portal is a place you walk into on
    purpose and a click on a flame is a click on a flame, so the cell that is
    itself what was asked for stays an edge — the shape `drops: "toGoal"`
    already has. Only under `arrive: "on"`, because that is the only mode in
    which a caller pointed at a cell to stand in: a creature closing on
    somebody standing next to a fire must not take the fire as its last leg,
    and a flood has no goal at all so nothing is exempt from one.
  - *It costs about 5% of a route somebody walks*, and the stack scan is asked
    only of cells `canWalk` has already accepted. 134µs against 128µs for the
    same eight-step route across `app/lib/fixtureTown.ts` with the rule taken
    out, `bun` on an M2 Pro. Both questions are asked in one pass for that
    reason: a route asks both of every cell it accepts.
  - *What it rules out is a room whose only way in is a flame or a portal* —
    nothing will route into it. Walking in by hand still works; none of this
    touches `canWalk`, and the server validates the same steps it always did.
  - *A random step reads the same rule, and no author opts out of it.*
    `step_random` and `walk_n_steps` pick from `brainRuntime`'s `footing`, which
    now drops a direction the session calls a hazard as well as one that goes
    over a ledge — `GameSession.stepLandsInHazard`, which is `unsafeToStepOn`
    asked of one leg. Without it the same animal was safe while it was hunting
    and burned while it was idling, because which cells it could end up in
    depended on which action moved it. The two refusals have different standing
    and are written that way: `allowDrops` is the author's, because a bat is
    meant to fly off a plinth, while a flame is nobody's. Asked of where the leg
    *lands*, so a creature that may take drops does not fall into a fire at the
    bottom of one; the ledge check goes first because it is the cheaper half.
    It does not show up in a tick: `bun scripts/bench-server.ts --scenario
    spread` reads 0.79ms at p50 with the rule and 0.78–0.85ms across baseline
    runs, which is the noise. A wander pays one `canWalk` per direction it has
    not already refused as a ledge, against the up-to-128 nodes a chase pays.

**Two caps, doing two different jobs, and it is worth not confusing them.**
`PATH_DETOUR_SLACK` is about *behaviour*: a route far longer than the gap is not
a chase, it is a creature that has worked out where the door is. `PATH_MAX_NODES`
is about *cost*, and the numbers either side of it are far apart — routes
anybody actually walks settle in seven to twenty-five cells, while proving a
target unreachable means exhausting every cell a body could stand on. Running
out of either reads as no route at all, deliberately: a half-explored search has
a best-so-far cell it could head for, and walking towards that is exactly how a
creature ends up pressed against the nearest wall having made progress.

**Nothing is kept between two decisions.** A route is recomputed for every leg
rather than followed, because a kept plan is a plan about a world that has
since moved — the target walked on, a crate was shoved into the third step,
another creature filled the fourth. At one search per step the check that a
kept route was still true would cost about what recomputing it does.

**Fleeing used to be greedy, and this section used to argue that it should be.**
The argument was that "away" is a direction rather than a place, so the question
a fleeing animal asks is the local one, and inventing a goal cell to run at
would be the pathfinder deciding where something wants to hide. It is a sound
argument for a worse animal — see "Running away is a flood, not a direction"
below, which is what replaced it and why.

## Clicking walks you there, following walks you after them, and neither travels

`app/game/walkTo.ts` holds an errand — a cell, or a body — and hands the step
pipeline one direction per leg. It is entirely client-side, and deliberately:
`findPath` is a pure question about a board, the browser holds every argument to
it, and the direction it produces goes in through `HeldDirections` — the same
list a held key presses. So a clicked leg is predicted, sent and validated by
exactly the machinery a keypress already used, `canWalk` on the server included.
There is nothing on the wire that says a walk was clicked, and there is no
version of a client making up where it is allowed to go.

- **`findPath` gained `arrive`, and the two halves of it move together.**
  `"beside"` is the default and is what closing on a body means; `"on"` is what
  a cell somebody pointed at means. The mode is read by the goal test *and* by
  the heuristic the queue is ordered on, and the dangerous half is the
  overestimate: measuring to the goal itself while stopping beside it is one
  step too many, which returns routes that are not the shortest and prunes
  legitimate ones against `PATH_DETOUR_SLACK`.
- **A fall may be the last leg of a clicked route, and nothing before it.**
  `WalkTo` passes `drops: "toGoal"`, so a leg that leaves the ground is an edge
  only when the cell gravity resolves it to is the cell that was clicked — asked
  with the same `arrived` the search finishes on, rather than with a second
  opinion about what arriving means. Click into a hole and the walk goes down it; click across a
  balcony and the walk goes round by the stairs. **Not pathing through a hole is
  deliberate, and it is not the next obvious feature.** A leg costs one step
  whether it walks or falls and there is nothing else to pay — this game does
  not hurt you for landing — so a search free to fall anywhere takes the drop
  the moment it is the shorter line, and a click meant to cross a room throws
  the player off the edge of it and leaves them to find the stairs back up.
  Lifting the limit is not a flag: it is deciding what a fall is worth, which
  means costing the climb back out of it, and nothing has measured that yet.
- **A pick names a tile; a body wants the cell it would stand in.** The two
  differ for anything filling its own level — the block a floor is made of is
  stored on the level below the one you stand on it at — so the destination goes
  through `standingCellOn`, which matches the picked tile's top against
  `listStandingSurfaces`. Skip it and the floor of a building is a place nobody
  can click their way into.
- **A tile with no top to stand on is walked *to*, not refused.** A chest, a
  wall, a tree: `standingCellOn` has no answer, and the errand becomes the
  tile's own cell with `arrive: "beside"`. This used to be the refusal, and it
  was the single most annoying thing about click-to-walk — everything worth
  crossing a room for is a thing rather than a place, so the feature was one you
  learnt not to use on anything interesting. **Which neighbour you end up in is
  the search's answer and not a choice made before it.** Picking the nearest
  free cell first and routing to that is the obvious implementation and it is
  wrong twice over: the nearest neighbour of a chest against a wall is often the
  one inside the wall, and even when it is reachable it need not be the one with
  the shortest route. `arrive: "beside"` is already a goal test the queue is
  ordered on, so handing it the object's own cell gets both for free.
- **The leg handed over during a step is the one *after* it**, and that is why
  `findPath` takes where to search from and whose body to ignore as two facts.
  The prediction chains a landed step straight into the next from inside its own
  frame, carrying the overshoot; a controller that waited to see the walk finish
  before naming the next direction would spend a frame standing still at every
  cell, and click-walking would get slower as the frame rate dropped. So the next
  leg is routed from the cell the current one is landing in — while the body is
  still placed in the cell it is leaving, because a walk commits to the map on
  landing. `PathStart` names both; told only one, the search has the walker's own
  body as a wall behind it, and turning round in a one-wide corridor comes back
  as no route at all. The body is taken off the board for the length of the
  search rather than skipped by stack index, since it obstructs cells it is not
  the source of: about 12µs of the 170µs an eight-step route across
  `app/lib/fixtureTown.ts` takes, `bun` on an M2 Pro.
- **The route is recomputed every step and never kept**, which is the chase
  argument above turned up rather than repeated. A walk across town is twenty
  steps where a chase is three, so a kept plan has twenty steps of world to go
  stale in, and other bodies are walls to `canWalk` — the things between here and
  a cell across the square are exactly the things that move.
  - *What that costs is bounded by the frame, not by the step.* The controller
    searches when the body has somewhere new to think from or when the map is a
    different object, and the second half is a weak guard: map identity changes
    on any commit anywhere in the world, so a busy world defeats it every frame
    and a still one never does. The honest bound is one search per frame while a
    walk is under way, each of them the cheap end of what `PATH_MAX_NODES` is
    sized for.
  - *It can end a walk halfway, and only a static board says otherwise.* On a
    board nobody has touched the allowance cannot tighten: `PATH_DETOUR_SLACK`
    permits the plan distance plus a constant, and walking a step of an optimal
    route lowers what is still owed by one while lowering the plan distance by at
    most one. But a moving board is the whole reason the route is not kept. Shut
    the door it went through and every way left may be over the allowance, and
    the walk stops where it stands — silently, because what stops a route halfway
    is ordinary traffic and a sentence for each is a line of text every time
    anybody walks anywhere.
- **A key cancels it, and a click never clears a key**, and neither of them
  knows about the other: `HeldDirections` holds one direction a click is asking
  for beside the list of keys that are down, on the same "latest wins" rule the
  keys already order themselves by. A press drops the clicked direction, so a
  walk taken over stops — the walk finds that out by asking, which is why the
  page wires nothing up. Handing the input back puts the keys into force again
  rather than emptying it, so a key held through a clicked walk still walks when
  the walk ends, and the modifiers ride along either way: a click writing the
  input itself silently dropped shift and alt.
- **Following a body is the same errand with a goal that moves.** `WalkTo` holds
  either a cell or an actor id; the goal is read off it every time a leg is
  owed, so the loop that already re-routes round a shoved crate tracks something
  walking away without a second mechanism. Three things differ from a click and
  nothing else does: it arrives `beside` rather than `on`, arriving lets go of
  the input without ending the errand, and a hand on the keys is *yielded* to
  rather than treated as the end of it.
  - *It cannot use `autoPressed` to tell whether it has been taken over.* A
    follow that has caught up is deliberately pressing nothing, which is the
    same answer as a key having taken the input away. So `HeldDirections` gained
    `pressed` — whether a direction is held by hand — and the follow stands
    aside for exactly as long as one is and takes the input back on release. A
    follow that ended at the first keypress would be unusable: dodging is the
    normal thing to do while chasing something.
  - *A refusal pauses it rather than ending it*, because a body behind a shut
    door may walk back out. That breaks the cost argument above — the expensive
    search is the one that proves a cell unreachable, and it was safe only
    because a refused click drops its destination immediately. `WalkTo.stalled`
    restores the bound: after a refusal the map half of the gate is ignored, so
    the search is asked again only when the follower or the followed has moved.
  - *It ends when the body leaves the view*, on the target's own rule
    (`isWithinView`) and supplied by the renderer through `WalkView.bodyAt`. It
    has to be the same rule the row is offered under, because the row is the only
    way to switch a follow off — so `targetableActors` keeps whoever is being
    followed for the same reason it keeps whoever is being fought.
  - *Nothing about it reaches the wire.* Following is walking, and the
    directions go in where a held key's do. The server sees an ordinary walk it
    validates a step at a time, which is why the state lives on the renderer and
    `applyInteraction` takes a `Follower` beside the session rather than putting
    a verb on `PlaySession`.
- **The refusal is a notice, and it is the one sentence composed on the client.**
  A click has no key to hold and no row to read, so a refused one shows as the
  avatar not moving, which is indistinguishable from having missed the canvas. It
  is drained beside `PlaySession.drainNotices` in the render loop.
  - *It says which limit was hit*, because two of the three are ours rather than
    the board's. `findPath` reports `unreachable` (everywhere reachable was
    searched and offered), `detour` (it ran out of cells having turned some away
    at `PATH_DETOUR_SLACK`, so a long way round may exist) or `budget`
    (`PATH_MAX_NODES` ran out with cells still queued). One null for all three
    told a player looking straight into a room across the square that there was
    no way there.
  - *And it leans towards understating.* Any open board has far corners over the
    detour cap, so a genuinely sealed cell usually comes back as `detour` rather
    than `unreachable`; the sentence for it — "there is no short way there" — is
    true of a long way round and of no way at all. Being wrong the other way
    stops a player who could have walked round the back.

## A step used to wait for a decision, which set the pace of every creature

`step_toward` pressed one direction and returned, so a creature took a step per
brain round. `BRAIN_TICK_MS` is one walk at the standard pace, and the effect of
that pairing was not the cap it looks like — it was a **rounding**, up to a
whole number of rounds, and it caught the slow creatures as well as the fast:

| authored | walked at |
| --- | --- |
| bat 90ms | 200ms |
| wolf 140, rat 150, rabbit 150, deer 170 | 200ms |
| troll 300, snake 320 | 400ms |
| cat 400 | 400ms |

Of everything we ship only the cat, authored at exactly two rounds, ever moved
at the pace its tile says. The bat spent half of every round standing still,
which is what read as a stutter; the snake merely walked a quarter slower than
anybody authoring it believed, which read as nothing at all and is the half of
this that was easy to miss.

**A creature now holds an order rather than taking a step.** `walkTo` writes
down *where* a creature is going and returns whether it is going anywhere;
`GameSession.driveWalkOrder` presses the next leg from the motion loop, every
tick the body comes free. The brain keeps the decision that is actually its own
— whom to follow — and reconsiders it every round, at the cadence it always did.

- **The goal is a body, not a cell, wherever a body was named.** Every selector
  but `home` resolves to somebody, so the order holds the id and re-reads where
  they are on every leg. A wolf follows a player across a courtyard instead of
  walking to where they were standing when it decided.
- **An order lives exactly one round unless it is asked for again.** It is
  dropped at the top of every turn, before any transition or action runs. The
  motion loop cannot know what a creature is thinking, so an order left behind
  by a state the creature has transitioned out of would be walked out in full —
  a body carrying on to somewhere it decided against, with nothing able to
  notice.
- **A dozing creature's order is not pressed between its turns.** The doze
  budget is the only term in a round's cost that the size of the map reaches,
  and pressing legs at the tick rate for every distant body with somewhere to be
  would put that straight back. A creature nobody is near walks exactly as
  slowly as it did.
- **Nothing about holes changed.** A leg is a fresh `findPath` with the same
  `drops` the action carried, so a chase still refuses to leave the ground
  unless its author said otherwise, and both places that press a leg ask `idle`
  first, which a falling body fails.

**It made the tail cheaper, which is not what I expected.** One search per step
rather than one per round is more searches, and the median tick shows it: 0.26ms
to 0.36ms on the town scenario. But the p95 goes from 2.86ms to 2.40ms and the
worst tick from 11.3ms to 6.0ms, because the searches are no longer all due on
the same tick — a brain round used to do everybody's pathfinding at once, and
now the legs in between carry their own. The wire grows 3.5%, 40.2 to 41.6 KB/s,
which is creatures genuinely covering more ground.

**What it cost is a release that is read once a round.** A transition is checked
per round while a body may now take more than one leg in that time, so a
condition that says "stop when you are two cells away" can be overshot by one.
The rats show it: four of them in a yard sit adjacent on 57% of beats where they
used to sit on 47%. Retuning the release does not recover it — at three cells
the pack gets *worse*, because releasing earlier only means re-acquiring sooner
— and the pathology the release actually exists to prevent, the diagonal chain
that shuffles on the spot, halved instead. See `brain.test.ts`, "gathers without
piling up".

## A creature that has left the board must not be given a turn

`tickOneBrain` asked `defFor` before anything else, and `defFor` goes through
`locate`, which throws. An actor outlives its body for as long as it takes
something to notice — killed by a status, or fallen out of the world — and until
then it is still in `actors` and still comes round in the doze budget. So the
next round it got was an exception out of `tick`, which on the server is the
world going down.

It reproduced on `bun run bench:server` against the shipped map, in the town
scenario, within twenty simulated seconds. The bench was simply failing rather
than reporting, which is how it went unnoticed for as long as it did. Asked
through `tryLocate` now, on exactly the terms `buildTileIndex` and `attentive`
have always asked: no body on the board, no turn.

## Running away is a flood, not a direction

`step_away_from` scored the four neighbouring cells and took whichever opened
the distance most. Two things went wrong with that, and both of them were
visible in the game rather than in a number.

**A wall defeated it.** A rabbit backed into a pocket has no neighbour that
gains anything — the only way out runs past you before it leads anywhere — so
the search found nothing, the action failed, and `stuck` put the animal in
`cornered`, which holds until you walk eight cells away. On a three-walled
pocket it stood still for fourteen rounds without moving a cell while somebody
walked up to it.

**And it flickered.** The best of four cells flips between two of them as the
threat moves, and nothing was committed to, so an animal that re-decided every
round shuffled on the spot instead of running.

`findRefuge` floods outward from the animal instead, scores every cell it
reaches, and hands back the route to the best one — so choosing somewhere to run
and working out how to get there are one search, off the came-from tree the
flood already built. It is `findPath` inside out: no goal to aim at, therefore
no heuristic to order a frontier by, therefore a flood rather than an A*.

- **Distance from the threat first, out of its sight to break a tie.** Distance
  is what fleeing means; sight is what makes it hiding. A tie-break rather than
  a term of its own, so an animal never doubles back towards a threat for the
  sake of a wall. Line of sight is asked only about cells already at least as
  far as the best so far, which is a handful over a whole flood rather than one
  per cell — and it is measured at the *fleeing animal's* height, because a flee
  is given a position rather than a body and a line between two cells is very
  nearly symmetric.
- **A refuge is kept until it is reached or cut off.** This is the half that
  stops the flickering, and it is worth being clear that the flood is not: an
  animal that re-flooded every round would get a different best cell every time
  you moved and would shuffle between them exactly as before. Dropped when it is
  reached, when it is no longer further from the threat than the animal already
  is — which is what both "you got between us" and "you followed me" look like
  — or when there was nowhere better to begin with.
- **`REFUGE_MAX_NODES` is 64, which is about six cells.** Enough to round the
  corner of a building or find the gap in a fence, and nowhere near enough to
  know the layout of a town. That is the same limit `PATH_DETOUR_SLACK` puts on
  a chase, arrived at from the other side: a creature is allowed to see what is
  around it and not allowed to have worked out where the doors are. Unlike the
  chase's budget it is spent *every time* — a flood has nothing to prune with —
  so it is what a flee costs rather than a ceiling it rarely reaches.
- **An empty route means cornered**, on the terms an empty route has always
  meant arrived. The `cornered` state authors already wrote still happens; what
  it means has changed. It used to be reached after two steps of hill-climbing
  and is now reached having looked at everywhere within six cells.

**The cost is a spike when a herd startles, and almost nothing after.** Measured
on a penned yard of fifteen deer and rabbits with somebody standing among them:
nine floods in nine hundred ticks, because commitment means an animal floods
once per escape rather than once per round. The worst tick is the one where all
fifteen notice at once — 10.9ms against the greedy version's 2.5ms — and after
that the worst is 3.4ms against 2.5ms. The spike scales with how many animals
startle on the same round, which is the bound worth remembering. On the shipped
map it does not show up in `bun run bench:server` at all: town and spread are
unchanged, because nothing like fifteen fleeing animals is ever near one player.

## A creature thinks every round only while somebody could notice it

`GameSession.tickBrains` used to give every resident brain a turn every round,
which made a round's cost a function of how many creatures the map holds. The
animal den made that 182 brains, ~13ms every 200ms on a laptop, and the wire
followed: every one of them wandering is ~40 changed cells a tick, 110 KB/s
to every socket, wherever the one player was standing. The same map ten times
over would have been ten times that, for the same one player.

A round is now split in two, and the split is where the cost goes:

- **Attentive** creatures think every round, exactly as before. A creature is
  attentive while a player is within the furthest distance its *own* brain
  ever asks about — `brainReach`, the largest `cells` on any condition in any
  of its transitions — or within a screen (`BRAIN_ATTENTION_FLOOR_CELLS`),
  whichever is further, on any level. A wolf reaches 22 (it investigates a
  sound at 22), a troll 30, a deer with no distance in its brain gets the
  floor. The reach is read off the authored conditions, so longer ears are a
  longer reach in the same edit. It is also why there is no separate
  "engaged" flag: every authored chase gives up at some `out_of_range`, and a
  creature still chasing is by construction inside its own reach of the
  person it is chasing. Being hit counts too — a blow is delivered by the next
  round, and dozing through it would drop it rather than delay it.
- **Dozing** creatures — everybody else — share `BRAIN_DOZE_BUDGET` turns a
  round, round-robin. That budget is the only term in a round the *map*
  contributes; the rest is players. What a dozing creature gets is a turn
  every `dozing / budget` rounds: about every seventh with today's
  population, every seventieth at ten times it. The rounds it is passed over
  are banked as `brainDeferredMs` and handed to the brain with its next turn,
  so a `wait` ends when it should, an `after` fires on time, and only its
  walking is slow.

Measured with `bun run bench:server` on the den map, one player standing in
town: brain round 13.6ms → 3.4ms p95, 42 → 19 changed cells a tick, 112 →
50 KB/s raw — and the 50 that is left is the budget's, not the map's.

The seams worth knowing:

- Distance is a square on the plan, ignoring level. A superset of every
  distance a condition reckons in, and a rat three floors under the street is
  attentive to somebody walking over it. That costs a turn; the other error
  would cost a creature its chance to notice somebody.
- `turnsOver` in `brain.test.ts` counts *noises*, not steps: a creature's
  step can be blocked by another creature's, and a noise cannot. Each of
  those tests was checked red by breaking the rule it pins — dropping the
  banked time, making everybody attentive, ignoring the reach.
- A round used to be one loop and one clock. It is still one clock: nothing
  here changes `BRAIN_TICK_MS` or the accumulator, and a test that advances
  one `BRAIN_TICK_MS` still sees every attentive creature decide.
## A joiner is sent the chunks its view can reach

The per-tick patch stream is bounded by how much the world changes, and since
brains only think when somebody could notice them that is bounded by the
players. The **join** was not: a client was sent the whole map, which on the
den map is 4.9MB of JSON, and that number grows with the world for ever.

A client is now sent the chunks within `INTEREST_REACH_CELLS` of its body, on
every level, and the chunks that come into reach as it walks arrive a couple
per tick, nearest first (`app/net/interest.ts`).

**The reach is derived, not chosen, and that is the whole of why this is
safe.** A cell a client has not been sent is a cell its own sky flood reads as
open air, so a subscription narrower than what the client's light bake reads
seeds daylight at its own boundary — a cave with a lit edge that moves as you
walk. The terms are all somebody else's constants:

```
half the view + the level span + LIGHT_WINDOW_MARGIN + LIGHT_CHUNK_SIZE + LIGHT_APRON
```

so widening any of them widens this in the same edit. The prefetch ring is
deliberately absent: a light chunk baked before its map arrives is a cache
entry, and the cells arriving is an edit that invalidates it, so it costs a
rebake rather than a wrong picture. The alternative — a small subscription plus
telling the bake to read absence as *solid* — trades the leak for the opposite
error, an outdoor cell shadowed by a wall that is not there.

**Three things are deliberately not scoped**, and each is a bug that a previous
attempt at this shipped:

- **The per-tick patch is still one broadcast to everybody.** What changes on a
  tick is where creatures are walking, which is bounded by the brain budget
  rather than by the map, so scoping it would spend the one serialization the
  protocol has and buy nothing.
- **Nothing about an actor is scoped** — hit points, statuses, carried lights,
  motion. They are small, they are about bodies rather than about ground, and a
  client that stopped hearing them would have a creature walk back into view
  with no health bar and nothing able to hit it.
- **Because of those two, no body can ever go missing.** Every client hears
  every cell that changes, so a creature outside somebody's subscription is
  still on their board — its surrounding terrain is what they lack, not the
  creature. That is what keeps `locateActor` off the whole-board sweep that
  turned a 116ms frame into 108ms of searching last time.

**What it is worth today is almost nothing, and that is expected.** The reach
is 79 cells, five chunks, a square 176 cells across; `data/map.json` is 118 by
142. Measured over the map, a client holds 84% of it on average and 49% at
best. The value is the shape rather than the number: the subscription is a
function of where the body is, so at ten times the map it is still about 37,000
cells while the world is 440,000. If it ever needs to be *smaller* than this,
the lever is the light cache — `LIGHT_CHUNK_SIZE` and `LIGHT_APRON` are 47 of
the 79 — and not the subscription, which is only as wide as what it must cover.

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

### The client predicts steps and does not predict gravity

A fall is the server's to announce. `RemoteSession` starts one only on
`fallStarted`, and until that event arrives its `motion.fall` is null — which is
fine for every fall that happens *to* a player and wrong for the one they walk
into.

Stepping into a hole is a legal step: `canWalk` allows a cell with nothing to
stand on precisely so gravity can pull a body through a drop too steep to climb
down. The client predicts that step like any other and lands the body in
mid-air, and for one round trip it is holding a direction, standing on nothing,
and has heard nothing to the contrary. It used to chain the next step out of
that cell — the server refuses every step from a falling body, so the avatar
walked one cell past the hole and was dragged back into it. On a local socket
the `fallStarted` beat the next step and hid this entirely; at 120ms it was
every time, and click-to-walk made it something a player could ask for rather
than a way of falling off a ledge by accident.

`predictStep` now asks `gravityPullOn` — the same verdict `maybeStartFall` acts
on, extracted so the two machines cannot drift — and takes no step from a cell
the board says the body is about to fall out of. The rule this belongs to is the
one `chooseStep` is under: **the client re-asks the simulation's own question
rather than keeping a second opinion about it.** Anything else the simulation
refuses a step for is a candidate for the same treatment.

Note what this is *not*. `abandonPrediction` is unaffected, and the overshoot
was never a re-sent step: the client minted a fresh `seq` for ground it had
genuinely not been told about, from a cell it genuinely believed it was standing
in. The fault was believing it.

### A client's actor set is its `hello` plus what it is told afterwards

**`RemoteSession` reads a body's *position* off the map, and it does not read
the *set of bodies* off the map.** It cannot: the notes below on never sweeping
for the player are the reason, and the set is held as the `motions` map instead
— seeded from `hello`'s `actorIds` and kept up by events since.

Which used to leave a hole. The only events that added an unknown id were
`joined`, for a socket, and — by accident — any motion event, since
`walkStarted` for a body this client has never heard of has to create the entry
it is about to write into. So every other way a world takes on a body reached a
client only if that body moved:

- A creature that respawned, which walked within a second or two and healed
  itself.
- A body somebody summoned with `/tile`, which healed itself only if it had
  somewhere to walk to.
- **A body with a `hold` brain, which never healed at all.** Its tile was drawn
  — a body is a tile in a stack and cell patches carry it — and everything keyed
  on the actor was missing: no name over its head, no health bar, no Talk row.
  A shopkeeper you could see and could not speak to until you reloaded the tab.

`spawned` closes it, and it carries nothing but the id: where the body is comes
from the cell patches in the same frame, and its bar and its lantern from the
diffs beside them. The event says only that there is somebody to hang them on.

**It is a separate event from `joined` because a joiner is a person.** `joined`
carries the headcount the players bar reads, and a rat is not one of the people
in the world.

**Nothing announces a body leaving, and nothing needs to.** Its tile goes off
the board in the same frame's cell patches, and `actorSnapshot` finds nobody to
answer for a stale entry — so a client holding one draws nothing and the next
snapshot is clean. `left` exists for the other half of `joined`'s headcount, not
for the set.

**The server's copy of the set (`announcedActors`) is filled where a `hello`
goes out, not on the first tick.** Seeding it on the first tick looks equivalent
and is not: a world can be loaded, somebody can summon something, and the tick
that would have announced it is the same tick that would have seeded the set —
so the body is silently absorbed and never announced at all. It cost a red test
to find, which is the shortest description of why the seeding point matters.

A hibernation wake is the one case the set is wrong about, and it is wrong in
the safe direction: the instance is rebuilt empty while its inherited sockets
were helloed by an instance that no longer exists, so the next tick announces
the whole world once. Every one of those is a body the client already holds, and
`spawned` is written to ignore an id it already has — which it has to be anyway,
because a socket that connects just after a spawn is told about it twice.

**The world ticks only while there is work** (`isAtRest`). `setInterval` blocks
hibernation, so an idle world stops ticking and its object can be evicted with
sockets still open. Going idle checkpoints the runtime map, which is what makes
eviction invisible — without it a wake would reload the authored map and drop
everyone back at spawn.

The renderer is a *viewer*. Camera, roof-cut, hover and pick follow `snap.self`
and deliberately stay single-anchor; `snap.actors` is what gets drawn and lerped.
`GameRenderer` is typed against `PlaySession`, not `GameSession`, so a remote
session can drive it.

### The roof-cut is a structure, not a storey

`roofCutFor` (`app/lib/levelVisibility.ts`) answers with a `RoofCut` — the
*cells* the view has taken away — and everything downstream asks it per cell
through `cutHides`. It used to answer a boolean and the whole scene took it:
stepping into one house lifted the roof off every house in town, which reads as
a claim about the town when the only thing that happened is that somebody opened
a door.

- **The probe did not change; only what it reports.** Same `VIEW_RADIUS` of 2.5
  cells, same light-model line of sight, same see-through windows. It now
  collects the cells above the viewer it can see rather than merely noting that
  it saw one, and those seed a flood fill through touching geometry above the
  viewer's level. That component is the cut.
- **The fill is 26-way, and generously so on purpose.** Merging two structures
  that touch at a corner costs one extra roof lifting with yours — which is what
  every roof did until now. Splitting one costs a hard diagonal edge with half a
  roof drawn either side, and that is the artefact a 4-way fill produces the
  first time a roof steps diagonally. The level above and below are in the same
  neighbourhood, or a two-storey house whose upper floor sits in from its roof
  cuts as two things.
- **Past `MAX_CUT_CELLS` the cut falls back to the whole storey**, `cells: null`,
  which is exactly what this did before. The level above a cliff is a hillside
  with no building in it to single out, and a *truncated* fill would put a moving
  hard edge across continuous ground. The worst case is the old behaviour rather
  than a new artefact.
- **There is no structure index, and there should not be.** One built at load
  would need invalidating by every wall a player places, every roof authored and
  every decay — and would still be answering a question that changes when the
  viewer steps, since which component counts depends on where they are standing.
  The fill is proportional to one building, so `GameRenderer` caches the cut on
  map identity and the view anchor: `MapFile` is copy-on-write, so any edit
  anywhere hands over a new object, and nothing else in a frame can change which
  structure stands between the player and the sky.

**A subset of a level has no object to hide, so the cut is a shader mask.**
Static level geometry is merged into one draw call per texture. Rebuilding it is
the obvious alternative and the wrong one — `buildLevel` walks every coordinate
on the floor and the cut changes on every step. So the cut rides the road the
light map already travels: a small texture in cell space, sampled at the quad's
own base cell, and a cut fragment is discarded. `vBox.xy` already carries that
cell (the unshifted east and south edges of the base cell), so there is no new
attribute and no new geometry — and it covers merged batches and separately
meshed tiles alike, because both wear a `materialFor` material.

- The mask is sized to the cut's own bounding box plus a one-cell apron of zeros
  (`app/render/cutMask.ts`), so it is a few hundred bytes whatever the viewport
  or the world measures, and it does not have to be rewritten when the camera
  slides. The apron is load-bearing: a texture clamps at its edge rather than
  reading zero past it, and without the ring the outermost cut row would smear
  across the rest of the floor.
- `unpackAlignment = 1`, because a row of a single-channel mask is `w` bytes and
  `w` is whatever the roof measures — the default four-byte alignment reads the
  wrong pixels for three widths in four.
- `applyRoofCut` skips a frame whose cut is the same *object* as last frame's,
  which is the usual case. Level groups built after that point read the standing
  cut for themselves; both `buildLevel` and `ensureLevelGroup` have to, and
  forgetting either leaves one floor still drawing its roof.
- The whole-storey path stays `group.visible = false`, which skips the floor's
  draw calls outright. A structure cut draws the level and discards, and that is
  the cost of being able to lift one roof and not its neighbour.
- **An arrow is the one thing the mask cannot reach.** A flight is parented to
  `world` rather than to a level group, and its box is where the arrow *is* —
  never a cell the fill claimed — so `applyProjectiles` tests the cut itself.

**`isHiddenFromCamera` gained real behaviour rather than a translated clamp.** It
skips the cells the cut took and keeps walking, instead of stopping at a ceiling
level. That is the only version that works once one roof can lift while its
neighbour stays: a body under the roof that is *still drawn* has to stay
anonymous even though a roof at its level lifted a street away, and a level
threshold cannot tell the two roofs apart.

**The walk is skipped entirely for a body on the viewer's own floor.**
`GameRenderer.isVisibleBody` asks it only of the storeys you are not standing
on, which is where a body genuinely is painted behind a floor or a roof. On your
own level the same test mostly catches furniture — a rat stepping behind the far
side of a wall beside it, or under the lip of the roof over its head — and a
name blinking out as a creature walks past a crate reads as a bug rather than as
cover. On-screen is the whole rule there; occlusion starts mattering a floor
away.

**Every piece of chrome asks `isCellVisible`, and the one that did not was
wrong.** The rule — roof-cut, then the viewer's own floor, then
`isHiddenFromCamera` — lives in `app/render/cameraSight.ts` beside the walk it
wraps, and `isVisibleBody` is that plus `isWithinView`. Damage numbers used to
ask a different question: `Math.abs(hit.z - self.z) <= 1`, a level slack from
before the walk existed. So a fight one storey down inside a cave rained numbers
over the ground above, through rock that was drawn in front of it. The slack was
always an admission that there was no cheap per-pixel answer for the floors
below you; there has been one since `isHiddenFromCamera` was written, and
approximating a floor's worth of doubt on top of an exact answer only takes back
the cases the exact answer got right.

Speech and noises are *not* on this rule, and deliberately: the server sends
them to the speaker's own level only (`sendToLevel`), which is a narrower bound
than what is on screen. Widening them to match would mean broadcasting to
everybody and gating on the client, which is a change to who hears what rather
than a bug fix.

#### A cut is a local question, and underground it is the most expensive one

The cut was the single most expensive thing on a frame in the caves — 27–33ms,
more than the map, the light and the draw together — and none of it was
visible. Three separate reasons, each worth knowing on its own:

- **It was cached on whole-map identity.** Map identity changes when any cell
  anywhere does, and a world with a couple of hundred creatures in it changes
  on almost every tick, so the cache missed on almost every frame. A cut is a
  local question — what stands between this body and the sky within
  `VIEW_RADIUS` — so it is now keyed on the chunk records the *probe* reads
  (`cutProbeChunks`). A rat stepping on the far side of the world no longer
  re-runs it. What that deliberately does not cover is the fill, which can run
  far past the probe: a roof cell added at the other end of a building is not
  noticed until the body moves, and cells that far away are not on screen.
- **The fill rebuilt three keys per neighbour probe.** Twenty-six neighbours per
  cell, up to `MAX_CUT_CELLS` cells, each asking `getStack` for a level key, a
  chunk key and a cell key. Neighbours are adjacent by construction, so holding
  the last level and chunk record makes the common probe one object lookup.
- **`MAX_CUT_CELLS` was ten times larger than anything the world contains.**
  Sampling 2,947 anchors across every level of `data/map.json`: the largest
  structure cut anywhere is 392 cells, p95 is 280, and *every* anchor
  underground refuses and falls back to the whole storey. So the cap never
  decides a real building's cut — it only decides how long the fill spends
  finding out that a cave ceiling is not a building. At 1024 there is 2.6x
  headroom over anything authored and the same sample returns every cut
  identical.

Together: 27–33ms to 1.9–2.9ms per cut, and computed once per step rather than
once per frame.

**The lesson that generalises is the first one.** Anything cached on `map`
identity in a world with a crowd in it is cached on nothing at all. Ask what
region the computation reads and key on that.


## Fighting is stats on a tile, and nothing else

A **battler** is any tile with an `interactions.battler` block (`app/lib/battler.ts`):
base hit points, masteries, a natural weapon, what it notices and what it is born
carrying, parsed rather than trusted like every other interaction. The player,
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

### How big a body is, is the one number masteries could not say

Everything a fight reads now falls out of masteries and a weapon — that is what
lets a rat be something other than a smaller snake. It also left the *size* of a
body with nowhere to be stated: two bodies with the same Toughness had the same
hit points, and the only way to make a boss take more killing was to give it a
mastery it had not earned.

**`battler.baseHp` is that number, and Toughness cannot reach it.** It is the hit
points a body has at Toughness zero, and `maxHpFrom(baseHp, toughness)` adds it
to the mastery's accelerating curve. A term rather than a factor, deliberately: a
multiplier would make the same hundred points of Toughness worth ten times as
much to the boss as to the player, and one mastery would stop meaning one thing.
As a term it says what it looks like — this body starts that much further up —
and a point of Toughness is worth the same to everybody who trains it.

**Required on the block, not defaulted.** Left optional, every creature in the
world would keep the base nobody had chosen for it, and the field would exist
without being authored anywhere. So a block without one fails the schema and
reads as "not a battler", on the same terms `masteries` and `naturalWeapon`
already do — and the nine creatures in `data/tiles.json` were migrated onto it at
8, which is what the constant used to be for all of them. `DEFAULT_BASE_HP` is
now only the editor's starting value; nothing derives hit points from it.

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

Resistance is **read, never rolled for**. A warded defender costs a swing exactly
the same draws a bare one does — the same rule everything in a fight is under.
The one draw defence *does* take is the guard below, and it is taken whether or
not the defender is wearing anything.

### Armour is a draw, and immunity is a rung rather than a threshold

`defenceAgainst` says how deep a body's guard is; **what a blow actually meets is
a draw from it** (`guardFraction`, `guardBand`, `guardRolled` in
`app/game/combat.ts`). Two constants shape that draw:

- `MIN_GUARD_SHARE` (a quarter) is the shallowest it can come up.
- `GUARD_PEAK` (three fifths) is where it usually does.

Between them the draw is **triangular** — rare at both ends, common around the
peak — sampled by the inverse of a triangular CDF, so one uniform draw comes out
humped with nothing resampled or rejected. The mean is the average of the three
corners, `(0.25 + 0.6 + 1) / 3`, so armour is worth about **62% of its face
value** on average.

**Armour used to be a flat subtraction, and flat made it an on-off switch.** A
creature's blow lives in a bounded band: a wolf is authored at damage 12 and
variance 35, so its bite is *always* worth between 8 and 12, and `MAX_ARMOR_DEF`
is deliberately the same scale as `MAX_WEAPON_DAMAGE`. Put those together and a
defence of 12 was not "very good against wolves" — it was total immunity,
reachable in the starting kit plus a bone charm. Measured before the change, a
fresh player in cap, jerkin, boots and charm took **0.96** per landed wolf bite
against thirteen hit points; with a shield on top, **0.03**. A rat never got
through a cloth tunic.

**Being untouchable is still reachable and costs four times what it used to.** A
blow is blocked outright when the guard it drew is worth the whole of it, so
*always* blocking something takes a defence whose `MIN_GUARD_SHARE` already
outweighs the blow — four times the blow rather than equal to it. That is the
whole rule about what a well-armoured body can shrug off, and it is deliberately
a rung on the ladder rather than a threshold anybody crosses by accident: the
starting kit is now immune to rats where a cloth tunic used to be, and a wolf
needs fifty Toughness *and* the best sharp armour in the world before it stops
mattering.

Three things worth knowing before touching this:

- **The peak is above the middle on purpose.** Armour that usually performs a
  little better than halfway is armour that mostly does what it says; the
  interest is in the tail below it rather than in a symmetric wobble around a
  number nobody chose. A *flat* draw was the first version and it was worse to
  play against — a mail shirt that turned nothing aside was exactly as common as
  one that turned aside everything, which reads as noise rather than as armour.
- **The guard is whole numbers, and that is load-bearing.** Hit points are whole,
  and a small enumerable band is what lets `app/game/combatMetrics.ts` stay exact
  rather than sampled. It finds each rung's odds by **bisecting `guardRolled`**
  for where one whole number of guard becomes the next; the draw is uniform, so
  the width of that stretch *is* how often the rung comes up, and the file never
  has to know what shape the curve is. Move the peak and the Arena's table
  follows on the next render.
- **A `MIN_DAMAGE_THROUGH` floor was tried and taken out.** Guaranteeing every
  landed blow at least one hit point does close immunity for good, but it also
  deletes `absorbed` as a concept, flattens the top of the armour curve into
  "everything chips you for one", and makes a rat's damage-per-second independent
  of what you are wearing. Blocking is worth keeping; what was wrong was how
  cheap it was.

**The draw costs the swing one more roll**, taken with the damage band and before
the status draws — `rollAttack` is five draws plus one per authored status now,
not four. It is taken whether or not the blow gets far enough to meet armour, for
the reason every other draw there is: what has to be constant is the count, never
the reading.

`SwingOdds.absorbed` survived the change and changed meaning: it used to be a
property of the two stat blocks — this armour stops this weapon, yes or no — and
is now a **rate**, because the same armour blocks a blow it drew well against and
misses one it did not.

Two consequences for authoring. Physical mitigation is worth roughly a third less
than its face value suggests, so armour authored against the old arithmetic is
weaker than it reads. And a resistance keyed to a mastery *every* creature in the
world strikes with is not a choice, it is a strictly better piece of armour — see
the note on creature masteries below.

### A creature strikes with the mastery its attack actually is

Every animal in the world used to have its natural weapon authored as `fist`,
which made `bone-charm` — a `charm` with `resist: { fist: 4 }` and no defence at
all — worth more against the whole bestiary than four occupied armour slots put
together. A resistance is only a choice if there is more than one kind of blow to
choose between.

So a natural weapon now carries the mastery its attack *is*. Teeth and claws are
`sharp`, which is most animals: rat, cat, snake, bat, wolf. The cave troll swings
`blunt`. `fist` and `blunt` are where humanoids will mostly sit.

**A creature's `masteries` key has to match its weapon's `mastery`,** and that is
the trap this exposed. `fightingStats` reads `masteryLevel(masteries, weapon.mastery)`
for the skill bonus, so a body trained in one thing and swinging another gets no
bonus at all and nothing says so. The cave troll had `fist: 60` beside a `blunt`
club and had been fighting at skill zero — fixing the key took it from damage 20
to 35 and accuracy 80 to 95, which is a change to how dangerous it is and not a
refactor.

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
Target, inspect and attack are the three, exactly one holds at a time, and the
machine is `app/components/usePlayModes.ts`. (Target was called "interact"
until it was clear that picking a body out without swinging is the only thing
it does differently from attack — objects answer a tap the same way in both.) They were two independent latches
and the failure was reported rather than guessed at: with no *name* for "neither
one is on", people drew the sword, walked off, and never connected the red
outline under everything they pointed at with a button they had pressed a minute
before. Two consequences worth knowing about:

- **A player starts in attack** (`INITIAL_PLAY_MODE`). Tapping a creature is
  nearly always the start of a fight, and a first fight that began with a white
  outline and no blows read as the game not working. The shipped shopkeepers
  have no hit points, so there is nothing to swing at; for an NPC authored with
  both, `talk` outranks `target` in `ACTION_ORDER`, so a tap within
  `TALK_REACH_CELLS` talks in every mode. Out of talking reach it targets.
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

### Eight rats used to be one rat, eight times

Defence is a flat subtraction and evasion is a contest fought one attacker at a
time, so a body armoured against a rat's bite was armoured against every rat's
bite at once. A player could stand in a ring of eight and train Toughness on a
fight that could not hurt them. `underPressure` in `app/game/combat.ts` is the
answer: every blow is rolled against a defender holding `guardShare(assailants)`
of their evasion, their flat defence and their resistances.

- **Hyperbolic, `1 / (1 + 0.35·outnumbering)`.** Two bodies leave you three
  quarters of your guard, four leave you half, eight leave you under a third. The
  second attacker is the one that costs; the eighth barely registers on top of
  the seventh, which is the shape being outnumbered actually has. It never
  reaches zero, so no crowd makes armour meaningless.
- **The resistances give way with the flat armour.** What a blow has to get
  through is `defenceAgainst`, so scaling `def` alone would make being surrounded
  survivable by wearing the right coat. `def` is rounded on the way out because
  hit points are whole.
- **Who counts is who has *swung* at you.** There is nothing else on the board to
  read: a creature's target lives in its brain's memory as a bound slot, and a
  body standing next to you minding its own business is not attacking you. So
  `ActorRuntime.assailants` is written by `tryAttack` and by nothing else, and it
  is a map of attacker to milliseconds left, wound down by the tick loop exactly
  as `defensiveDecay` is.
- **You count until you are overdue.** The window an attacker buys with a blow is
  its *own* swing interval plus `ASSAILANT_GRACE_MS`, not a flat few seconds — a
  flat window would let anything slow drop out of the count between its own blows
  and hand the defender their whole guard back for free. A corpse is dropped from
  every crowd in `kill` rather than waiting out its grace, so the last blow of a
  fight you have just won is not still fought outnumbered.

Ranged attackers count on the same terms as anything else, which is a decision
rather than an oversight: an archer plainly splits your attention, and a rule
that only counted what was in arm's reach would make a line of bowmen the safest
thing in the world to walk into.

`duel.ts` and `combatMetrics.ts` are untouched by this. Both are the Arena, and
the Arena is a duel — one attacker, `guardShare` of exactly one, the same numbers
they always reported.

### A foe you have outgrown teaches you as little as a weapon you have outgrown

Toughness ran away from every other mastery, and the measurement is worth keeping
because the cause is not where anybody looks first. Fighting a wolf, the offensive
and defensive payouts go through the *same* expression —
`experienceMultiplier(wolfRating, playerRating)` at both call sites in
`awardExperience`. The only thing that separated them was `learningRate`, which
throws away everything past a weapon's requirement and has no defensive twin. A
player on the wolves in the middle of that grind earned **+274 Toughness and +8
Sharp from the same exchanges** — twenty-eight to one — and reached Toughness 40
in about thirty fights.

Two things compounded it:

- **The payout is on `potentialDamage`, which armour never touches.** That part
  is deliberate and survives the fix: what you are wearing is how you survive a
  blow, and it has no business deciding what the blow taught you. Neither term
  can see it — `potentialDamage` is rolled before `damageAfterDefence` subtracts
  anything, and `maxHp` comes off Toughness alone, since `effectiveBattler`
  overrides `def` and `resist` and nothing else. Against the same wolf a naked
  body takes 7.08 damage a blow, one in full plate takes 0.00, and both earn
  17.7452. But measured over twenty thousand wolf blows, a
  player at Toughness 40 in ordinary starting gear takes **0.00 damage per blow**
  and was paid as though it had done 9.29. From there to Toughness 100 the payout
  never fell.
- **Toughness self-brakes weakly.** It is 0.3 of Rating, so 5 → 50 moved R from 6
  to 26 and dropped the multiplier only 2.00 → 1.16, while hit points went 13 →
  77. The fights got trivial; the payout barely moved.

`threatRate` in `app/game/experience.ts` is the defensive twin: a blow is worth
the full rate when it could take `SIGNIFICANT_THREAT_SHARE` (a fifth) of your
whole health off, and falls off as a fourth power below that. What the share
decides is where each creature stops being worth standing in front of — a wolf
teaches Toughness at full rate to 32, a snake to 29, a cave troll to 51, a rat
almost never — which is the ladder the world is already authored on. It is
measured against
`maxHp` rather than health left — current health would pay most to whoever sat at
one hit point, and the optimal way to train would be to stay nearly dead — and
hit points are the yardstick because hit points are what Toughness buys, on a
curve that accelerates, so the brake tightens faster than the mastery climbs.
The exponent is a taper rather than a wall (4, where the offensive side's is 3
and could afford to be steeper): a player who has outgrown a weapon can put it
down, and nobody can take off their Toughness.

On the wolves this moves Toughness 40 from 26 fights to 36, and a hundred and
twenty of them leave you at 47 rather than 63. The first twenty rats are
untouched at 6.

It applies to the Agility row too. A dodge you never needed to make is worth as
little as a blow you cannot feel, and exempting Agility would have left the whole
thing standing one mastery over.

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

Height is in **height units** (four to a level) and absolute, never in floors:
a body on a crate is half a level above the floor it shares with you, and half a
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

### A tile names one sheet, and every rect is measured from one cell

`TileDef.anchor` is a `SpriteAnchor` — a sheet and a cell on it — and every
`SpriteRef` the tile carries is a rect *relative to that cell*. `spriteRect`
turns a pair back into where the art actually sits, and `spriteRefAt` is its
inverse, which is the editor's picker on the way back in.

Both halves used to be per sprite: each `SpriteRef` named its own `tilesetId`
and measured from the sheet's corner. Neither was ever varied. All 138 tiles in
the catalogue drew from exactly one sheet across all 1373 of their sprite refs,
and a walk cycle whose second frame came from another picture is not a thing
anybody wants to be able to author — `AnimationTable` refused one outright, and
that check is gone because the shape can no longer say it.

What the absolute rects cost was moving a drawing. A character is four or eight
facings times however many frames times however many states, drawn as one block,
and the next character is the block beside it. Re-pointing a tile at that block
meant re-picking every sprite by hand: twenty-four drag-selects, any one of which
can land a cell off without saying so and without anything failing. There was a
tool for it — `offsetTileSprites`, which walked every sprite field and every
state and added a vector to each — and it is gone too. Moving the anchor is the
whole operation now, and the tile editor's *Anchor* is two numbers next to the
sheet picker.

**A rect may be negative.** The anchor is the point the art is measured from, not
a corner it is boxed into, so a sprite picked above or to the left of it is art
somebody meant. `anchorFits` checks both edges for that reason, and refuses
rather than clamping: an anchor nudged back onto the sheet would leave every
sprite at its old distance from every other, which is a character drawn from
whatever happened to be under the new corner.

The anchor is also the whole of what it takes to say *draw this art from
somewhere else*, which is what equipment on a body will be.

**Migration.** `normalizeTileDef` gives a tile written the old way an anchor —
the sheet off its first sprite, the cell at the top-left corner of everything it
draws — and rewrites every rect relative to it. `scripts/anchor-tiles.ts` did
that to `data/tiles.json` once so that reading the file tells you what the game
will do with it; the migration stays because a hand-edit or an old export can
still arrive in the old encoding. It refuses a tile whose sprites disagree about
their sheet rather than silently drawing the rest of it from the wrong picture.

**A status icon is not one of these.** `StatusDef.icon` is an `AnchoredSprite` —
sheet, absolute rect, base — because it is one rectangle drawn in a panel rather
than a block of art with facings and frames, so there is no block for it to be
relative to. A tile's sprite becomes one of those too when something outside the
world draws it: `anchoredSprite` composes one, and a thumbnail has no anchor of
its own to measure against.

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

### A walk cycle in the wrong row is a bug only a person can see

Nothing in the codebase can tell that a creature's `moving` frames for one
facing are drawn from another facing's row: the rects are valid, the tileset
exists, the animation plays. The rabbit walked north in its west-facing frames
from the day it was authored, which nobody noticed while `step_away_from` was
greedy and a fleeing rabbit almost always ran straight away from you. Fleeing
became a flood (see *Running away is a flood, not a direction*), refuges started
coming out sideways, and the same art became a rabbit bolting away with its head
turned to watch you.

What is checkable is that no two facings of one walk are drawn from the same
frames — `app/lib/tileArt.test.ts`, against the real catalogue. Symmetric
scenery reuses art on purpose and is excluded by asking only about tiles that
animate a walk: a sign, a roof and an anvil all draw north and south from one
rect and there is nothing to tell apart, while a body has a front. A repeated
facing on a body is always a row somebody copied and forgot to move.

## Magic is a stone you carry, and there is nothing else to it

There is no mana, no spell book and no spell slots. What a caster can do is
decided by which **arcane stones** they are carrying, how recently each was used
and — for the stones that take time — how far past what one asks the caster has
got. The whole of a loadout is two hands and a charm, which is why the desktop
binding is `1`, `2`, `3` and stops there.

A stone is an arm of the item union beside weapon, armour, shield, consumable,
container and artifact, and it is a kind of its own for the reason a shield is:
both hands swing, so anything held that is not meant to be swung has to be
refusable by the rotation. `weaponSwungBy` refuses everything that is not a
`WeaponItem`, and that one existing line is the whole of "a stone in a hand
never swings". One stone and a sword swings the sword every turn; two stones
falls back to fists, because the rotation already skips a hand with nothing in
it. Nothing was written for either.

### The effect vocabulary is two things, and closed

**Bolt** at the caster or the target, **conjure** a tile. Both are things the
simulation could already do, which is why casting added no new physics:
"luminous" is an ordinary authored status whose visual block carries a
`LightDef`, riding the same emitter path a carried torch does. Area of effect is
deliberately absent — no spell touches more than one target or more than one
cell.

**A stone reaches whatever its effect says, in every square.** A bolt at the
target reaches for the one the player already picked for attacking; a bolt at the
caster reaches nobody. A conjure lands on the target's cell or, with nobody
targeted, on the cell the caster is facing: the player never picks an arbitrary
square. Range goes through `canReach`, so a spell out of range fails exactly the
way a swing does, wall included. A conjure whose cell will not take the tile is
refused the same way, before the cooldown — see "A conjure lands where the
caster could step, or is not cast" below.

##### A charm is its own kind of item, and stones stopped pretending

An arcane stone could be marked `automatic`: it fired by itself, it was refused a
hand, and it waited for a moment where casting it would not be wasted. That was
one kind of thing wearing two hats. Every question about a stone had a second
answer for the automatic case — does it get a button, may a hand hold it, does it
wait — and the charm square had to be a *special* square to hold one.

`CharmItem` is the passive on its own terms: an `everyMs`, an optional `hp`, and
an optional list of the same `StatusGrant`s a consumable carries. No cast, no
target, no reach, no requirements, because none of those are questions about
something that happens without you. The Arcane Necklace of Life is one — a point
every ten seconds — and `automatic`, `automaticFires`, `StoneHolder` and the
`automatic` cast refusal went with it.

**Which is what finally makes a stone a stone.** A hand takes every stone now,
the charm square takes stones on exactly a hand's terms, and it takes charms
because nothing else will have them. The squares differ in what they *cost* and
in nothing else.

**`hp` is unsigned, unlike a consumable's.** A consumable is something you chose
to swallow, so a poisoned apple is fair. A charm acts on its wearer without being
asked and on a clock they cannot see, and a trinket taking hit points off
somebody every ten seconds is a way to kill a player who has no way to learn why.
A cursed object is a status with a `bad` tone, which says so on the strip.

**Nothing waits for a moment worth acting on**, which is the one behaviour that
did not survive. `automaticFires` held a passive back until it would not be
wasted — a mend waited until you were hurt — because a stone that fired on
nothing spent a cooldown and sat cooling when you needed it. A charm has no
cooldown to waste: `applyHealing` clamps at full health and floats nothing, and a
grant landing on somebody already under it is the refresh every other granter
performs. The condition protected a resource that no longer exists.

The clock is on the wearer, keyed on the particular charm's instance id, and is
deliberately **not durable**. Keying it means the same charm put back on resumes
and a different one starts fresh, so wearing a cheap charm to run the interval
down and swapping on the last tick buys nothing. Not durable because a stone's
cooldown is durable for a reason that inverts here: reconnecting must not be the
cheapest spell in the game, where a charm clock rebuilt on load costs its wearer
at most one interval.

##### The charm used to override that, and it was a trap

A charm reached nobody but its wearer — refused a target in `castability`, and
re-pointed at its wearer in `castBolt`. Two halves of one rule, in two files,
and nothing said they were the same rule. The failure mode was not that a
`target` stone did not work in the charm: it was that it **silently worked on the
wrong body**. Dragging Sleet from a hand to the charm turned a five-point attack
into four points of self-harm, behind a fully lit button, with no notice.

The argument for the old rule was that a passive trinket reaching as far as a
hand would be the longest-ranged thing in the game. That was answering the wrong
question. **What separates the squares is what they cost, not what they reach**:
a hand is a swing you gave up, and the charm is the square that costs no swing at
all. Reach was never the price.

So the square has no say. `needsTarget` reads the effect and nothing else, the
charm is held to the same range and the same wall, and what is still charm-only
is an `automatic` stone — the one thing a hand refuses. A wearer who wants a
trinket that hurts them writes `on: "caster"`, which is what that field is for.

#### A status is something a bolt carries, not an arm of its own

It was an arm, and the split was drawn in the wrong place. A bolt and a status
asked all the same questions — whose body, how far, what element, what a charm
does with it — and answered them in two sets of code that had to be kept saying
the same thing. Worse, the two could not be combined: **a stone that burned
somebody *and* set them alight was not authorable at all**, which is the most
obvious fire spell there is.

So a bolt carries `statuses`, which is the weapon's own field validated by the
weapon's own schema and rolled by the same `inflictedBy` — an id and a
percentage apiece. Both halves are optional and the useful combinations fall out
rather than being enumerated: a pure ward is a bolt with a status and no damage,
a pure mend is a bolt with damage and no status, and a brand is both. A bolt with
*neither* is refused: it is a spell that spends a cooldown to do nothing.

**The chance is the stone's own and no mastery moves it**, on the same argument
a weapon's is under: Arcane and the elements have already had their say twice —
on how deep the bolt ran and on what the wheel made of it — and scaling the
chance as well would pay one skill three times.

**Armour eating the damage does not save anybody from the burn**, which is again
a weapon's rule word for word: what a ward stops is the blow and not the rune.
What does stop it is nobody being there, and a body the same cast killed — a
status is a condition you are *in*, and a corpse is not in one.

`automaticFires` OR-s the two halves, and that matters: a stone that mends and
wards is worth pressing when *either* would land, or combining them would be
worse than authoring either alone — exactly backwards for the change that let
them combine.

**A conjure stays its own arm**, because it is the one effect that does not land
on a body at all. It touches a cell, the player never picks that cell, and none
of the questions above have answers for it.

#### A heal is negative damage, and there is no second arm for it

The vocabulary used to open with a `heal` that put health into its caster and
nobody else. It is one `bolt` now, carrying a **signed** `damage`: positive
harms, negative mends, and `on` says whose body it lands on exactly as a status's
does. Mending and harming were never two mechanisms — they are one number with a
sign, and writing them as two arms meant two subjects to decide, two scalings to
keep in step and two places to remember the wheel.

What differs between the two directions is not the arithmetic but who has a say
in it, and it comes to exactly three things. A harm has to get through what the
subject is wearing and is then weighed on the wheel; a mend is stopped by
neither and stops at a full health bar instead. Nobody has ever worn armour
against being healed.

Two things that used to be rules somebody wrote are now facts about the sign. A
**mend at a target** is authorable, where the old arm refused it on the grounds
that there are no allies — there still are none, so it is a thing an author may
write and probably should not, and the model no longer has an opinion. A **harm
at the caster** is the curse that used to need a status to express.

#### A bolt is mitigated and never dodged

**No accuracy and no dodge.** A cast is not aimed: you spent the cooldown and the
stone answered. What is left of a swing's dice is the variance band, rolled
through the same `damageFraction` a weapon's is, and absent variance is a spell
that does exactly what it says — the honest default for a thing you press every
few seconds *instead of swinging*, where a swing you take thirty times a fight
can afford to be a distribution.

That is the trade the profession is built on: a bolt is the reliable half of an
arcanist's damage and a swing is the frequent half. A press you paid a hand for
cannot also be a coin toss.

What it *does* go through is `damageAfterDefence`, as an **arcane** blow — the
mastery a stone answers to, which is the whole reason the `magic`/`arcane` rename
collapsed two names into one. A breastplate authored with an arcane resistance
turns one aside. The elements deliberately do not appear there: what an element
is worth against a body is the wheel's question, asked one step later on the
damage that got through, and keying resistance off them as well would let one
piece of armour answer the same blow twice.

#### A bolt scales like a weapon, off two masteries rather than one

`spellPower` is the caster's `fightingStats`, and it is deliberately the same two
terms against the same two constants — a share of the stone's own worth, so a
better stone rewards mastery more in absolute terms, and a flat amount, so
mastery is worth training with something small in your hand. The authored number
is what the stone does for somebody who has learnt nothing.

What differs is *which* masteries are read, and that is the one place a spell is
not a weapon. A weapon answers to exactly one mastery; a spell answers to two
facts this codebase already keeps apart — **Arcane says how good you are at magic
at all, and an element says what you point it at**. So `castingSkill` is the
**mean of Arcane and each element the stone asks for**. The mean rather than a
sum keeps the answer on the 0–1 scale the two constants are written against, and
it makes a two-element spell genuinely *harder* rather than merely more
expensive: a stone asking Fire and Water is thrown at the average of three
numbers, so training one half of it buys you a third of the spell.

**Requirements are not read as a ratio here, unlike a weapon's**, and the absence
is the design rather than an oversight. `weaponReadiness` exists because a weapon
you have not earned still swings; a stone you have not earned does not fire at
all, so the share is one at every call site this has. Writing the term anyway
would be a factor that can never be anything but one, sitting in the formula
inviting somebody to believe it does something.

#### What a bolt throws is the same flight a bow's is

`ProjectileDef` moved out of the weapon schema into a shared `projectileSchema`,
because a spell's flight *is* a weapon's — same `flightDurationMs`, same
renderer, same promise that the picture is allowed to lag the truth and can never
contradict it. `fireProjectile` now takes the block rather than a `FightingStats`,
which is what lets a cast use it at all: a bolt has a projectile and no fighting
stats to hang it on, and resolving some for a caster would be inventing a weapon
nobody is holding.

**Nothing flies when the subject is the caster.** A bolt at your own body has no
distance to cross, and an arrow from a body to itself is a frame of art sitting
on somebody's head.

The shipped bolts throw `arcane-shard` — the mote already in the catalogue, which
is a one-cell prop with a small blue light on it. It is not a `directional8` tile
and does not need to be: a mote has no bearing to point along. The editor's
picker still offers only 8-way tiles, which is the right default for the thing an
author is usually reaching for, and the schema does not enforce it.

**Eight cells a second rather than twenty**, which is well under a bow's. A
bolt's three cells at an arrow's speed is 170ms in the air — half a bow's shot,
and it reads as a flicker rather than as a thing that travelled. The flight is
the only part of the animation carrying any information about distance, so it
has to last long enough to be seen carrying it.

**A conjure lands *under* a body already standing there**, which is the same rule
`/tile` places underfoot by. What a tile does to a body is read off the stack
below it, so a flame conjured on top of somebody would be a flame nobody is in —
and a flame aimed at a target who is standing still would do nothing at all.

#### A conjure lands where the caster could step, or is not cast

With nobody targeted the cell is the one `canWalk` would step the caster's own
body into, and the tile must then pass `canPlace` there. It used to be the
facing cell run through `destCellAfterStep` and `canPlace` alone, and a height
check says a bush (height 2, room for a height-2 flame on top) and a pond
(height 0) both have room — so a flame was stacked on a bush or floated on
water. Asking the legs refuses a wall, water and a bush with no list of any of
them, and still puts a flame laid at the top of a ramp on the ramp.

**Nowhere to land is a refusal, `blocked`, and costs nothing.** It used to
spend the cooldown on a swing's terms, but a swing that misses still swung; a
flame that never appeared is a press the player cannot tell from a dropped key.
`conjureLanding` in `app/game/casting.ts` is the one answer: `castability`
refuses on it and `castConjure` places with it, and the browser runs it too, so
the button dims when you face a wall. Stepping into open air is still a legal
step — gravity needs it — so a flame can still be laid over a drop.

**A stone with a cast time asks it twice**, once when it is pressed and once
when the bar fills, and the second is the one somebody can do something about:
drop a crate in front of a caster mid-flame and nothing happens, with the stone
still ready. @see "A cast can take time" below

#### A cast is resolved from where the caster is arriving

Three things made a flame land on its own caster, or beside where they were
facing, and each is a way the server's idea of the caster lagged the browser's:

- **A step commits only when it lands.** Mid-step the board still holds the
  body in the cell it is leaving, so the cell "in front" was the cell being
  entered. `casterPointOf` (session) and `casterPoint` (browser) both cast from
  the walk's destination instead.
- **A cast overtook the steps sent before it.** Steps queue and are taken on a
  tick; a cast was honoured on arrival, so a server one step behind cast from
  one cell back. `face` and `cast` now join the same per-actor queue
  (`queuedIntents` in `server/GameServer.ts`) and are honoured in the order they
  were sent, immediately when nothing is waiting.
- **A turn made mid-step was undone by the step landing**, because `commitWalk`
  writes the walk's direction onto the body. A predicting browser has usually
  landed that step already, so the turn it sends arrives mid-walk on the
  server. `faceActor` now writes the turn onto the walk too — in place, since a
  new walk object is announced as a new step.

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

**The ring is smooth anyway, and that is the browser's work, not React's.**
Drawn straight from the figures, the arc in `app/components/SpellBar.tsx` jumped
once a second. Each new figure now starts a Web Animations API animation on the
arc's `stroke-dashoffset`, from wherever it currently is to one
`COOLDOWN_STEP_MS` lower over one step. The page still renders once a second.
Starting from the arc's computed position rather than the figure is what keeps
it continuous when the first step after a cast comes early — the stone clock is
shared by the whole world, so its phase against any one cast is arbitrary.

**A cooling stone is locked in its square**: it cannot be moved, swapped or put
down. This is the second cross-cutting square rule after the two-handed weapon,
and it lives beside it in `app/game/equipment.ts`. Without it a caster carries
six stones in a bag and rotates through them, and the cooldown decides nothing.
The lock is on *player-initiated* moves only — a death drops the whole kit
regardless, and what lands is ready. It is also the only refusal in the item
model that says anything out loud, because it is the only one where a player can
plainly see something in a square and plainly cannot empty it.

### A cast can take time, and what the caster brings past the requirements takes it off

`ArcaneStoneItem.castTimeMs` is what a stone costs *in front*, where the cooldown
is what it costs afterwards. Absent is instant, which is what every stone was
before this and what all but one still is. The shipped Stone of Flame is
authored at three seconds.

- **Nothing is spent until the bar fills.** The cooldown, the practice
  experience and the effect all land together in `resolveCast`, so a cast that
  is broken or that finds nowhere to land has cost the caster the seconds and
  nothing else. That is the argument a blocked conjure already made — a flame
  that never appeared is a press the player cannot tell from a dropped key —
  carried to the one case where they can plainly see why.
- **The scaling is a subtraction, not a curve.** `castDurationMs` reads
  `requirementCoverage` — `requirementShare` with the cap taken off — and takes
  the surplus straight off the clock: 110% of what the stone asks is 90% of the
  time, 150% is half, and double is instant. One subtraction because a player has
  to be able to hold it in their head while looking at the requirements grid, and
  because the figure is on the button's tooltip where a level-up visibly moves it.
- **That is what keeps a starter spell worth carrying.** Flame asks Arcane 5 and
  Fire 1, so it is three seconds the day you can first hold one and instant by
  Arcane 11. The spell does not get stronger, it gets quick. The stones at the
  top of the ladder ask thirty-odd points and stay slow for a long time, which is
  the whole shape of the trade — and it is why the cap belongs off this number
  and on `requirementShare`, where a weapon reads it.
- **A blow breaks it, and `uninterruptible` is the exception an author writes.**
  Cancelled from inside `applyDamage` on the same gate a pull is — `amount > 0`,
  so being bandaged mid-cast is not an interruption — and said out loud, because
  a bar vanishing is exactly what a *finished* cast looks like. Nothing else
  breaks one: a caster may walk, turn and be shoved while casting, and making it
  depend on standing still as well would be a rule nobody could guess at from
  watching.
- **Everything else is asked once, at the end.** `finishCasting` takes the run
  off the actor and then asks `castability` again, so a target who walked out of
  range, a target who died, a stone swapped to the other hand and a cell somebody
  has since dropped a crate on all come to the same thing: nothing happens, and
  the stone is still ready. The run is cleared *before* the question because a
  body recorded as casting refuses every square, itself included.
- **One cast at a time, and it refuses the whole row.** `CastContext.casting`
  carries only the clock — which stone is the session's business — so every
  button dims and comes back together, which is a picture a player can read
  without knowing which one started it.
- **A cast and a pull are one pair of hands.** Starting either takes the other
  off you, which is what keeps `ActorSnapshot.casting` and
  `ActorSnapshot.extracting` from ever being set at once and lets one bar draw
  both.
- **It holds the world awake.** `isAtRest` returns false while anybody is
  casting — the same clause a pull and a cooling stone have, and sharper than
  either: the cooldown has not been spent yet, so there is nothing else on the
  board that would have kept the clock running, and a world that slept here would
  leave the caster in a spell that never lands.
- **`advanceCastings` runs late in the tick**, directly after
  `advanceExtractions`, so a cast is resolved against the board the rest of the
  tick left behind: a crate dropped in front of the caster this tick is in the
  way of *this* flame rather than of the next one.

### The caster says the name of the spell

Every cast, timed or instant, puts the stone's name and an exclamation mark over
the caster's head — `recordSpeech`, so it is sanitised, pinned to the cell and
broadcast as chat like anything else anybody says. It is the one thing about a
cast that everybody nearby learns for free: the bar says somebody is doing
something, and the word says which spell, which is what makes standing out of the
way — or walking up and hitting them — a decision rather than a guess. The name
comes off the instance's description before the tile's, so a stone somebody has
written on says what they wrote.

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
caster, and health **actually restored** — so a mend at full health teaches
nothing from the mend. Damage to yourself pays nothing, or training would be
something you do to yourself in a corner.

**And every cast pays a small flat fee on top, whatever it was.** Outcomes alone
work for a swordsman, because every swing is aimed at somebody, and do not work
for a caster: a conjured flame does nothing measurable to anybody until
somebody walks into it, and a mend at full health does nothing at all. Paid on
outcomes alone a caster who has spent an afternoon lighting rooms has learnt
nothing, and the flat fee is what says otherwise.

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

### An element is a mastery, and three of them make a wheel

`fire`, `water` and `nature` are masteries like any other — they sit in
`MASTERIES`, so every block, schema, editor row and progress bar that walks that
list picked them up without being asked. **Arcane says how good you are at magic;
an element says what you point it at.** You get better at fire by throwing fire,
on the terms you get better at blades by swinging one.

Water douses fire, fire burns nature, nature drinks water. The wheel is three
because three is the smallest number where every element beats one and loses to
one, so none is the best and none is the worst.

**They are deliberately not weapon masteries**, and that exclusion is
load-bearing in exactly one place: `rating` counts a body's *best* weapon
mastery, so an element in that list would make a fire specialist read as a better
fighter than the identical caster who spread the same practice over three. Arcane
already measures how good a body is at magic and is already what every cast
trains.

#### A spell's elements are its requirements, and nothing else

A stone asking Fire 1 is a fire spell; one asking Water 8 and Nature 8 is both.
There is no second field naming an element, because what a spell *asks of you*
and what a spell *is* are genuinely the same fact — nobody throws fire without
having learnt some. `spellElements` reads it, and reads **every** element the
block names rather than the strongest, which is the whole of what "a spell can
have more than one element" means.

**Everybody starts with one point of each**, authored on the `player` tile and
seeded as experience like every other starting mastery. That is what makes an
element reachable at all: the requirement is an outright gate, so a body with no
Fire could never throw the spell that would have earned it. The bottom rung of
each element asks for exactly the point you begin with.

Those points are masteries and nothing else. They do **not** make a starting
player fire, water and nature — what a body is *made of* is a different field
entirely, and the `player` tile authors none of it.

An existing player is *not* reseeded — `hasExperience` gates seeding on the block
being absent, which is the property that stops a restored empty block wiping
somebody. So a body that predates this has none of the three and cannot cast the
bottom rung until `/mastery fire 1` says otherwise.

#### A body's element is authored and worn, never practised

`bodyElements` lives in `app/game/equipment.ts` beside `armorResistances`,
because it asks the same shape of question: **what a body counts as is what its
battler says it is, unioned with whatever it has on.** A cave troll is fire
because a cave troll is fire. A player is nothing until they put on a tunic of
flames, and is fire for exactly as long as they wear it.

**Masteries have no say in it, and that is the load-bearing part.** They were
briefly the source — a body counted as whatever element it was most attuned to —
and that is wrong twice over. It makes training the element you are best at the
thing that makes you weak to its counter, which is a progression that punishes
you for progressing; and it turns a rat that has somehow learnt a little Fire
into a fire creature by accident. What a body has practised says what it can
*cast*. What it is made of says what magic does to it. Two facts, two fields.

The two sources **union** rather than sum, because an element is a fact and not a
quantity: two flaming rings are not more fire than one. Only the four things a
body wears or holds carry one — weapon, armour, shield, stone — and **only the
squares, never the bag**: a tunic of flames in your pack is a tunic in a pack,
which is the same line `wornInstances` already draws for light and for what a
death leaves on the floor. The answer comes back in `ELEMENTS`' own order, so a
body that is fire and water is not a different thing for having swapped hands.

A stone's `elements` and its `requirements` are deliberately separate fields
answering separate questions — what carrying it makes *you*, and what the spell
*is*. An author who wants both writes both, on purpose.

#### The edge is half again, and its reciprocal

`EFFECTIVENESS_EDGE` is 1.5 and the wrong side of the wheel pays `1/1.5` rather
than a separately chosen figure. That reciprocal is what makes the arithmetic
cancel *exactly* for a body made of all three — `1.5 × ⅔ × 1` is one, not 0.999
— so "made of everything is made of nothing" is a property rather than a case
somebody wrote, and an author who ticks all three boxes gets told so in the
panel.

Multiplied **per element being defended**, and an advantage anywhere beats a
disadvantage everywhere: a fire-and-water spell thrown at a nature body takes
fire's edge rather than paying for nature's edge over its water. Paying both
would make breadth a liability, and a two-element spell already costs twice as
much to be allowed to hold.

#### The wheel turns on damage, and rides the thread `castBy` already cut

**Damage is the only thing it touches.** A mend has no second body in the
exchange for an element to be good against, and a status's *duration* is a clock
rather than a force — so what the wheel changes is how hard the fire actually
bites, in `GameSession.elementalDamage`, and nowhere else. Never below one point:
a resisted spell should land softly, not visibly do nothing.

A bolt thrown by hand reaches it by the shortest road there is — its elements are
read at the top of `cast` and handed straight to `elementalDamage`, after the
subject's armour has had the blow. Every other route to the same function is the
long way round the same corner: a status carries them, a conjured placement
carries them, and the tick spends them.

Getting the element there was the same journey `causedBy` already makes, with a
second passenger the whole way. A stone's elements are read once at the top of
`cast`; a status cast at somebody carries them onto the `StatusInstance`; a
conjure writes them onto the placement beside `castBy` (`PlacedTile.castElements`
— a placement field for the same reason `castBy` is one: the element is a fact
about the *spell*, and the same `arcane-flame` tile is what an ember stone and a
hearth both leave behind); `statusOnArrival` hands them back to the status; and
the tick spends them.

**An absent element is a neutral one**, which is the property to protect exactly
as it is for an absent cause: every hearth burn, venomous bite and berry in the
world behaves precisely as it did before any of this existed, and so does every
body nobody has given an element to.

#### Casting pays Arcane and the element, never one out of the other

Both the flat per-cast fee and the outcome payout go to Arcane *and* to each
element the spell is made of, at full rate on both. Splitting one pot between
them would make a fire specialist slower at magic than somebody pressing a light,
which is backwards for a global level. Each element is scaled by its own
requirement through `learningRate`, so a caster who has outgrown a stone's Fire
keeps learning from its Water.

The outcome payout is measured on what the wheel *made* of the damage rather than
on what the formula said, so a caster who picked the element the target is weak
to is paid for having picked it.

#### What is authored, so far

**Stones are a ladder of three rungs, climbed once per element.** Nine attack
stones. Each element climbs the same three rungs with a character of its own laid
over them, and the three characters come to the same rate — because an element is
what you point magic at rather than how good the magic is, so no element may be
the cheap one or the strong one. `casting.test.ts` asserts the ladder across the
elements as well as up each one.

| rung | fire   | water | nature  | damage | leaves       | cooldown | reach | asks               |
| ---- | ------ | ----- | ------- | ------ | ------------ | -------- | ----- | ------------------ |
| 1    | Cinder | Sleet | Barbs   | 5      | —            | 5s       | 3.5   | Arcane 5, elem 1   |
| 2    | Ember  | Frost | Thorns  | 10     | 30%, cut     | 7s       | 4.5   | Arcane 15, elem 5  |
| 3    | Pyre   | Rime  | Bramble | 15     | 75%, in full | 10s      | 5.5   | Arcane 33, elem 10 |

**The halves are the point of the reach numbers, not a rounding.** A reach is
compared squared, so a whole 3 admits the cell three along (9) and refuses the
one at (3,1) that is barely further (10). Every half-cell step opens a ring of
cells a whole one skips over, which is why `MELEE_REACH` is 1.5 and why these
are not 3, 4 and 5.

Those are **water's** numbers. Fire and nature are the same rung with a trait
applied, and the traits are the section below.

**Rung one asks exactly what the `player` tile is seeded with**, which is the
whole of "everybody can cast on their first day": Arcane 5 and one point of each
element are what a new body is authored to start at, and casting a stone is the
*only* thing in the game that pays element experience. If either half moves
without the other, an arcanist has no way to begin.

##### An element is a character, and the three come to the same rate

**Water is the rung as authored. Fire and nature are that rung times three
numbers**, the same three at every rung, so a player who has learnt what fire
feels like at the bottom has learnt what it feels like at the top.

| element | damage | variance | cooldown | reads as                        |
| ------- | ------ | -------- | -------- | ------------------------------- |
| fire    | ×1     | 60       | ×0.8     | fast and wild, never dependable |
| water   | ×1     | 25       | ×1       | the yardstick                   |
| nature  | ×1.2   | 25       | ×1.2     | slow and heavy                  |

There is no `earth` — the third element is `nature`, and it is the one a request
for "earth" means.

**The three come to exactly the same expected damage a second**, which is what
makes them characters rather than a ranking. That falls out of the arithmetic
rather than being tuned to it, and it is why fire's cooldown multiple is 0.8 and
not something rounder:

> A variance is a band that runs **downward** from the authored damage — see
> `combat.ts`'s `damageFraction`, which is `1 - spread + spread × peaked` — so
> the authored number is the ceiling and the mean is `1 - variance/200`. That is
> 0.875 at water's quarter and 0.70 at fire's three fifths. Fire's cooldown
> multiple is the ratio of those two, `0.70 / 0.875 = 0.8`, and nature's is its
> own damage multiple. Both cancel.

`casting.test.ts` asserts the parity, so a rung retuned on one element without
the others reddens rather than quietly making that element the best one.

**Authoring a fourth rung, or moving one.** Write water's numbers, then multiply.
Damage and cooldown both have to come out whole, which is what fixes water's
cooldowns at multiples of five: fire's 0.8 and nature's 1.2 of 7s are 5.6s and
8.4s, which are fine in milliseconds and would not be if the ladder were counted
in whole seconds.

**What is deliberately not a trait** is reach and requirements. An element that
threw further or asked less would be an element that was simply better, which is
the thing the wheel exists to prevent.

**The one advantage the parity does not capture** is that fire fits more casts
into a minute than nature does, so it rolls its status more often and earns its
element faster. That is fire's real edge, and it is paid for in never being able
to count on a number — which is the trade the whole table is making.

**The cooldown climbs with the damage, which reads backwards until you remember
there is no mana.** The cooldown *is* what a cast costs, so a deeper bolt has to
cost longer. It is also why the whole ladder now runs in seconds rather than in
the twenty-five to forty-five it used to: casting means putting your weapon down,
and a stone that took most of a minute to come back was a square you had given up
for nothing. Four to twelve seconds is short enough that a caster fights with the
stone rather than around it, and long enough that they cannot only cast.

**What the two upper rungs add is the element showing up on the target.** Rung
one is damage and nothing else — a first stone that already left something
burning would have nothing to grow into. Rung two lands its status thirty percent
of the time and cuts it short; rung three lands it three times in four and lets
it run the length the status def itself authors, so the top rung reads as the
same spell landing properly rather than as a different spell.

**Flame is beside the ladder rather than on it.** It asks what rung one asks, so
it is the first stone anybody presses, and it costs forty-five seconds — many
times the whole ladder — because what it leaves behind is a light source that
cooks, burns whoever steps in it, and outlives every attack stone's cooldown. It
is fire's utility, not fire's rung one; Cinder is that, so an arcanist has
something to practise Fire *with*.

**The two mends are the other direction of the same arm.** Verdance is the
two-element example — a mend of twenty asking Water 8 and Nature 8, elemental in
what it trains and never weighed, because a mend has nobody on the other end of
it — and it now comes back in thirty seconds so it is a decision inside a fight
rather than once per fight. The Necklace of Life is no longer `automatic`: a
charm that spent itself the moment you were scratched was a charm that was never
ready when it mattered, and pressing it is a decision. Nothing shipped is
automatic now, and `automaticFires` stays for authors who want one.

**Bodies.** The snake is nature and the cave troll is fire. Everything else —
rat, wolf, deer, cat, shopkeeper, and the player — is neutral, which is the
honest default: a rat is not weak to anything, and nothing here makes it so.

**Things to put on.** Tunic of Flames, Mantle of Brambles and Amulet of Tides:
one garment per element, so all three arms of the wheel can be stood on by a
player as well as met in a creature. They are `def 2` chest pieces and a `def 0`
charm — the def is incidental, and the point of them is that an element becomes
something you can *decide*. Wearing one is a trade rather than an upgrade: a
tunic of flames is two points of armour and a standing invitation to anything
made of water.

Both halves are authored through **one control** — `ElementFields`, on the Battle
tab for what a body is and under the item type for what wearing it makes you —
because they are the same decision asked of two objects, and it says out loud
which way round the wheel runs.

### The interface is absent for almost everybody

One button per non-pressed stone, above the direction pad on a phone and in the
side column on a desktop, in square order, showing the stone's own sprite and an
arc around its rim counting its cooldown down. **The row is absent entirely for a
body carrying no stones** — not empty, absent — which is the whole reason casting
could be added to a layout already carrying a mode strip, an interaction list, a
chat bar and a pad. An automatic charm gets no button, because there is nothing
to press.

Casting is server-authoritative with no prediction, exactly as attacking is: the
client sends "cast the stone in this square" — a square, never an instance id —
and dims from the kit it is sent back.

#### A stone with nobody targeted looks usable, and says so when pressed

The button had two appearances, lit and dimmed, and dimming stood for every
refusal at once. That is right for a stone you cannot use and it was wrong for
the commonest reason a stone will not fire: **nobody is targeted is not a fact
about the stone.** A player looking at a greyed row concluded the spell was
broken or still cooling, and went and stood somewhere else. There are now three:

- **Ready** — solid rim, full brightness.
- **Cooling** — dimmed, with the arc. The one refusal that ends by itself, and
  the only one worth a picture, because the picture *is* how long is left.
- **Unavailable** — dashed and faint. Not learnt yet, out of range, nothing in
  the square: a player can do nothing about any of them from where they are
  standing, so they stay collapsed into one appearance and the tooltip says
  which.

A `noTarget` refusal wears the ready appearance and the press goes through to the
session, which refuses it and answers with a sentence — see `castRefusalNotice`
in `app/game/notices.ts`, and the notice section below for why that is the right
shape for a refusal with no picture. **It is the one sentence the client composes
for itself**: online the message is never sent, so the server has nothing to say
about it, and both sides read the wording out of the same file.

The button is round, which is an exception to the house rectangle stated at the
same weight the direction pad's is — see `spell-disc` in `app/app.css`. An arc
wants a rim to run along.

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

## A receipt floats for a mend, and only for health that went in

Damage has had a number rising off it since the beginning and healing had none:
a bandage, a mend stone, a `fed` status doing its work and the `/health` command
all moved a health bar and drew nothing. The only way to know any of it had
happened was to have been watching the bar.

`applyHealing` is the mirror of `applyDamage` and exists because there were four
of it — each of those four clamped at full health with its own two lines, and
none floated anything. One function, one clamp, one number.

**What actually went in, not what was offered.** A body one point short of full
offered five gains one, and one is the figure: a receipt is for what happened to
*this* body. A call that restored nothing is silent — no number, no element, and
nothing on the wire — so a full health bar under a charm or a `fed` says nothing.
That is the difference between a number meaning "this happened to you" and one
meaning "something was offered", and only the first is a thing a player can act
on.

`heal` is a third `SwingOutcome` rather than a layer of its own. The channel has
always been "something happened to this body on this tick" — the name is the case
it started as — and a second mechanism would drift in placement, lifetime and
rise from the numbers it is meant to sit beside. `SWING_OUTCOMES` carries it onto
the wire, which is the boundary a union cannot validate on its own.

**Two things say it, not one.** The colour is a light green, the one hue left in
that layer, and it is green *whoever* it happened to — unlike a blow, where red
exists because your own hit points are what you cannot afford to miss while
reading the traffic, and there is no equivalent fear about being healed. The text
is signed, `+5`, so a reader who cannot separate green from white still knows
which way the bar went.

### A cooling stone looks stuck, and says so when it will not move

A cooling stone is locked in its square — the whole reason cooldowns are per
stone — and the interface said so in exactly one place. Dropping one on the floor
answered with a sentence; dragging the same stone into a bag answered with
nothing, and the square looked like every other square with something in it.

The square is now drawn dimmed. **Dimmed rather than dashed**, because dashed is
what an empty square wears and this one is conspicuously not empty: what it has
to say is that the thing you can plainly see is not yours to move. The screen
reader gets the same fact in words, in place of the press hint — which while a
stone is cooling is not true, since a press still *uses* the thing.

The silent bag move was a gap between two gates. The drag is refused
client-side, so no square lit up, and a release onto no lit target fell through
to a world drop that found no cell under the panel — which meant `moveItem`'s
`noteCoolingRefusal`, the one gate that speaks, was never reached. A release over
a square now hands the move on whether or not that square lit up, and the session
answers. Everything refused for the ordinary reasons is still refused in silence,
which is right: "your hand is full" is a thing the player can see, and this is the
one refusal that is invisible.

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
the runtime a death deleted. The reply is a whole `hello`: a silenced socket has been
receiving nothing for as long as its owner sat on the screen, so its map is
arbitrarily stale and no diff would catch it up. Reloading still works and still does the same thing through
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

### Every weapon sits on one ladder, and the rungs step by half again

Requirements used to be picked per weapon, which produced a shape nobody had
intended: 5, 6, 8, 20, 20, 22, 34, 34 on Sharp. Two weapons a point apart at the
bottom and a fourteen-point cliff in the middle is not a progression — a new
player swaps a rusty sword for an iron one before they have noticed the rusty
one, and then swings it for the rest of the game because the next rung is out of
sight.

The rungs are now **5, 10, 15, 22, 33, 50** — half again each step — and a
weapon's primary mastery is which rung it stands on. Heavy weapons add a
secondary requirement rather than a rung of their own: axes, mauls and the
greatsword ask Toughness, and daggers will ask Agility when they exist.
`requirementShare` pools those, so the axe path and the sword path arrive at
different moments even where the pooled totals match.

**A constant ratio is the point, because `learningRate` is a function of the
ratio.** A constant *difference* — 5, 10, 15, 20 — shrinks in relative terms as
you climb, so the outgrown falloff bites hardest on the first rung and barely at
all on the last. On a half-again ladder the weapon below is worth a near-constant
~40% at the moment the next one becomes worth holding, at every level:

```
              5->10  10->15  15->22  22->33  33->50
  ratio        2.00    1.50    1.47    1.50    1.52
  left at 90%   17%     41%     43%     41%     39%
```

`OUTGROWN_FALLOFF` moved from 6 to 3 to go with it — see the table in
`app/lib/mastery.ts`. At six, `5 -> 10` cost 6364 raw experience against 2025 for
`15 -> 20`: three times the work on the rung a brand new player is standing on.

**You adopt the next weapon at about 90% of what it asks, and that falls out
rather than being arranged.** Scanning the crossover — where the next sword
actually out-damages the one below against a fixed foe — puts it at 90–95% of the
new requirement, and it stays there whatever `REQUIREMENT_FALLOFF` is set to,
because on a ladder this tight you are never more than a few points short and the
cube barely bites. That is why the cube was left alone: the behaviour people
wanted from it comes from the ladder.

Measured on the wolves, a player upgrading as each sword becomes worth holding
picks up the iron sword at fight 12 and the knight's sword at 18, and reaches
Sharp 27 by fight 120 where the old requirements left them at 12.

### The sentence, and why it was wrong

Requirements went through three shapes. First a panel under the hand slot
listing every mastery against the one you had — "Sharp 3 / 5", the worst in red —
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

### The gate is one section of a card

The lines `weaponDemand` produces are what the world's look label says, over the
canvas, in the pixel font. Inspecting a slot gets the same facts plus the rest of
the profile, as a card: `app/game/itemCard.ts` computes it and
`app/components/ItemCard.tsx` draws it. Damage, the wait between blows, the
chance of landing one, the spread, the reach, every requirement against what you
have, the share of the weapon that comes to, what a blow leaves behind, and for
worn things the kinds of blow they turn aside.

The card exists because the gate is not the only question. Somebody holding two
swords wants to know the difference between them — not which is better, which is
what the fighting settles — and there is no way to separate a fast light blade
from a slow heavy one without giving both numbers.

Four rules keep it from becoming the requirements panel that was deleted:

- **Nothing volunteers.** The equipment panel at rest is a grid of squares. The
  card only exists while somebody holds a slot with the eye on, or rests a finger
  on one. Chrome that ranked your swords unasked would answer the only question
  the fighting has to offer.
- **Every figure is the reader's, with the item's own struck through beside it.**
  The card runs the item through the same `fightingStats` a swing uses, so a
  greataxe you cannot lift reports 4 damage rather than 17. Printing the authored
  numbers would make it a catalogue entry; printing yours makes it about you.
- **It computes nothing.** `itemCard` calls `fightingStats`, `swingIntervalMs`,
  `requirementShare` and `weaponReadiness` rather than restating them. A second
  definition of what a weapon is worth would diverge the next time somebody
  changed the falloff. The mastery rebalance replaced every formula underneath
  and the card needed no arithmetic changed.
- **A row is a caption and a figure, not a sentence.** `dmg 12`, `def 4`,
  `hp +5`, `every 1.2s`. The rows used to read "Blocks — 1 a blow" and
  "Restores — 5 health", which spend a verb and a noun getting one number
  across; six of those are a paragraph the reader has to take apart before they
  can compare two swords. A worn thing's kind line is the caption on the square
  it goes in — "Armour", "Head", "Footwear" — matching
  `app/components/EquipmentPanel.tsx` exactly, rather than "Worn on your body",
  which made the reader match a sentence to a picture.

  What a poison costs is signed rather than worded — `hp −6` against `hp +5` —
  on the terms `damageNumbers`' mend sign is: colour alone leaves a reader who
  cannot separate the two hues with a bare figure. The abbreviations do not
  survive being read out, so `ItemCardStat.spoken` carries the word for the
  route that speaks the card, and `speech` says "Damage: 12" where the drawing
  says `dmg 12`.

Each item kind reports what it has and nothing else. A weapon has a profile, a
gate and a share; armour has a defence figure and a resistance table but no
share, because it has no requirements to meet; a shield has the one defence
figure; a stone reports what it moves, on whom, its cooldown and its reach, and
its requirements without a share, because an unmet requirement refuses a cast
rather than weakening it; a charm reports what each tick puts back and how often
a tick comes, because the interval is the whole of what a charm costs. An
artifact reports nothing at all: it is the kind with no fields, and everything it
does it does by being a placement.

A resistance row shows the **total** a blow of that kind loses — `def +
resist[kind]` — with the flat number struck through beside it. A bare "+3" has to
be added to a figure further up the card before it means anything.

The card is portalled through `app/ui/Tooltip.tsx` rather than positioned inside
the slot button. On a phone the panels sit in an `overflow-y-auto` column, which
makes `overflow-x` non-visible too, so a card anchored on the leftmost square was
clipped at the panel edge. Measuring the rect and nudging it back fixed that
horizontally; a portal has no clipping ancestor at all, and Base UI flips and
shifts it into whatever space exists on both axes.

### A notice is a sentence with nowhere else to go

The bottom of the view carries at most two lines of white text — "Your sharp
mastery is now 10", "You open Quest Chest and receive 1 Hand Lantern, 1 Rusty
Sword" — and they are prose for a fact
that has no picture. Three kinds qualify. Something crossed a threshold you were
not watching, so the mastery bars mattered for one frame while you were looking
at a rat. Something happened that the board deliberately does not show — a reward
leaves the chest full and the map untouched, so the only evidence is a line item
in a bag you may not have open. Or something you asked for did not happen — "You
cannot fit there", "Your inventory is full", "Select a target first" — and a
refusal that shows as *nothing occurring* is indistinguishable from the input
being dropped. Everything else already has a better telling: a blow is a number
off a head, a status is an icon in the strip. Reach for a notice when there is no
picture, not when a picture would be work.

That last one is the rule stated as a decision rather than a principle.
`castRefusalNotice` says a sentence for exactly one of the six ways a cast can be
refused, and returns null for the other five — because the spell button draws
those five and deliberately does not draw this one. **A sentence on top of a
picture is the game repeating itself at whoever is mashing a key.**

There are no levels in this game, so a notice must not name one: "Your sharp
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
The verbs are `/mastery`, `/tile`, `/status`, `/health`, `/goto`, `/move` and
`/time`; `COMMAND_USAGE` in `app/game/commands.ts` is the grammar of each, and
is the line a player is shown when they get one wrong.

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

### `/goto` is absolute, `/move` is relative, and that is why they are two

`/tile` spells the difference between a cell of the map and a step from where
you stand *inside* an argument: a bare number is a column, a signed one is an
offset. That works there, because a tile is usually put down near you and both
readings are wanted in one line.

**Going somewhere is not like that, and the first version of this got it wrong
by copying it.** A destination is nearly always absolute, and nearly every
coordinate on this map that anybody wants to reach is negative — the city runs
from `x = -45` and the goblin field sits at `y = -55`. Under the sign grammar
`/goto -11 -55` did not go to the goblin camp; it went eleven west and
fifty-five south of wherever you were standing, and *no* absolute negative could
be written at all. A teleport that cannot name half the map is not one.

So the verb carries what the sign used to. `/goto -11 -55` is a place, `/move
-11 -55` is a distance, and neither has to spell which inside an argument. It
costs two commands instead of one and it is worth it: the alternative is a
third spelling — a `~` prefix, an `=` prefix — that has to be learnt, explained,
and then applied to `/tile` as well to stay coherent.

`/tile` keeps its own grammar and this is deliberate. Two ways of writing a
coordinate is a real cost, but the argument for changing `/tile` is much weaker
than the argument for changing this was: it is pointed at things near you, where
the offsets are what you want anyway.

**The level may be left off, and then means the one you are on.** By far the
most-omitted argument, since most of the world is one storey — and defaulting it
to the ground would send somebody who typed two numbers to a different floor
than the one they were looking at. `/move 0 0 -1` is the storey below.

**Where they may put you is a stricter question than where a portal may.**
`teleportFits` asks about volume — is there room in the column for a body this
tall — which is right for a destination an author placed and pointed at, and
wrong for one somebody typed. It says yes to a cell with nothing underneath and
to one another body is already standing in, so the first version of this put a
player inside a deer and then off the edge of the world. `canStandIn` asks what
the walk loop asks instead: a standing surface at that level, the body fitting
with its feet on it, and other bodies counting as walls.

Both verbs land through one `putBodyAt`, which moves with `moveThrough` — the
same one a portal makes — so a body that walks somewhere and a body that types
its way there end in one state and the client animates both the same way.

**Neither is reachable in `/play`.** Commands are typed into the chat field and
`/play` never passes `onSay`, so single-player has no chat and therefore no
commands at all. That is true of `/tile` and `/health` too and predates these;
it is worth knowing before going looking for the field in single-player.

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
- **A count is written `x12`, and only ever directly after the tile.** It means
  *run the placement that many times*, not "make a pile that big": a hundred
  shards is a full pile of ninety-nine and one beside it, a hundred crates is a
  hundred crates until the column runs out, and either way it is the same rule a
  single `/tile` is under said N times. Sharing the first argument's place with
  a coordinate is safe because no coordinate can begin with a letter — but only
  in that position, so `/tile apple +1 x5` is refused as the coordinate `x5` is
  standing in the place of, which is the honest reading. `MAX_TILE_COUNT` is a
  sanity bound at 999 rather than a pile's ceiling.
- **All of a count or none of it.** The whole stack is built against a candidate
  map before any of it is committed, so a count that runs out of room leaves the
  cell exactly as it was. Half a command carried out is the one outcome nobody
  could act on, and it is the rule a trade already keeps. It is also why
  `summonedOwnerId` takes the names this same command has already minted: with
  nothing adopted until the end, the runtime cannot see a clash inside one
  `/tile wolf x3` for itself.

### `/time` moves the world's clock, for everybody

`/time 18:00` puts the whole world at six in the evening. The hour belongs to
the world rather than to a body, so there is no target and nothing to refuse
beyond a time that does not parse.

- **The session only queues it.** `GameSession` has no clock — time of day is
  `minutesOfDayAt(Date.now())`, which the server reads — so `runTimeCommand`
  records the hour and `drainClockSet` hands it to `GameServer.flushClock`.
- **The server keeps an offset, not an hour.** `clockOffsetMinutes` is added to
  the wall-clock reading, so the clock still runs through hibernation without
  being ticked or checkpointed. It lives on `GameServer` rather than the session
  because a session is replaced on eviction and on every content save. Nothing
  persists it, so a deploy puts the world back on the wall clock.
- **It needs its own message.** A client anchors its clock once, from `hello`,
  and runs it forward itself; a server that only moved its own clock would be
  seen by nobody until they reconnected. `clock` is broadcast to every socket,
  and `RemoteSession` also re-announces the hour on every `hello`, so a renderer
  that outlives a rebirth picks up the hour it missed while dead.
- **It says the hour back.** Moving within the day plateau (09:00–16:00) or the
  night plateau (19:00–04:00) changes nothing on screen, so a silent success
  would read as a dropped command.

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
  (`transmute:<ref>:<index>`) because one placement offers several. It is also
  why `groupInteractionOptions` — which gathers the rows about one thing into
  one box, so a sprite and a name are drawn once however many verbs they carry —
  groups by the *subject* rather than by the placement: a fire offering to cook
  meat and to cook fish is two boxes, and one box would have to pick one of the
  two sprites to lie with.
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

## Food piles, and so does an artifact that is only ever counted

A pile is a `count` on an `ItemInstance` or a `PlacedTile` (`app/lib/piles.ts`).
There is no pile type, no container to open and no second model of a thing: a
pile of twelve berries is one instance with one id, so every rule already written
about carrying, dropping, rotting and looting one berry applies to twelve without
knowing it. Twelve berries on a tile are one placement, not twelve — a stack is
things standing on each other, and nothing in a pile is standing on anything.

**The cost is that the twelve become interchangeable.** They share one id, one
description and one clock, and there is no way to ask which one you ate. That is
the whole reason so little piles: two swords are two swords with two histories,
and a count would be a lie about them. `pileMax` (`app/lib/item.ts`) is the one
place that is decided — a sword answers `1`, so a pile is a count everywhere and
never a special case. The size is authored per tile (`ConsumableItem.pile`,
twelve berries against three loaves) and defaults through `pileOf` rather than
through the schema, on the same grounds `reachOf` does: the tile editor works on
the raw authored block, so a default the schema filled in would be invisible in
the one place somebody is choosing the number.

**An artifact piles too, but only when its author writes the number.**
`ArtifactItem.pile` exists for a currency — fourteen shards in fourteen squares
is a bag nobody can trade out of — and it defaults the *other* way from food's:
absent is one. Every artifact in the file predates the field, and a torch, a
key or a signpost that quietly started heaping would be the default deciding
something about content nobody had reread. So food gets a handful for nothing
and an artifact gets nothing until asked; `pileMax` is where both sentences are
written, and `itemForSave` drops an artifact's pile of one so the file has one
spelling of the default.

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

**An extract's yield does pour**, and it is the counter-example that says what
those two gaps actually cost. It could because it has one destination and no
landings list, so its check and its run are literally the same call —
`stowExtracted` (`app/game/extract.ts`) builds the contents a pull would leave
and hands back null when it will not fit. There is no second arrangement to
disagree with the first, which is exactly what `landingsFor` would have to become.

### A drink leaves its bottle, and the bottle has to fit

`ConsumableItem.leaves` names the tile left behind when a consumable is used —
an `empty-bottle` for a potion. A potion is two things and drinking spends one
of them; for as long as nobody wanted the glass back, letting it vanish with
the draught was fine. A merchant who buys bottles is exactly somebody who does.

- **A tile id, not a flag**, because what is left is content like anything
  else: it needs a sprite, a name and a pile of its own, and a second tile is
  the only thing that has those. An id the catalogue no longer holds reads as
  leaving nothing, on the terms a status nobody authored does.
- **Nothing ever reaches the floor from a kit.** `app/game/residue.ts` tries
  the place the drink was — that bag, that chest, that hand — then the worn
  bag, then the off hand, then the weapon hand; `placeInSlot` (`itemMoves`)
  asks each on exactly the terms a drag would. It is asked with the drink
  already gone, so the square the last potion vacated is the one its bottle
  lands in and a bottle pouring onto bottles needs no square at all. A hand
  still holding the rest of a pile refuses and the search moves on.
- **A drink drunk where it lay leaves the bottle where it lay**, through
  `stackWithItem` so a second bottle joins the first, gated by
  `canReplaceStack` like a body dying holding things. A floor meal never
  entered the bag and neither does its glass.
- **Nowhere to put it is a refusal with a sentence.** Every other consume
  refusal is a row that was never offered; this one is a fact about the kit
  the row cannot see — the potion is right there — so silence would read as a
  broken potion. `noRoomToLeaveNotice` names the tile, and the potion stays
  exactly where it was: the residue is placed before anything is written.
- **The client is not told in advance.** `RemoteSession.consume` mirrors the
  server's gates for the floor and slot arms and knows nothing about residue,
  so the row is offered and the server refuses with the notice. A pre-check
  would put the residue search on every frame that lists the options, for a
  refusal that is rare and already explained.

## An extract is a pull you are part-way through, and it can be taken off you

`interactions.extract` is the third arrangement of "this tile gives you
something", and it is the one a *resource* wants: a crystal you mine, a bush you
pick. Read it against the two beside it, because the whole design is the
contrast.

|            | who it is spent by      | what runs out              | what stops you        |
| ---------- | ----------------------- | -------------------------- | --------------------- |
| reward     | one player, once        | nothing on the board       | a tag on you          |
| transmute  | anybody, repeatedly     | nothing on the board       | your bag              |
| extract    | everybody, together     | the placement's durability | anything that moves or hurts you, or a spell you start |

- **The cost is paid in front, not after.** A tap buys a place at the vein and
  nothing else: `durationMs` runs while the player stands there, and only when
  it finishes are the dice thrown and anything handed over. This replaced a
  cooldown charged *after* a pull that landed instantly, which made a rich vein
  a thing to tap and walk away from. Paying in front makes it a thing to hold a
  room for — you clear the cave and then mine it, or you bring a friend.
- **A pull ends the moment its owner does anything else.** Standing still is the
  whole rule and it is checked as one thing rather than as a list of the ways a
  body can move: `holdsExtraction` compares the actor's cell against the one
  they started in, so a step of their own, a shove and a fall are all covered by
  one comparison and nothing new can slip past it. Beside that: `!idle`, so a
  motion that has been asked for but not committed already counts; the resource
  itself, re-asked every tick, so a bush that turned into a picked bush or
  disappeared under a crate takes its own pull away; and a blow, which cancels
  from inside `applyDamage` rather than on the next tick. Nothing is handed over
  and the reservation goes back in the vein.
- **`advanceExtractions` runs late in the tick**, after the bodies have moved
  and after `applyDueDecay`. It is the one clock whose right to continue depends
  on what the rest of the tick did, so winding it beside the swing cooldowns —
  where it started — gave a player who stepped away one more tick of progress
  and noticed a rotting bush a tick late.
- **Two people may work one vein; three may not take four pulls out of three.**
  A pull being made is held out of the shared count as
  `PlacedTile.extractsReserved`, and what somebody walking up may still start is
  `extractsLeft − extractsReserved` (`pullsFreeAt`). Anything less would let
  four people each start the last pull of a one-pull crystal and leave three of
  them fourteen seconds poorer for nothing.
- **The reservation is on the placement for exactly the reason durability is.**
  The rule is not "runtime state stays off the map" — it is *who has to agree
  about it*, and everybody standing at the vein has to see the same number, so
  it rides the cell patch for free. It differs from durability in one way and
  it is the important one: it is **not durable**. A reservation says somebody is
  standing there *this second*, and nobody is standing anywhere in a checkpoint,
  so `clearExtractReservations` wipes the field as the world loads. Left in, a
  world that went down while three people were mining would come back with three
  pulls held for ever by nobody. `authoredPlacement` strips it on the way to
  `data/map.json` alongside `extractsLeft`, one step further along the same
  argument.
- **Durability is on the placement, and a decay deadline deliberately is not.**
  Everybody has to see the same vein, so it rides the cell patch and the
  checkpoint, exactly as a chest's `contents` do. A decay deadline is nobody's
  business but the session's, which is why that one is held beside the map.
- **A fresh placement carries no number at all.** `extractsLeft(placed, extract)`
  falls back to the def's `durability`, so a map full of untouched bushes costs
  the file and the wire nothing, and the field only appears once somebody has
  taken from one. It is clamped to the def as well, so lowering `durability` in
  `tiles.json` shortens every vein in the world including the ones already
  started — the def is the authority on what a thing is worth.
- **One pull per person.** `ActorRuntime.extraction` is a single value, not a
  map: a person mines one thing at a time. Tapping a *different* vein abandons
  whatever was running rather than being refused, because a player who taps a
  second crystal has said which one they want and a refusal there would have
  nothing on screen explaining it. Tapping the one already running is refused —
  that row is drawing their bar, and restarting it would be a way to never
  finish.
- **The yield is a drop table, on a kit's terms.** Up to `MAX_EXTRACT_SLOTS`
  slots of `{tileId, chance}`, each drawn for independently, on the same percent
  scale and with the same fixed-draw-count discipline `KitEntry` argues for.
  "One to three berries" is three berry slots at descending chances; "nothing, or
  a shard" is one slot. Every slot is drawn for every time whatever has already
  come up, because a skipped draw would make one player's luck change what the
  next creature in the world rolled.
- **Room is checked against the best possible roll, never the actual one.** The
  roll happens at the *end* of the pull and room is asked about at the start, so
  room is found for every authored slot. All-or-nothing on `rewardFits`' terms
  and for a sharper reason: a pull spends shared durability, so anything that
  would not fit would have been destroyed on everybody's behalf. Nothing an
  extract yields is ever dropped on the floor. The bag can move during the
  fourteen seconds; `giveExtracted` finding no room then is a race, and it
  refuses rather than inventing somewhere to put things.
- **What comes out pours.** The bush yields berries and berries are what pile, so
  a check that counted empty squares would refuse to pick one because you were
  already carrying some. `stowExtracted` is *both* the check and the run — see
  the counter-example under "Food piles" above — so the arrangement that allowed
  the row is the arrangement the pull produces, and there is no second one to
  disagree with it. `MAX_EXTRACT_SLOTS` is four because that is what the largest
  bag holds with nothing to pour into.
- **A finished pull is spent whatever came up.** A crystal that yields nothing on
  a bad roll has still been chipped at — the seconds went into the swing, not
  into what came out of it.
- **Regrowth is deliberately not authored here.** `tileId` hands the spent
  placement to machinery that already exists, and there are two answers because
  there are two shapes: a bush becomes `picked-bush`, and the *picked bush*
  decays back into a bush; a crystal names nothing, so the placement is removed
  and its own `respawn` spawn point notices the empty cell. A third countdown in
  this block would be competing with two that work.
- **No new inbound message.** A resource is reached by a plain tap, so
  `GameSession.interact` routes it — below every authored swap, above everything
  to do with carrying — and there is no `PlaySession.extract` that could disagree
  with that precedence about what a tap does. A transmuter needs its own verb
  because one placement offers several recipes; a bush offers one thing, which is
  the bush.

### What the arcane caves are tuned to

The three crystals are the whole of what this exists for, and the levels are
what tell them apart: **every crystal on -1 is small, every one on -2 medium,
every one on -3 large.** Deeper is richer and slower, and a player can tell
which is which by which floor they are standing on rather than by looking.

| tile               | uses | one pull | yield slots           | shards per pull |
| ------------------ | ---- | -------- | --------------------- | --------------- |
| `arcane-crystal-1` | 2    | 2.5s     | 40%                   | 0–1             |
| `arcane-crystal-2` | 3    | 6s       | 70, 50                | 0–2             |
| `arcane-crystal-3` | 4    | 14s      | 100, 100, 60, 40      | 2–4             |

The small one is quick and swingy — something to chip at while you are passing.
The large one is the point of the mechanic: fourteen seconds of standing still
is long enough that anything alive in the room will reach you, and it never pays
nothing, so it is worth clearing the room or bringing somebody to watch the
door. This is only how *these* caves work; another dungeon is free to want
something else.

### The row greys rather than vanishing whenever the refusal is not about the world

**A missing row and a greyed row are different facts, and the list has to say
which.** A refusal in `listInteractionOptions` that is about the *world* removes
the row — an emptied chest, a recipe you cannot pay for, a crate out of reach —
and that is right, because all of those say the same thing: there is nothing here
worth walking up to. Anything else is not that. The bush is still full and still
worth crossing the field for; it is the player, or the room, that is not in a
state for it, and a row that vanished under them would read as a broken bush
rather than as something they can go and fix or wait out. So the row stays, goes
grey, and says what is in the way.

Three of those exist, and `InteractionOption.blocked` carries any of them:

| `OptionBlock` | what is in the way | how the row says it |
| ------------- | ------------------ | ------------------- |
| `working`     | this player's own pull, running | a bar filling across the verb |
| `noRoom`      | nothing they carry could hold the yield | "no room" beside the verb |
| `taken`       | every pull left is somebody else's | "in use" beside the verb |

That split is what `extractOfferedAt`, `canExtractFrom` and `canBeginExtract`
being three functions is for. The first is the board's answer alone — reach and
pulls left, ignoring reservations, so a vein everybody is working still draws a
row. The second adds room and a free pull, and is *permission*: what the session
reserves against and what the server believes. The third adds "not the one you
are already on", and is what the client's own tap asks.

- **They are ranked, and the order is what makes each answer worth reading.**
  The pull in progress first, because that is what the row is drawing and
  everything else is beside the point while it runs. Then the bag, because that
  refusal stands until the player goes and fixes it. Then the reservation, last,
  because it is the only one that resolves itself — "in use" while the bag is
  full would be pointing at somebody else's problem instead of theirs.
- **A row carrying any of them is not actionable**: `topInteractionAt` passes
  over it, so the pointer outlines nothing and a click on the world does nothing;
  `applyInteraction` refuses it; and the button is `aria-disabled` with the
  reason read out after the verb. Four refusals for one press is the spell bar's
  discipline, and it is why the grey is not a lie.
- **`noRoom` is one arm for two states** — a full bag and no bag at all — because
  they are one fact to the player, who can see which by looking at what they are
  wearing.
- **The field is not extract-shaped.** Nothing else uses it yet, but the next
  mechanism that tells a player "not you, not now" should add an arm here rather
  than inventing a second way to be grey.
- **The bar is a CSS keyframe with a negative delay** (`fill-progress` in `app.css`),
  given the whole `durationMs` and started `durationMs - remainingMs` in. That is
  the whole reason a row with a pull on it costs nothing: the browser runs it on
  the compositor, React is not re-rendered between the pull starting and ending,
  and a row rebuilt mid-pull picks the fill up where it already was rather than
  restarting it. `extractionElapsedMs` clamps both ends, because the two numbers
  arrive separately and nothing forces them into a ratio.
- **The renderer's option key carries the *kind* of block and never the
  remainder.** A key with the number in it would hand React a new list thirty
  times a second to redraw a bar CSS is already animating; a key without the kind
  would never tell it the row had gone grey at all.

### The pull in progress is a per-player channel, sent twice a pull

The client is told on exactly the terms it is told its tags: a `Set` of changed
actor ids drained out of the session, a whole-state message to the one socket it
is about (`extracting`), and the same value on `hello`, because a reconnecting
player's pull is still running on the body they left.

- **Two messages a pull and none in between.** Both halves of the fraction
  travel — `remainingMs` and `durationMs`, the pairing `StatusPatch` makes — so
  the client has everything it needs to draw the bar filling without being told
  where it is. `advanceExtraction` announces only a start and an end.
- **The value is wound in place, and the snapshot holds the runtime's own
  object.** `setExtraction` replaces it only when a pull starts or ends, so its
  identity is the change signal the renderer gates its whole interaction list on,
  and a tick advancing a pull costs no allocation and no rebuild. The same
  hand-over-by-reference a `walk` or a `strike` already travels on.
  `RemoteSession.windBars` does the same against the render clock — which
  is not a prediction of anything, since only the server's message ever clears
  it; it keeps the *number* true between the two messages.
- **Whether a vein is free travels on the board**, as the reservation on the
  placement. A cell patch already goes to everybody, and a client that knows the
  vein has nothing free knows enough to grey the row.
- **That somebody else is pulling travels in the shared patch, without the
  key.** A deer at a bush or another player at a vein gets a white bar over its
  name (`WorldLabel.progress`, drawn by `WorldLabelLayer` above the name line —
  so only on bodies that have a name tag, which is battlers). `ActorSnapshot`
  carries the runtime's `Extraction` by reference, and
  `GameServer.diffExtractions` sends an `ExtractionPatch` whenever that identity
  changes: a start and an end, the same two messages the owner gets. It goes in
  the tick patch rather than per socket because it is the same bytes for
  everybody. The key is left off because only the owner's row matches against
  it, and the diff does not read `drainExtractionChanges` because that queue is
  the owner's.
- **A cast is the same picture on a second channel.** `CastingPatch` is
  `ExtractionPatch`'s twin, diffed by identity the same way and drawn by the same
  bar, and `app/game/progress.ts` is the two numbers both of them are — a third
  module because `casting` and `extract` cannot import each other. Two channels
  rather than one field because a body can be told to stop pulling and to start
  casting in the same patch, and one field would be a message arguing with
  itself. Nothing about a cast is addressed to its owner: there is no key and no
  row, and which stone it came out of is not drawn, so what the owner needs — the
  whole row dims — is in the broadcast they are already in.
- **Not durable.** `hp`'s bargain rather than a tag's: a tag records that
  something *happened* and can never be rebuilt, where this records something
  that is happening, and a world that has gone quiet is a world where nobody is
  standing at the vein any more.
- **It holds the world awake.** The pull is wound by the tick loop and by nothing
  else, so `isAtRest` returns false while any actor is making one — exactly the
  clause a cooling stone has and sharper, because somebody is standing there
  waiting to be paid.
- **The key is cell-plus-tile**, `decay`'s `entryKey` and not the stack index,
  for its reason: an index shifts the moment anything is placed under or over it.
  Including the tile id is also what makes "the thing you were working stopped
  being that thing" a check rather than a special case, and it is what stops a
  reservation being handed back to whatever tile replaced the one it was taken
  from.

## A brain can name a place, work it, and eat what came out

Everything a brain could name used to be a *body* — `nearest` walks the actor
list, and nothing is ever standing on a bush. So a creature could hunt you,
flock, flee and go and look at a noise, and could not walk up to a bush. Three
pieces closed that, and the point of all three is that they are the pieces a
player already uses rather than a parallel set for animals.

- **The `thing` selector names the nearest *placement* of a tile.** `nearest`'s
  opposite number. It answers a cell and a tile id, never a stack index, which is
  `extractKey`'s pair and is here for its reason: an index shifts when anything
  is placed under it, and what should end a commitment to a bush is the bush
  ceasing to be a bush. A deer that picked one bare is holding a cell that now
  reads `picked-bush`, so `out_of_los $bush` fires with nothing authored to
  notice it.
- **The blackboard holds a body *or* a place**, as `Bound`. That is what makes a
  bush a commitment rather than a question re-asked every tick, on the grounds
  `slot` already exists for: a creature standing between two bushes would
  otherwise flip between them. The verbs that want a pulse — `attack`, a `heard`
  filter, a `{slot}` in a spoken line — read a thing as nobody, exactly as they
  read `home`.
- **`extract` and `consume` are the player's own.** `GameSession.extract` and
  `.consume` were already actor-generic, so a deer's pull holds a reservation
  nobody else can take, is lost the moment the deer steps, and rolls its dice
  once at the end — and a berry it eats lands its `hp` and its statuses through
  the damage path a player's poison apple takes. `extract` reports `running` for
  the whole of a pick, which is what stops a lower line in the priority list from
  stepping and ending the pull it is under.
- **`carrying` reads the bag and only the bag.** What a body wears it is using;
  what is in its bag it is merely carrying. A body with no bag carries nothing,
  which is the answer for every creature nobody authored a container onto — and
  it is why the deer's kit gained a `basic-bag`. Extraction stows into the bag
  and nowhere else, so a deer without one can stand beside a bush and be unable
  to touch it.

**The search is bounded by `brainReach`**, and that bound is the whole of what
keeps this affordable. A body is found by walking a list of actors, which is
short and indexed by tile; a placement is found by looking at the board, which is
neither. A thing further away than the furthest question in the brain cannot
change any answer the brain gives, so that is how far `nearestThing` looks — and
a brain with no distance in it at all names nothing. It rings outward and stops
at the first ring that answers, because the nearest anything is overwhelmingly
close: a deer beside a hedge reads four columns, where a scan of the square would
read every column inside the radius to prove the same thing. The answer is
memoised for the length of one creature's turn, so the condition that notices the
bush and the bind that commits to it cost one search between them.

`data/tiles.json`'s deer is what this was built for, and it now reads as an
animal: it flees on `in_los` rather than `in_range` — it cannot run from
something it cannot see — and otherwise browses, picks and chews. Wolves hunt
deer and rabbits and snakes strike at rabbits, which is two more transitions each
and no new machinery.

**A selector names a list of tiles, not one.** A wolf that hunts deer and
rabbits is one relationship — prey — and saying it as two transitions put the
same condition, bind and target state on two rows that had to be kept in step by
hand. Worse, they were two rows in an *ordered* table, so reordering one
silently changed which animal a wolf preferred. `nearest [deer, rabbit]` says it
once, and a third prey is a chip rather than a row. Nearest is across the whole
list rather than the first tile that answers, because the list is one question —
which is also why agreement between two binds is about the *set*.

The editor's picker changed shape for it: there is no dropdown row for "deer and
rabbit but not wolf", so the kind and the tiles are two controls. A `Select`
picks the question and removable chips pick what it is about, with the last chip
refusing to come off — a selector naming nothing is one the schema refuses, and
removing it would make the brain inert for what looks like an ordinary click.

**Hunger is the absence of enough `fed`, not a status.** The `status` condition
takes a *floor* — "running, with at least this long left" — and the `not` of it
is what an author writes. Asked the other way round, as a ceiling, a creature
that has never eaten answers *no* to "is your fed under two minutes", which is
the opposite of true. As a floor with a `not` it reads correctly on all three
cases that exist: never fed, fed a while ago, fed just now. A wolf gates every
hunting transition on it and none of its fleeing or homing ones, so appetite
decides whether a chase *starts* and never interrupts one — and being hit is
above the gate, because a wolf you attack fights back fed or not.

**`consume` eats out of the bag or off the board.** Given a thing selector it
takes what is lying there, which is what a wolf does with a carcass: there is no
picking it up and no bag to put it in, and authoring that as "take it, then eat
it" would be two turns and a backpack on an animal. The two arms are
`ConsumeSource`'s own, kept all the way out to the brain.

**The editor says what a selector names.** `slotTileId` traces `$bush` back to
the transitions that bind it and answers only when they agree; `affordancesOf`
turns that tile into the words on the row — `Bush · pick`, in the author's own
`actionName`. It annotates and deliberately neither filters the verb picker nor
refuses a save: an author mid-way through re-pointing a row has a line that
momentarily makes no sense, and a UI that argued about it would argue on every
keystroke.

**A resident is told nothing.** Notices are drained per socket, so a line
addressed to a body with no owner is one nobody ever takes away. That was
harmless while only players could work the board and stopped being harmless the
moment a brain could pick a bush — a hedge and a herd would grow `pendingNotices`
without bound for the life of the world. `GameSession.say` drops them at the
door.

## A status can be a gamble, and a body can be immune to one

Two changes to how a condition is handed over, both forced by one item.

**A `StatusGrant` carries an optional chance.** It used to belong to a weapon
alone and the argument was a good one: you chose to swallow a drink and it went
down, where a bite has to get through before the venom can take. Raw meat broke
it — eating it leaves you fed every time and ill most of the time, and that
"most" is not a second food, a second status, or anything a duration could say.
So the chance moved onto the shared shape and is optional there, which keeps
every consumable ever authored meaning exactly what it meant: absent is certain,
and nothing on disk had to be touched. `WeaponStatus` narrows it back to
required, because a blow's chance is the thing an author is deciding the moment
they add a row.

Both are drawn through `combat`'s `inflictedBy`, so a hundred means the same
thing on a blade and on a supper — and a certain row is still *drawn* for, on the
fixed-draw-count discipline a swing and an extract are under.

It also deleted a whole escape hatch: `StatusGrants` had an `extra` prop whose
only user was the weapon's chance column, and folding the column in removed both.

**`BattlerDef.immuneTo` is the one kind of resistance that is not a number.**
Everything else about taking damage is arithmetic — armour subtracts, an element
multiplies — and arithmetic is right for things that hurt more or less. A
condition is not one of those: a wolf is not ninety percent less made ill by
carrion, it eats carrion and is fine. So it is a list of status ids, checked in
`grantStatus` and nowhere else — which is the one gate every source goes through,
so an immunity holds against the food, the blade dipped in it, the hearth and the
spell alike without any of them knowing about it.

Read off the *body's* authored block rather than through `battlerOf`, which is
where statuses feed into the numbers: reading it there would let a status decide
whether a status may be applied.

## A dead body's bag is destroyed and its contents spill

Dropping the pack whole was the simpler rule and it made a killing a single
pickup: one bag on the ground, everything inside it, gone in one gesture and
never sorted through. `spilled` puts the contents on the floor as things instead,
so what a fight was worth is what is lying there, and it costs the winner the
walk over it rather than a tap.

The bag slot alone, though a hand may hold a container too. That slot is not a
place a container happens to be, it *is* the inventory — a pack carried in a hand
is a thing you are holding on exactly the terms a crate is, and widening this
would mean a player who died carrying a chest lost the chest. Nothing nests, so
one level of spilling is the whole of it.

It applies to players exactly as it does to a deer, which is the point: there is
one death, and a deer that had picked a bush leaves the berries it was carrying.

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

## A tile can form and dissolve, and only when it says so

`TileDef.transitions` (`app/lib/tileTransition.ts`) is how a tile arrives and
how it leaves: an `appear` and a `disappear` side, each a duration plus any of a
dissolve (noise, sweep or dither), a scale into its base cell, a drop from above
and a particle burst. It is authored in the tile editor's **Effects** tab, beside
a preview that plays it through the world's own shader.

**Opt-in, and only for a cause the server can name.** A cell patch cannot tell a
flame that burned out from a berry that was picked up, so the cause travels as a
`tileTransition` motion event and the client never guesses it from a diff. The
rule is **anything that was not on the board and now is plays its appear**:
`castConjure`, `/tile` (each placement a count makes — a pour into a pile
makes none), `respawnAt`, `spawn` placing a player's body (a join, a rebirth,
a wake whose body was reaped — not the re-seat after an editor save, which
passes `announce: false`), and what a decay turns into. A disappear is a
decay, a death (`kill`, where the body fell) or a player leaving (`despawn`). A thing that moved — a drop, a pickup, loot out of a kit, gravity
— existed all along and plays nothing, and neither does a tile swapped in
place by a switch, a plate or an extraction. All of it only when the tile
has that side authored; everything else changes instantly, which is what
every tile did before this existed, and costs the wire nothing.

**The new event kind needed a second edit, and the first version shipped
without it.** A `MotionEvent` kind has to be in the TS union *and* in
`serverMessageSchema`'s variant. Without the variant the client fails
validation on the whole message and drops the frame, patch included, with
nothing logged, and a typecheck passes either way. `protocol.test.ts` now
round-trips one of every kind from a record keyed by kind, so a new kind with
no fixture does not compile.

**The server holds no transition state.** Notes are drained each tick and after
input (a conjure lands on a cast, and `flushBlows` is what sends it) and never
aged. `seatActor`, `dropSocket` and `processDueRespawns` drain their own as
well: a join, a leave and the alarm's respawns happen outside a tick, and a tick empties what is pending
before its own drain, so a note raised there would otherwise never be sent. A visual timer on the server would keep brains, settle and checkpoints
running for something nobody can be hurt by. The clock is the renderer's:
`RemoteSession` stamps a note on arrival against a clock that runs while the tab
is hidden, drops what could have finished, and caps what it holds, because
frames stop in a background tab while the socket keeps delivering. Offline
`/play` keeps its own capped list, since `update` can run several ticks between
two frames and each tick empties the list a server drains.

**A note's slot is a hint.** `stackIndex` is exact when the change happens, and
gravity, extraction or a creature eating in the same tick can still move things
before anybody is told. The renderer trusts the slot only while the named tile
is still there, then takes the cell's only copy, then gives up and lets the tile
change instantly (`resolveTransitionSlot`). `applyDecay` reports each turn at two
addresses — its slot in the stack the pass started from, and its replacement's
slot in the stack it ends with — because `[grass, puddle, ember]` with the
puddle drying to nothing ends `[grass, ash]`.

**Only a transitioning tile pays.** This is the tint's bargain (see "The tint is a
uniform"): a forming or dissolving placement is drawn as a mesh of its own for
the length of the effect, with its own material carrying the uniforms, and the
merged batches carry nothing extra. Three consequences worth knowing:

- **A forming tile is handed back to its chunk when it finishes**, by rebuilding
  that chunk. Left alone, the first patch that touched its cell would drop it,
  because the batch that should hold it was never told it existed. Rebuilds are
  queued and flushed once per pass.
- **A note can arrive a frame after the tile it is about** — the board flush in
  the input path can go out before the tick that carries the event. By then the
  tile may already be in the batch, and the batch's merged-signature compare
  cannot see the difference, so a tile the drawn board already holds has its
  chunk rebuilt at once. A disappear cannot be late: decay only happens on a
  tick, and a tick's events ride with its patch.
- **A body forms by its name, not its cell.** A placement with an owner or an
  item id (`placementIdentity`) is found by that, so a creature that steps in
  the first half-second of its respawn goes on forming in the next cell. Its
  mesh is its own for good, so when the appear ends it is stood whole and
  given its plain material back instead of a rebuild; its step is added to
  its pose; and a tint waits until the appear is over, because the
  transition's material has no tint in it and a tint's has no transition. Nor
  is it ghosted onto the level below while it takes the stairs, since the
  ghost's material is a plain one too.
- **A dissolving tile is a copy** built from the previous map, in a named
  `tileTransitions` group that `discardGeometry` exempts, hidden with its storey
  when the roof cut hides the whole level.

**Dither, not alpha.** World tiles write their own per-pixel depth, so blending
would break sorting, and a half-transparent pixel would land off the palette.
Every pattern is read per art pixel at the sprite's *unscaled* position
(`vFxPx`), so noise stays fixed to the art while the mesh shrinks rather than
sliding across it.

**A scale shrinks into the middle of the cell the tile stands on, on the pixel
grid.** The pivot is the centre of the tile's base cell: half a cell up and
half a cell right of that cell's bottom-left corner. For a one-cell tile that
is the sprite's own middle; for a larger sprite it is not — the flame's base
is the lower-right cell of its 2×2, and it shrinks towards that cell rather
than towards the middle of its art. And it never draws pixels smaller than
the world's: `pixelSnappedQuad` rounds the scaled quad's size, corner and
drop lift to whole world pixels, and the shader redraws a transitioning mesh
one texel per world pixel (`TRANSITION_GLSL_SNAP`), so a shrinking sprite
loses whole rows and columns of art instead of showing mixels beside
full-size neighbours. The art pixel under each world pixel is chosen with a
nudge smaller than a pixel, because at scales like ½ a world pixel's centre
lands exactly on an art-pixel edge, and the fragments inside it would
otherwise disagree about which side they are on.

**A drop is in storeys, and its depth goes up with it.** One level up lands on
the same pixel as one cell up-left, so a stone "dropping from x-2 y-2" and one
falling two storeys look the same — but only the storeys sort right. The mesh
is moved by `levelScreenOffset` and its depth box's foot and top are raised by
the same levels, every frame, since `applyTileMotions` writes a movable mesh's
box back to its cell on each view. The box's xy never move, so the roof cut
keeps reading the tile's own cell.

**The tile's own plume goes with it.** A forming tile's plume thins in: its spec
belongs to the chunk and is rebuilt at full strength when the tile rejoins the
batch. A dissolving tile took its plume off the board, so the copy carries its
config on, tapering, under an id of its own. Not the original id: the slot may
already hold what the tile turned into, with a plume of its own under that
id, and two specs under one id leave one drawn with the other's config. The
original's sparks finish by themselves once it is retired. Both are
`appendTransitionEmitters`, which replaces a forming tile's spec with a
tapered copy rather than writing into the one its chunk owns. A transition's
own burst is one more emitter for its duration, appended after the board's,
and capped by rate × duration at `MAX_BURST_PARTICLES` so one burst cannot
empty the pool.

**The light fades on a shared grid.** The bake dropped the tile's light the
moment it left the map, so a dissolving tile's light is painted back as an
emitter override that steps down every `LIGHT_FADE_STEP_MS`, measured on one
grid for every fade rather than from each one's start — the overlay cache keys on
each light's intensity, so concurrent fades cost one rebake per step between them.
The override waits until the bake has moved on from the grid that still held the
tile's light; painted over that grid it doubled the light for a few frames and
the room flared before it dimmed. That rests on one assumption worth knowing:
a grid of a new identity is taken to be one baked without the tile. A bake
started before the tile left and landing after it would break that, for a few
frames of slightly doubled light. A forming tile's light arrives with the tile:
ramping it in needs a per-placement omission from the bake that does not exist
yet (`omitLightTileIds` is keyed by tile id).

**Watching one needs a slow copy.** Headless screenshots here take a few hundred
milliseconds each, so a 700 ms effect is over by the second frame. To look at
one, raise its duration in `data/tiles.json`, post the file to the dev server
(which, under `bun dev`, writes the file too — that is the editor's save path),
and put it back afterwards.

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

### The bucket fills blank cells, bounded by the level's own extent

`floodCoords` floods a blank start cell as readily as a tiled one — painting the
inside of an outline you have just drawn is the ordinary way to make a cave
floor, and refusing it made the tool useless for exactly the shape it is best
at. Blank space has no far edge, though, so a flood started in the open world
has no reason to ever stop and the map has no size to clamp it against.

The stop is the box around every cell the level already holds: a blank flood
that steps outside it fills **nothing**, rather than some arbitrary prefix of
the void. That box is the exact test rather than a guess at one — every cell
beyond it is blank too, so a region that leaves it can reach any coordinate
there is, and a region that never leaves it is enclosed by tiles on all four
sides. A gap in the outline therefore reads as "open space" and not as a
part-filled cave, which is the answer you want: the fill you asked for was never
possible, and a half-flood would leave you hunting for the leak in a floor you
had already painted over.

Only the current level's cells count, because the flood only ever compares
stacks on that level. Drawing the outline on the level you are filling is not a
convention — it is the whole of what makes the fill terminate.

## A status is drawn twice: on the body, and over the tile

`app/lib/statusVfx.ts` is the vocabulary — a tint, a cast light and an emitter —
and it is a fourth file rather than more of `app/lib/status.ts` because **the
simulation never reads it**. A status's numbers are the server's business; what
it looks like is not on the wire, is not ticked, and cannot kill anybody.
Keeping the two in separate files is what stops an effect quietly growing a
consequence.

The emitter itself lives one file further out, in `app/lib/particleVfx.ts`,
because a status is not the only thing that has one: a **tile** carries one too,
and a chimney is not under an effect. See "A tile emits because it is that tile"
below.

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

### A plume can be blown sideways, and the wind is an acceleration

`driftCellsPerSecond` is symmetric — a per-axis roll in ±drift, drawn once at
birth — so it spreads a plume and never moves one. `windX` / `windY` are the
other thing: cells per second squared along the map's axes, integrated in
`ParticleSystem.advance` exactly as `gravity` already is on the vertical.

**An acceleration and not a speed**, and the difference is the whole effect: a
plume that leaves the chimney already travelling reads as a jet, and one that
leaves it straight and bends over as it climbs reads as smoke in a breeze. Only
an acceleration draws that curve, which is what `particles.test.ts` asserts —
the second second of sideways travel has to be longer than the first, not merely
non-zero.

Map axes, never screen ones. `+x` is east, `+y` is south, and the projection
makes the diagonal, the same way it does for `rise`.

### A tile emits because it is that tile, not because something happened to it

`TileDef.particles` is the same `ParticleEmitterDef` a status carries, and every
placement of that tile on the board gives off a plume: a chimney, a flame, a
torch lying on the floor. An item in a bag emits nothing without anything having
to say so — an inventory draws its own sprites and never the world.

**On the tile and not on the frame**, unlike `Frame.light`. A thing that emits
and the same thing not emitting are already two defs here with a swap between
them, so per-frame emitters would buy smoking on frames 2 and 4 of a fire and
cost a plume that restarts or changes shape every time the animation came round.

Four things about the machinery are worth knowing before touching it:

- **The index is built by the mesh builder, not by a sweep.** `cellItems` has
  just worked out the placement's foot elevation and its depth box, which is
  exactly what an emitter needs; a second walk would be a second copy of that
  arithmetic and the two would drift. The emitter rides in on the `BuildItem`
  and is collected into `tileEmittersByLevel` — maintained by `buildLevel`,
  `rebuildLevelIncrementally` and `removeLevel`, the same three functions
  `animatedByLevel` is. **A fourth index with its own lifecycle is a fourth
  thing to forget in `removeLevel`.**
- **The incremental path collects before it filters.** That loop skips items
  with no mesh of their own, and the merged tiles it skips are exactly the
  still, unanimated ones a chimney is. Collecting after the `continue` means the
  chimney smokes until the first time anything near it changes and then never
  again.
- **The cull is `app/render/tileEmitters.ts`, and it is pure.** A rect test per
  level, the roof cut, and a cap. Separate from the renderer for the reason
  `particles.ts` is separate from `particleLayer.ts`: it is arithmetic, so it can
  be asserted rather than eyeballed.
- **The window is the camera's reach on that emitter's own level, and it must
  not be the light bake's.** `lightWindow` is the union across every level —
  right for a light, since one on any storey can reach the cells you are looking
  at, and the projection shifts level `z` by exactly `z` cells so unioning
  seventeen of them grows the rect by eight cells a side before its own margin.
  Against a 23-cell viewport that is a window over **four times** the visible
  area, and every emitter inside it spends the shared pool and has quads written
  for sparks nobody can see. A plume is on one known level, so it takes that
  level's own rect plus `PARTICLE_WINDOW_MARGIN` — one add per level, nothing per
  emitter, and 45% fewer emitters admitted.

  Both windows are now built on `WorldRenderer.cameraWindow`, the level-0 rect
  with no slack of its own. `lightWindow` adds the level span and its margin back
  and is **byte-identical** to what it replaces: `floor((px + 8z) / 8)` is
  `floor(px / 8) + z` for every camera position, which is checked rather than
  asserted from the algebra.
- **The rect is compared cell to cell, not against the anchor.** A plume hangs
  from the middle of its cell, so `cx` is `x + 0.5`; comparing that against an
  integer cell rect silently drops the whole eastern and southern edge of the
  window, since every emitter there sits half a cell past its own bound.
- **The board's plumes come after the caller's, and that order is load-bearing.**
  The pool is fixed and emission is served in emitter order, so a crowded board
  thins its own smoke rather than dropping the fire on the rat.

`MAX_VISIBLE_TILE_EMITTERS` is not the budget — `MAX_LIVE_PARTICLES` is. It
bounds the per-frame reconcile, and its truncation is arbitrary rather than
nearest-first: past 128 emitting tiles in one window, which of them smoke changes
as you walk. That is already a content mistake, and a sort would cost more every
frame to fix it.

**Nothing parses a tile on the way in**, so `normalizeTileDef` is the only door
between a hand-edited `tiles.json` and a `ratePerSecond` of `"lots"` reaching the
emission loop. A malformed plume is **dropped rather than refused**, on exactly
the terms `clampTileLight` is silent: this is one author's own content, and a
world that would not load over a smoke plume is worse than a chimney that has
stopped smoking. The same parse is what fills in a field an authored block
predates, so the renderer reads a complete emitter and never a partial one.

**The map editor draws no plumes**, tile or status: `/map` is
`app/editor/EditorRenderer.ts`, a separate renderer from the one play uses, with
no particle layer in it. What answers for that is the preview in the tile dialog
— `app/render/VfxPreview.ts`, the status editor's rendering simulation, with the
subject pinned to the tile being edited.

Two things had to change for it to take a *draft* rather than a catalogue entry,
and both are the same fact: the subject is now an object that changes while the
dialog is open.

- **`setSubject` compares by object, not by id.** An id comparison left the
  preview showing the sprite the tile had when it was opened. The sheet is still
  only re-fetched when the *tileset* changes, or a dragged slider would download
  a tilesheet a frame.
- **The dialog memoises what it hands over**, keyed on the fields that decide the
  art. Without it every keystroke rebuilds the subject mesh and restarts the
  sprite's animation.

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

## A scatter tile is one tile with several faces, picked by where it stands

`TileType` has a fifth member, `scatter`, for ground and undergrowth: grass,
bushes, a brick road, a stand of trees. The author draws a handful of faces and
every placement wears one of them, decided by a hash of its own coordinates —
so a field is laid down in one stroke and never repeats a run.

**The pick is a pure function of the cell, and nothing else.** Not stored on the
placement, which is the whole point: a scattered field is a thousand cells of
one tile, and a face per placement would be a thousand numbers in `map.json`
saying what the coordinates already say. Not read from neighbours either, which
is what separates it from the autotile beside it in the union — `resolveScatterIndex`
never touches the map, so an edit invalidates the cell it touched and no ring
around it. The cost of both is that the author cannot overrule one awkward cell;
for that, place a plain tile there instead.

**The tile's own id is folded into the seed.** Every scatter tile would
otherwise share seed 0, and a grass field and a pebble field laid over the same
cells would pick the *same* index in every one of them. Two independent
scatters that correlate read as a pattern, which is exactly what the type
exists to remove, so they are decorrelated before anybody has to know the seed
control exists. The stored `scatterSeed` then means what it says: re-roll *this*
tile.

**The noise is white on purpose.** Each cell is drawn independently of its
neighbours. Anything smoother — value noise, a repeating table — puts visible
structure back in, and structure in a brick road is the thing you notice first.
The unit tests assert the absence of it along a row, a column and a diagonal,
because stripes are the failure a bad mix actually produces.

**It shares one consequence with autotile and nothing else.** Two placements of
one scatter tile can be running different frame lists, so an animation clock
keyed per tile would index one placement's frames with the other's position.
Both renderers key these per cell instead, through `isCellVarying` — which is
deliberately *not* what decides an autotile's neighbour ring on a rebuild, since
that is about reading the cells around you and scatter does not.

It composes with nothing. A scatter tile is not also an autotile, is not
directional, and has no `connectsTo`; the type is the axis, and a tile has one.

## A variant tile is one tile with several faces, and the placement picks

`TileType`'s sixth member, `variant`, is the third and last way a tile can have
more than one face — and the only one where **nothing derives which**. An
autotile reads its neighbours, a scatter tile hashes its coordinates, and a
variant tile is told: `PlacedTile.variant` names a key in `TileDef.variants`,
and that is the whole mechanism.

It exists for a shape the other two cannot express: **one thing, drawn to match
whatever it was cut into.** A hole in the ground is the case that asked for it.
A hole has to be a real absence — the cell holds an intangible, light-passing
tile and nothing solid, so a body falls through it (*An intangible tile holds
nothing up*) and daylight goes down it (*A floor is a lid*) — and it also has to
look like a hole *in planks*, or in sand, or in grass, because the rim is the
material it was cut through. Neither of those is negotiable and neither implies
the other.

**Why not the other two.** An autotile cannot do it: an 8-neighbour mask asks
"is my neighbour more of me?", and a hole's neighbours are never more hole —
they are the floor it interrupts, which the mask cannot see the identity of. The
same blindness `connectsTo` exists to work around (*a stair well cut through a
floor*), one level further out. And a scatter tile cannot do it because the pick
would be a hash: the hole in the wooden platform would be sand because of where
it happens to sit.

**The face is on the placement, and that is the argument.** `scatterSeed` is on
the *def* precisely because a scattered field is a thousand cells nobody chose
one by one, and a face stored per placement would be a thousand numbers in
`map.json` saying what the coordinates already say. Here the opposite is true:
every hole is cut deliberately, by somebody who knows what the floor was, and
nothing in the cell's coordinates knows it. So it goes beside `direction` —
which the tile also cannot derive — and for the same reason.

**Named, not numbered.** `variants` is a `Record<string, TileSprite>` where
`scatter` is a dense array. The key is written into every placement wearing it
in a file that is hand-edited and lives in version control, so `"planks"` earns
its bytes where `2` would not, and reordering or inserting a face does not
silently repaint the map. Numeric-only names are refused in the editor: object
keys that parse as array indices sort ahead of everything else whatever order
they were written in, which would move which face "first authored" means.

**Everything falls back to the first authored face**, both for a placement that
names none and for one naming a face that has since been renamed away. A tile
whose whole job is to be a hole in the world must not fail by drawing nothing:
the two would be indistinguishable. `resolveTileSprite` settles the key against
*idle* before it asks either holder, so a placement wearing no name does not
change face when a state starts drawing.

The frame clock is keyed per face (`animationKey`), for the reason it is keyed
per state: a hole cut in planks has no obligation to have been drawn with as
many frames as a hole cut in water, and one placement must not index the other's
frame list.

**`variants` meant something else once.** Tiles written before `TileType`
existed keyed a `variants` table by *facing* and held `Frame[]`, and
`normalizeTileDef` still migrates them. A tile carrying both a valid `type` and
a legacy `variants` is half-migrated data, and the typed branch now drops the
field unless the tile really is a `variant` tile — without that, every sprite
walker is handed `Frame[]` where it expects `TileSprite`. The old `VariantKey`
type is now `FacingKey`, and the scatter editor calls its faces faces, so the
word means one thing.
## The editor explains itself in tooltips, and validates when you leave the box

**A caption says what a field is; the `i` beside it says what the engine does
with it.** The tile editor used to carry a paragraph under nearly every
control, and most of them restated the caption — "How this looks at rest"
under *Idle*. A panel of forty paragraphs is a panel nobody reads, so the
paragraphs are gone and the engine's side of each field (unit, clamp, what it
interacts with two tabs away) lives in `InfoTip`, reached through `FieldLabel`
and `SectionTitle` in `app/ui`. The one line that still belongs under a box is
a *readout*: a sentence computed from the number in it, which `StatField`
keeps. Captions use the engine's names — "Elements", "Derived stats",
"Cooldown (s)" — not the fiction's.

**Number boxes commit on blur or Enter, never on keystroke.** Every numeric
field clamped as you typed, so clearing "1" to type "7" snapped straight back
to 1. `NumberInput` (`app/ui/NumberInput.tsx`) holds a draft while focused and
reads it against its range when you leave: a good number is committed and the
box rewritten in canonical form, a bad one stays in the box with the reason
underneath and commits nothing, Escape reverts. The parser is pure
(`numberParse.ts`) and tested. Rejecting rather than clamping is a choice: a
box showing "99999" in red beside Save will save the *previous* number, which
is the trade for never writing a number the author did not type. Range pairs
(decay, respawn, status durations) still carry each other in the caller.

**Tabs are flat flaps on a rule, not buttons.** `Tabs` had the button chrome —
hard shadow, pressed travel — and a strip of them read as a row of actions.
The open flap paints its bottom border paper to erase its stretch of the rule,
which assumes a paper ground; every tab strip sits on one.

**A wide `Dialog` is 90vh, fixed.** A popup sized to its content jumped on every
tab switch and moved Save under the pointer. Narrow dialogs still fit their
content.

**Gotcha: `app.css` resets `button, input, select, textarea { font: inherit }`
outside any cascade layer**, and an unlayered rule beats every layered Tailwind
utility regardless of specificity. So `text-xs`, `font-medium` and `font-bold`
on a `<button>` have never applied anywhere in the app, and `Button`'s size
variants only differ in padding. The tab strip uses `font-bold!` to get past
it. Moving the reset into `@layer base` would fix it globally, and would also
shrink every button in the app to the size its class asks for — do it on
purpose, with a visual pass, not by accident.

### Making the second character out of the first

Two operations in the tile editor exist because authoring an NPC meant
re-picking every sprite of an existing one by hand: four or eight facings times
however many states, each a drag-select on the sheet that can land a cell off
without saying so. `app/lib/spriteAnchor.ts` is where the tests are.

**Duplicate writes the draft, not the file.** The footer's *Duplicate* asks for
an id and a name, then runs the draft through the same checks Save does and
writes it under the new id — so a copy carries edits the original has not been
saved with, and the editor never puts a tile in the library it would itself
refuse. The default id counts up from whatever number is already on the end
(`guard` → `guard-2`, `guard-2` → `guard-3`), because these come in rows of
siblings and `guard-copy-copy` is what appending gives you on the third one.
The dialog then swaps to the copy, since duplicating is never the whole job.

**The anchor moves the whole tile at once.** *Anchor* is two numbers beside the
sheet picker, and every sprite the tile has is measured from it — see *A tile
names one sheet, and every rect is measured from one cell*. That is what turns
twenty-four drag-selects into a duplicate plus a `+8`: a character sheet is drawn
as one block, and the next character is the block beside it.

An anchor whose block would run off its sheet is **refused, not clamped**, and
`anchorFits` is where that is decided. It checks both edges, since a rect
relative to the anchor may be negative.

## Moving the editor's camera

The view is two numbers in `app/editor/store.ts`: `camera`, the world-pixel
offset of the canvas's top-left corner, and `zoom`, CSS pixels per world pixel
and always one of `ZOOM_LEVELS`. Everything that moves the view writes those
two, and the math is `app/editor/camera.ts` — pure and tested, because every
function in it is an inverse of `screenToCoord` and a sign error there puts the
view a cell out per level travelled rather than visibly wrong.

**One finger draws and two move the map.** A phone has no middle button and no
space bar, so the two ways to pan a desktop editor are both unavailable and the
one gesture a finger has is already spoken for by the tool. The second finger
landing is therefore a takeover: the stroke in progress is committed — those
cells were asked for, and one undo takes them back together — a shape preview
is dropped, since its far corner is wherever the finger happened to be, and the
gesture belongs to the camera until a finger lifts. Nothing paints on the way
out of a pinch, which is why `onPointerUp` returns early while the gesture is
still running.

**A pinch banks travel, because zoom is four steps and not a slider.** The
tipping point is √2, the geometric midpoint between two neighbouring steps, so
the pinch lands on whichever step its spread is now nearer; a linear threshold
would step early one way and late the other. The spread is then re-based on
where the fingers are *now* rather than where they started, or the second step
would cost only the fraction left over from the first. Both directions anchor
on the point between the fingers (`cameraAnchoredAtZoom`) — without that the
map grows out of the middle of the canvas and slides away from the pinch.

**A trackpad pinch is a wheel event with `ctrlKey` set**, synthesised by the
browser with no Ctrl key held. Before this, every wheel event panned, so
pinching a trackpad shoved the map sideways. One notch is a quarter step: the
gesture arrives as a stream of small deltas, and a whole step per notch crosses
a four-step scale before the fingers have moved a centimetre.

**Safari's page pinch is cancelled on the canvas and nowhere else.** The page
deliberately allows pinch-zoom — `app/root.tsx` sets no maximum scale, for the
same reason the 16px field note gives — and `touch-action: none` does not cover
it, so the canvas also swallows `gesturestart` and friends. Everything else in
the editor still magnifies.

**`window.map` drives the view from a script** — `setCenter({x, y, z})`,
`setZoom`, `getView`, defined in `app/editor/mapApi.ts`. The editor has no
address bar: where you are looking is store state, so "show me the well at
118,64" is a drag across a canvas and there is no way to say it in words. That
is fine for a person and useless to anything scripting the page — an agent
asked to look at a corner of the map, a screenshot taken the same way twice.
It ships in production builds, because driving the deployed editor is the
point, and it writes view state only: the worst a caller can do is look
somewhere unhelpful. Coordinates are parsed rather than trusted, since a `NaN`
in the camera leaves every later pan and screen-to-cell conversion producing
`NaN` too, which reads as a dead canvas rather than as a bad argument.

## A generator is a plan, and the plan is the preview

The **procedural** button on the map toolbar opens a list of generators and
their settings; pressing Place arms a tool that builds one out of a dragged
rectangle. The house came first and the shape of it is what the others copy.

`app/editor/procedural.ts` is the list they are reached through, and it is the
only thing the store and the renderer know about: both call `planProcedural`
with the armed config and neither has heard of a house. Adding a generator is
a config type with a `generator` tag, a `plan*` function, a row in
`GENERATORS`, a default in `proceduralSettings.ts` and a form in the dialog.
The parts more than one of them needs — the rectangle, the grid of open cells,
the noise, and the water and scatter passes — are in `app/editor/generator.ts`.

**One pure function answers everything.** `planHouse` (`app/editor/house.ts`)
takes the map, the rectangle, the level and the settings, and returns either
the list of `StackEdit`s that build the house or the reason it cannot be built.
Nothing else knows how a house is put together: the drag preview draws that
list, the commit writes that list through one `setStacks`, and the refusal the
toast shows is that same reason. The alternative — a builder and a separate
"would this fit" predicate — is two descriptions of one house that drift, and
the way it fails is a preview that shows something the click does not build.

**One `setStacks`, so a house is one revert.** Several hundred cells across
half a dozen levels arrive as a single `commitMap`, which is a single entry in
the undo stack. A generator that wrote its storeys one at a time would need six
presses of ⌘Z to take back one mistake.

**The preview is resolved against the map the plan makes, not the one it starts
from.** Walls and floors are autotiles, and an autotile drawn against the map
as it stands has no neighbours yet — so a ghost built the obvious way is a
picket fence of isolated posts rather than a house. `setStacks` is copy-on-write
and the overlay is rebuilt only when the rectangle or the settings change, so
building a provisional map per drag step is affordable. Past
`MAX_HOUSE_GHOST_CELLS` the drag shows its footprint and nothing else, for the
same reason the shape tools stop ghosting at `MAX_GHOST_CELLS`: one mesh per
sprite.

### The site has to be level, and everything above it empty

Two different questions, and they are different because the ground floor and
the storeys above it are in different situations.

- **The ground floor is laid on top of the site, never in place of it.** A house
  dropped on a road keeps its road, and one on grass keeps its grass — the floor
  tile goes on the end of the stack that is already there. What it asks of the
  site is that every cell in the footprint stands the *same* number of units,
  because a floor across two heights is a floor with a step in it. Any height
  counts, not only zero: a plinth of half-blocks is a level site.
- **Everything above the ground floor has to be empty.** That is what makes a
  roof overhead refuse the whole house rather than growing through it, and it is
  why a house cannot be dropped on top of another one.

**A storey is one level, so the site plus the floor plus the wall has to fit in
`HEIGHT_PER_LEVEL`.** Full-height walls therefore only stand on a flat site; on
a two-unit plinth the walls have to be two units too (`half-wall`). The plan
says that in those words rather than letting `canReplaceStack` report it as an
overflow into the level the next storey is being written to — the arithmetic is
the useful half of the message, and the validator's version names the wrong
cause.

### The grammar is the one the two example buildings already define

Copied from the cottage at (12,3) and the shop at (7,-8) in `data/map.json`,
which is why those two are worth keeping intact.

- **A storey is a ring of `[floor, wall]` around an inside of `[floor]`.** The
  door replaces the wall in one ground-floor cell; a window replaces it in
  several, on every storey.
- **The ridge runs along the building's longer side**, so the roof steps in
  across the *short* axis and a hall twice as long as it is wide gets a long low
  roof rather than a short tall one. That is what the orientation setting's
  `auto` does, and it is the default; the two explicit values are for the
  building that means something else by its shape. A square has no long axis
  and is roofed north-south, which is how the cottage at (12,3) is roofed.
- **The roof, when there is one, steps in one cell a side per level** until the
  span runs out. The low edge wears the eave facing the ridge and the high edge
  the one facing back at it (`e`/`w` for a north-south ridge, `s`/`n` for an
  east-west one), and the cells between them are two `plaster`, which is four
  units and so exactly the floor the next roof level stands on. A span that
  comes down to a single cell gets the two-unit ridge cap instead —
  `roof-3`/`roof-5`/`roof-6`,
  which are the red, yellow and blue caps for the `roof-1`/`roof-2`/`roof-4`
  eaves. So a five-wide roof is three levels and a six-wide one is three as
  well, ending in two opposing eaves rather than a cap.
- **A window is drawn on the face the camera can see.** `window-1` has two
  sprites wearing four names: `n`/`s` is the face of a wall running east-west,
  `e`/`w` the face of one running north-south. North walls get windows like any
  other; the sprite is the same one the south wall wears.

**"N tiles away" means an index distance of N along the wall run.** The door
keeps two from each corner, which is what puts the door of a five-wide wall
dead centre — where the cottage's is — and what makes a four-wide wall have
nowhere to put one, so a house that small gets none rather than a door in its
corner. Windows keep one from the corners and two from the door: one would only
say "not the door's own cell", which the door already says for itself.

**How far apart windows sit is authored, not fixed.** It is the one number here
whose right answer is not a property of the tiles — two cells is a shopfront
and five is a cottage, and which of those a building is meant to be is the
thing being decided — so it is a setting, floored at two because one puts a
window in every wall cell.

**A wall reads as symmetrical or as a mistake, and there is nothing in
between.** As many windows as fit at the spacing, the same margin at both ends,
and whatever the wall cannot divide evenly widening the *middle* gap. Slack put
at one end instead — which is what centring the run with a floor divide does —
leaves an extra blank cell at the east end of a wall and none at the west, and
that looks like the run was measured from the wrong corner. It was. The one
case with no symmetric answer is a lone window on a wall with an even number of
usable cells: there is no middle gap for the odd cell to go into, so it sits
one short of the middle and the margins differ by one.

**A building may have no roof at all.** A curtain wall, a tower and a walled
yard are this generator with the roof left off, so the colour picker's first
swatch is None and the storeys simply stop. Everything else is unchanged: the
top storey is still a ring of wall around a floor, and the level the fit test
has to keep clear is that one rather than a ridge above it.

**The door's placement is two coordinates, not eight directions.** A row
(north / centre / south) and a column (west / centre / east). The row picks the
wall wherever it names one and the column picks which end of it; a centred row
leaves the choice to the column. Both centred names no wall at all, which is
why the middle of the grid is the one square that cannot be pressed.

**Settings live in `localStorage`, not in the map.** A row of blue-roofed
cottages is nine placements of one form, so the settings belong to the person
building rather than to the world being built. They are parsed on the way back
in (`app/editor/proceduralSettings.ts`) and checked against the tile catalogue:
a saved wall tile that no longer exists reads as "no saved settings" instead of
arming the tool with an id nothing can draw.

## A cave is rock you take away from

The cave generator (`app/editor/cave.ts`) blocks the dragged rectangle out as
solid rock and carves a cave out of it. The order it does that in is the whole
design, because each step can undo the one before it:

**Block out, carve, widen, join, decorate.** Carving leaves passages a single
cell wide; widening them closes some of the cave off entirely; joining what is
left is therefore the last thing that touches the *shape*, and everything after
it only puts things on a floor that is already final. Widening and joining
alternate rather than running once each — a bored corridor can meet its room at
an angle that widening then pinches shut — and after four rounds anything still
separate is filled back in, because a cave with a room nobody can walk to is
worse than a slightly smaller cave.

**Joining is done by opening, not by filling** (`joinRegions`, in
`generator.ts` because the forest wants it too). What the carve left separate
gets a two-wide corridor bored between the closest pair of cells; what is too
small to be worth a corridor is filled in instead, because a room reached down
a long bored passage that turns out to be a 2×2 closet is worse than no room.
A forest passes `tooSmall: "leave"` for the same call and keeps its small
pockets — see below.

The bore's **brush** is clamped into the box, not each of its cells. Clamping
cell by cell folds the far column onto the near one at the boundary and leaves
a corridor one cell wide along it, which is the one thing all of this exists to
avoid.

### No passage is ever one cell wide

**A one-cell passage is a passage you cannot see into.** The world is drawn in
an oblique projection, so the wall on the near side of a corridor is drawn over
the floor behind it: a corridor one cell wide has no visible floor at all, and
neither does whatever is standing in it. Two cells is the narrowest that leaves
a strip you can see.

The rule that gets there is mechanical and lives in `widenToTwo`: **an open cell
has to be part of some fully open 2×2 square**, and anything else — a spur, a
diagonal pinch, a one-wide neck — is filled back in. Filling one neck can expose
another, so it runs to a fixed point. Everything downstream depends on this
holding, which is why `cave.test.ts` asserts it over every shape, every density
and a spread of seeds rather than on one example.

### Three shapes, because they are three places

Not three settings of one. Density is the setting, and it means roughly the same
share of open floor in all three.

- **Caverns** is the cellular automaton `scripts/carve-caves.ts` digs the animal
  den with: a starting rock fraction per cell, then smoothing passes that turn
  crowded cells to rock and sprinkle pillars back into open country. The
  starting fraction is itself varied by a noise field, and that is the
  difference between a cave and a texture — with one fraction over the whole
  rectangle every part of it comes out equally porous, and varying it by region
  is what makes one end a hall and the other a warren. It reads as eroded.
- **Veins** keeps a band around the middle of a noise field, which is a contour
  line: long sinuous passages that wander and branch and rarely open out. It
  reads as water-cut.
- **Tunnels** sends diggers out with a 2×2 brush. **A digger has to be going
  somewhere, or it never leaves.** A walk that turns at random stays where it
  started — at a 40×40 rectangle it opened a third of the cells and every one
  of them was in the same corner. Giving each digger a point to reach and
  letting it stray on the way turns the same number of steps into corridors
  that cross the rectangle, and the straying is what stops them being ruled
  lines. It reads as dug.

### The alternative floor goes on top of the base one

The base floor is laid under every cell you can stand on, and the alternative
floor is a covering laid **over** it in patches — not a swap. A scatter of
cobbles over dirt is dirt with cobbles on it, and putting the alternative in
place of the base leaves each patch reading as a hole in the ground the rest of
the floor is. It is drawn from a noise field rather than per cell, because per
cell randomness over a floor is not patches, it is dirt.

### The block-out replaces, and rock fills a level exactly

A house is put on a site; a cave is what is left of one. So the cave **replaces**
whatever is on the level inside the rectangle rather than stacking on it, and
the only thing that refuses the whole plan is somebody standing in the
footprint. Dragging one over work already there takes it out, and takes one
press of undo to get back.

**The floor goes under the rock as well as under the cave.** Carving a wall away
by hand afterwards then leaves ground rather than a hole, which is what makes a
generated cave something you can keep editing. It costs a quad per wall cell;
`scripts/carve-caves.ts` makes the opposite trade, because at the scale of the
animal den those quads run to five figures.

A column of rock plus the floor under it has to fill `HEIGHT_PER_LEVEL` exactly
— a wall short of the top is a wall daylight and arrows go over, and one past it
overflows into the level above — so `columnOf` refuses any tile whose height
does not divide what is left rather than rounding either way. Two `half-stone`
and one `stone-wall` both divide the four a flat floor leaves; that is why the
rock picker is a short list rather than the catalogue, and where a full-height
rock block belongs when the catalogue gets one.

**The outermost ring stays full-height rock.** The low walls that break up the
edge — the ledges — are taken only where rock meets floor *inside* the
rectangle, because a low wall on the shell is a hole in the block-out, and what
you see over it is whatever the map has outside, which is usually nothing.

### A rectangle opens on to ground of its own kind

**A big cave or a big wood is several drags, so the rectangles have to join.** Every side of a
new rectangle is walked for runs of border cells whose outside neighbour is
ground this generator would lay itself, and each run gets **one** way in, at its
middle: a two-cell notch bored inward until it meets open ground. One per run
rather than one per cell — opening the whole run takes the shell off a cave's
entire flank.

**The floor has to be the top of that stack, not somewhere in it.** A cave's
rock stands on the same floor its cave does, so a shell cell contains the floor
tile as surely as an open one; a test that only asked whether the tile was
present would read every wall as an invitation. Anything standing on the floor
disqualifies it for the same reason — a bush is not a way in — and so does
ground of another kind, which is what stops a cave opening on to the grass
beside it.

**Nothing outside the rectangle is ever written**, which is what sets how far
the new one has to land over the old. A cave's shell is a cell of rock, and the
carve just inside it is nearly always rock too — the automaton counts what is
off the grid as rock, which weights the outermost column solid. Edge to edge
sees rock; one cell over sees the column behind it, which is also rock. **Two
cells in is the first place the neighbour's floor reaches.** The drag preview
shows the notch the moment it is found, so the right overlap is something you
can see rather than something to remember.

### Water cuts its own channel

The water is laid over the inside of the rectangle rather than over the floor
already carved, and **every cell it takes is opened** — a stream that runs into
rock takes the rock out. That is the order water and stone actually happen in,
and without it the streams read as puddles sitting in rooms somebody else dug.
The shell is the one thing it cannot erode, so the block-out stays closed.

Its brush is 2×2, for the same reason no passage is one cell wide: a channel one
cell across running east-west is drawn over by the wall in front of it, and an
invisible stream is not worth cutting. It also means an eroded channel already
satisfies `widenToTwo` — and since opening cells can only join things, nothing
after the erosion has to re-check the cave's connectivity.

Mostly streams, a sixth of the budget on basins: a floor a sixth under water
reads as a flooded cave rather than as a cave with a stream in it.

### Water is walkable:false, so streams have fords

A stream laid across a passage is a wall, and the half of the cave behind it is
a place nobody can reach. The alternative to allowing that was refusing to put
water anywhere narrow, which leaves streams as dashes rather than as streams.
So `cutFords` checks the dry floor once at the end and dries out the shortest
crossing back to each stranded piece. What that leaves on the map is a ford.

**One sweep, not one per stranded piece.** A flood from every dry cell at once
labels each water cell with the piece of floor nearest it, so wherever two
labels meet is a candidate crossing whose length is already known; taking those
cheapest-first with a union-find gives the same answer as reconnecting one piece
at a time. The version that did it one at a time ran twenty-seven floods on a
full-size rectangle and was most of the cost of planning a cave — 4.5ms of a
6.9ms plan, against 0.66ms now.

### It is planned on every drag step, so it has a budget

The preview is the plan (see above), which means the whole carve runs every time
the rectangle changes. At the 64×64 maximum, measured on a developer machine:
caverns ~3.3ms, veins ~1.1ms, tunnels ~0.7ms. Caverns is the one worth watching
— its smoothing passes are a 5×5 neighbourhood count per cell — and the sprawl
count is computed only on the passes that use it for that reason.

Noise is keyed on **world** coordinates rather than on a position within the
rectangle, so the pattern is anchored to the map: growing a drag reveals more of
the same cave instead of reshuffling the one already on screen. The seed is a
setting with a Re-roll button beside it, so the same rectangle carves the same
cave until you ask for a different one.

## A forest is a path and what grows either side of it

The forest generator (`app/editor/forest.ts`) lays a ground tile over the whole
rectangle, cuts one to three paths edge to edge across it, and plants trees
everywhere else at a density that rises with the distance from the nearest path.

**The path comes first and everything is measured from it.** Planting a wood
and then clearing a route through it gives a corridor through noise — a gap of
constant width with no relationship to what is either side of it. Measuring
from the path gives a route that opens out where it runs and closes in where it
does not, which is what a wood with a track through it actually looks like.

Because each path runs edge to edge, **its two ends are the way in.** That
matters at high densities, where the outer ring of the rectangle is nearly
solid: the wood reads as a wall of trees from the field beside it, and the
path's mouths are the gaps.

**A path is walked, not plotted.** Offsetting a straight crossing by a noise
field gives a line that bends but makes monotone progress along one axis by
construction — so a wood with one path in it is a wood with a stripe through it,
and if the axis comes from the path's index it is always the *same* stripe.
Instead a path picks its axis and direction from the seed, then walks to a mark
on the opposite edge, straying about two steps in five. It can double back,
cross itself and arrive from an angle.

Its brush is a square of the path's width, which is what keeps the route two
cells across however it turns. The outer corner of a two-wide staircase belongs
to no clear 2×2 square, so a band-and-offset path was planted over in its own
corners by the rule below.

### What sets the chance of a tree

Four terms, multiplied:

- **The density setting**, which is the ceiling the rest scales.
- **Distance from the nearest path**, which is the reason the path is drawn
  first. The falloff is proportional — 40% of the rectangle's shorter side, and
  never under six cells — rather than a fixed number. At a fixed six, everything
  past a path's verges is at full density and a large wood is a solid block with
  a corridor in it.
- **Two noise fields at different sizes.** `THICKET` decides which parts of the
  wood are close country and which are open; `CLUMP` puts stands and gaps inside
  each of them. **Where a wood is thick is not a property of where its edges
  are** — the first version raised the density towards the rectangle instead,
  and what that produces is a frame of solid trees around a clearing, which is
  the shape of the tool rather than the shape of a wood.
- **A dither at the edge.** The chance ramps down over the last five cells to
  three tenths of what it would otherwise be. **A wood should not end in a
  straight line**: the rectangle is how the wood was asked for, not something
  about the wood. Ramping to a *share* rather than to nothing matters — to
  nothing is not a dither, it is a bare margin five cells wide, and that is the
  rectangle showing through just as plainly.

### The same two rules a cave is held to

- **No gap you can walk through is one cell wide.** `widenToTwo` again, and here
  closing a cell means planting a tree in it. The reason is the camera's, not
  the wood's: a one-cell gap between two trees is drawn over by the tree in
  front of it, so it is somewhere you can walk and cannot see.
- **Every glade big enough to be worth reaching is reachable.** `joinRegions`
  cuts a two-wide track from the path to each one. The smaller pockets are left
  where they are, unreachable, because a hollow in a thicket you cannot quite
  get into *is* a thicket — and this is the one that took two goes. Planting
  every unreachable pocket instead turned the far half of a 40×40 wood into one
  solid block: a single path across the middle cannot reach past a dense band
  either side of it, so nearly everything qualified.

### Joining on to the wood next door

The same pass as the cave's, and for a forest it costs no overlap: the edge of a
wood is ground you can walk on, so a rectangle laid against another sees it and
clears a lane through. Those cells count as reachable in the same way a path
does — walking in from next door is walking in.

### The path and the water are the same shapes as the cave's

The path tile is laid **on top of** the ground tile, which is the grammar the
town's own roads use: `grass-2` with `cobblestone` over it. `None` still cuts
the route and still measures the trees from it — it just leaves it as a
clearing rather than flooring it.

Water is the same pass a cave uses, and it erodes the same way: a stream that
runs into a tree takes the tree out, and `cutFords` then breaks it wherever it
would otherwise cut the wood in two. Undergrowth is the same scatter pass, on
cells that are neither path nor water.

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

### Geometry is per (level, chunk), and only where the camera can reach

The renderer used to build every cell of every level the moment it had a map,
and rebuild a whole level whenever one of its chunks changed. Both costs are
the world's rather than the player's, and the den is what made that
unaffordable: 44,160 cells meshed for somebody who can see 23 across, and an
edit rebuilding 11,334 cells of cave floor.

What exists as geometry is now the chunks a window over the camera reaches
(`app/render/meshWindow.ts`). Three things follow, and each is load-bearing:

- **The unit is the chunk because copy-on-write already gives it identity.** A
  chunk that scrolled off is a group to dispose; a chunk that changed is a
  reference compare (`getChunk(prev, …) === getChunk(next, …)`). Nothing here
  hashes or walks cells to find out what moved.
- **The window takes each level's own shift, not the union.** The projection
  moves level `z` by exactly `z` cells. `lightWindow` unions the whole level
  span because a light on any storey can reach you; a level's *mesh* is drawn
  where that level is, so it takes that level's shift — the same distinction
  `appendVisibleTileEmitters` makes for a plume.
- **Levels are never culled, only their chunks.** A cut roof still has to be
  built: the cut is applied to geometry that already exists, as a group toggle
  for a whole storey and a shader mask for part of one. Deciding it here would
  rebuild a floor's meshes every time somebody stepped under an eave.

**The autotile seam is the one thing chunking breaks, and it is invisible in
the diff.** A cell restyles its eight neighbours, and a neighbour can be in the
chunk next door without that chunk changing. A whole-level rebuild covered that
for free. `dirtyChunks` therefore asks the merged-signature question over the
changed cells *and their ring*, and marks whichever chunk owns each cell whose
answer moved — so a wall placed at a boundary rebuilds both sides. Skip it and
you get a stale strip at a chunk edge that nothing later repairs.

Everything gameplay produces still takes the cheap path, for the reason it
always did: a mobile tile is never in the merged batch, so a step is one mesh
swapped inside a group that is otherwise untouched.

Measured on the den map, walking `/play` in a headless browser — an A/B, since
software GL makes the absolute numbers pessimistic:

| | before | after |
|---|---|---|
| `map` phase p50 | 66–140ms | 6.8–16.3ms |
| frame p50 | 115–183ms | 56–71ms |
| cells meshed at once | 44,160 | 5,237 mean, 11,104 worst |

The last row is the one that matters: it is a function of the window, so it
does not move when the map does.

**What it costs is draw calls: 51 per frame to 147**, because the merged batch
is now one per (chunk, texture) rather than one per (level, texture). The
`draw` phase did not move — 1.6–3.4ms before, 2.1–2.6ms after — so the submit
cost is in the noise at this count, and a modern GPU is nowhere near troubled
by it. If it ever does matter, the lever is re-merging a level's chunk batches
for the draw while keeping the build per chunk, which is real work and has not
been needed.

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

### A disposed material takes its compiled shader with it

Three refcounts a compiled GL program by the materials using it
(`releaseProgram` in `three.module.js`): dispose the last material holding one
and the program is destroyed, and the next material with the same source
compiles and links it again — inside `render`, on the frame it was wanted.
That lands in the **`draw`** phase, which reads as the renderer having got
slower and has nothing to do with drawing.

Almost nothing here can hit that, because almost every material in the world is
a `MeshBasicMaterial` or a `LineBasicMaterial` whose program the world is
already drawing with. The exception is the **outline shader**
(`app/render/overlayMeshes.ts`): it is the one program whose only users are in
the chrome layer, and the chrome layer is emptied and rebuilt whenever the
overlay signature changes — which is a pointer crossing from one interaction
row to the next, a target taking a step, or the mouse moving one cell in the
editor.
Every one of those was a full relink.

`OutlineMaterials` is the fix and the whole of it: the materials are lent out
and taken back rather than made and thrown away, so the count never reaches zero
and the shader is compiled once for the life of the page. `disposeGroupChildren`
takes the pool as an argument and asks it per material, so there is no ordering
to get wrong.

Two things to keep in mind before adding a second shader up there:

- **A pooled material must be re-dressed on every loan.** Everything that
  differs between two outlines is a uniform, and `uAlpha` in particular is
  written sixty times a second by the pulse — a material coming back from a
  pulsing outline starts the next steady one part-lit unless `dressOutline`
  puts it back. There is a test for exactly this.
- **The geometry is still thrown away per rebuild**, deliberately. A
  `PlaneGeometry` is a buffer, not a compile, and it costs microseconds against
  the milliseconds a relink costs. Pool it only with a measurement in hand.

Measured on `/play`, one outline going off and back on, `setOverlays` +
`renderOnce`: **0.50ms p50 pooled against 2.50ms relinked** (worst 1.3ms against
4.3ms). Two milliseconds is a quarter of the 8.3ms budget, spent on every hover
change. The number is from a warm Chrome shader cache and is the *floor* — a
cold cache is what makes this visible enough to report as a bug, and is why it
can look like it went away after a browser restart. To reproduce without editing
anything, call `world.outlineMaterials.dispose()` between rebuilds: that is
precisely what the old code did.

### An animated tile is drawn by the shader, and only a *mobile* one leaves the batch

Animation used to be a second reason for a tile to have a mesh of its own: the
only way to change a frame was to rewrite the UVs of geometry nobody else
shared. That is fine for the few dozen torches a map has and ruinous for water,
which is terrain — a 73-cell pond took the shipped map from ~50 world meshes to
131 against a budget of 96, and from ~124 draw calls to 205 against 180.

The frame is a function the **vertex** shader evaluates now. `app/render/animTable.ts`
bakes one level's animations into a small `RGBA32F` texture — a row per
animation, a texel per frame, holding that frame's atlas offset from frame 0 and
the millisecond it ends at — and each quad carries `aAnim`, a `(row, phaseMs)`
pair. `injectWorldShader` walks the row to the live frame and adds its offset to
`vMapUv`. The whole pond costs one uniform write per level per frame.
Measured on the shipped map: **131 world meshes and 205 draw calls became 23 and
50**, with triangles unchanged.

- **Vertex, not fragment.** A frame is constant across a quad, so this is four
  lookups per animated quad and the fragment stage — where the depth and
  lighting work is — is untouched.
- **A merged quad is built at frame 0; a separate one at the live frame.** The
  table's offsets are measured from frame 0, so a quad built anywhere else is
  shifted by however far the clock had run when its level was last rebuilt.
  `tableCanHold` is asked *before* the quad is built, by the same predicate
  `AnimationTable.add` uses afterwards, so the two cannot disagree about which
  kind of quad this is.
- **The table refuses what it cannot draw.** Frames that disagree about size,
  origin or sheet, and cycles past `ANIM_MAX_FRAMES`. All were already
  impossible for anything that animated under the old path — rewriting UVs into
  fixed geometry only works when the rect never changes — but they were
  impossible implicitly, and this path would mis-draw rather than refuse.
- **Rows are append-only**, which is what lets the incremental rebuild leave
  merged geometry alone: a new animation in a rebuilt cell cannot renumber the
  rows quads elsewhere are already pointing at.
- **`crossedFrame` is what stops a world with a pond in it rendering for ever.**
  The clock moves every frame; the picture only changes when it crosses a frame
  boundary.

### A phase is a vector on the sprite, and it is for art whose light does not vary

`TileSprite.phase` — `{ x: 3, y: -1 }` on water — advances the cycle by that
many frames per cell, so neighbouring placements are out of step. Without one a
pond is one motif stamped in lockstep and reads as wallpaper; the vector is what
makes the wave travel diagonally across it. It is deliberately a vector rather
than a hash of the cell: the direction is art direction, and a hash gives static.

**A sprite whose light varies may not declare one**, and `spritePhase` returns
nothing for the pair rather than trusting authors not to write it. The bake
caches a chunk per emission phase (see *A chunk holds one bake per emission
phase*), so a per-cell phase multiplies that by the number of distinct phases in
reach of the flood. Phasing the art and leaving the light alone is the worse
option — `animClock` is one clock precisely so a lamp's glow cannot drift from
its own flame. `app/lib/spritePhase.test.ts` asserts the catalogue never authors
the pair, so the guard never fires in practice.

The phase is always a whole number of frames, and that is load-bearing beyond
tidiness: shifting a cycle by one of its own boundaries lands its boundaries
back on the same set, so one `crossedFrame` answer covers every placement
however it is phased.

**It is set for the whole tile, never for one sprite.** The field lives on
`TileSprite` because the modulo is `frames.length`, which is per-sprite — but an
autotile is 47 sprites of one material, and nobody wants to phase a
neighbourhood apart from its neighbours. `withSpritePhase` writes one pair onto
every sprite the tile has, states included, and `tilePhase` reads one back;
the editor's "Frames per cell" control is those two functions and nothing else.
A phase of zero is stored as *no phase* rather than as `{x: 0, y: 0}`, so a tile
that was never phased and one that was phased back to nothing are the same tile.

Both live beside `mapStateSprites`, which is the write-side twin of
`stateSpritesOn` and now the only other place that knows where sprites
structurally hang off a tile. The read side was already careful about that; the
write side had `clampStateLight` open-coding the same walk.

**Rebuilding a sprite from its frames alone drops it.** `setFrames` in the tile
editor did exactly that — `setSprite({ frames: next })` — which made every frame
edit in the dialog, including changing a duration, silently unphase the tile.
Spread the sprite.

### The water autotile is generated from two masks, not drawn

`bun run generate:water` writes `data/tilesets/water.png` and the `water` tile's
47 slices together, from:

- `scripts/wave-frames.png` — the fourteen recovered wave frames, white where
  the wave catches the light. Not in `data/tilesets/` because it is not a
  tileset: nothing draws it, it is only ever an input.
- the green autotile block in `data/tilesets/floors.png` — its green pixels are
  the shape of each of the 47 neighbourhoods.

The slice-to-source-cell map is read off `dirt`, the ground autotile already laid
out on that sheet, rather than restated. A pond's rim has to tuck into its
neighbours exactly the way the ground does, and two hand-maintained copies of
the same 47-entry mapping would drift.

47 slices x 14 frames is 47 rows in the level's animation table and one texture
either way, so it costs a few hundred texels and **no extra draw call**. Measured
on the shipped map with the pond in view: 27 world meshes, 58 draw calls.

The tile is **opaque**, unlike the translucent slab water used to be. A wash over
whatever was underneath made a pond over a dirt bed read as mud; the ground still
shows at the rim, because that is where the autotile's own shape stops rather
than where its alpha does. Three tones, not two: the third is a shadow one pixel
down and right of every bright one, which is what stops a crest reading as a flat
line, plus a two-pixel band inside each slice's top and left edges so the water
reads as sunken into the bank rather than painted onto it.

**A phased pattern does not wrap within its own frame.** The shadow on a tile's
left column is cast by the pixel to its left, which is in the tile to the *west*
— and that tile is `phase.x` frames further round the cycle, so its column 7 is
not this frame's column 7. Wrapping within the frame is what a plain tiling
pattern wants, and this one only tiles across space after the clock has been
shifted per cell. The source frame therefore steps back by `-phase.x` across the
left seam, `-phase.y` across the top one, and both at the corner.

The consequence is worth stating plainly: **the phase is baked into the art.**
Change it on the tile — in the editor, say — and the sheet has to be regenerated
with `bun run generate:water`, or every tile's leading edges stop lining up with
its neighbours.

The bank band reads its edges off the slice's own shape, with off-tile counting
as inside. That is what separates open water, whose shape fills the tile and
which gets no band at all, from an edge slice whose outline the artwork already
cuts in. The reach is a square rather than a row and a column of it: two
separate reaches leave the corner where they meet unshaded, and a bank that turns
a corner in two strips with a gap between them reads as two shadows rather than
as one edge.

**A shaded autotile needs its corner slices, and a flat one does not.** The
ground autotiles map the whole 47-slice blob set onto the sixteen cells their
artwork has, so a cell with material on two sides but ground on the diagonal
between them draws the same square corner as one with material all round.
Nobody minded, because a flat fill makes the two identical. Water shaded from the
top and left is not flat: a corner with no nick taken out of it has no shade in
it either, and the bank stops exactly where the eye is looking.

So the generator cuts one pixel out of each corner the ground reaches into, on
top of the shape it borrows — one pixel because that is the radius the artwork
rounds its own corners by, and picking any other number would be picking a
different sheet's answer. The 47 slices become 47 distinct shapes rather than
sixteen repeated.

**Only the northern nicks cast a bank.** A nick at a *southern* corner is the
near shore: the light comes over the water's top-left shoulder, so that ground is
lit rather than casting, and letting it cast drew a bar of shadow running off to
the right along the bottom of the tile with nothing above it to explain itself.
So the bank is measured from a shape carrying only the north-west and north-east
nicks, while the tile is drawn from the shape carrying all four.

### Mobility is a property of the tile, not of the frame

`isMobileTile` (in `app/lib/interactions.ts`) answers "can this ever change
cell", derived from gravity and a push interaction rather than declared. Two
subsystems key off it and both must keep using the same answer:

- The renderer keeps mobile tiles **out of the merged geometry batch**, always —
  not only while they are moving. Membership used to follow the live motion set,
  so a tile joined and left the batch as it started and stopped, and changing
  membership rebuilds the whole floor. That was a full rebuild per step. This is
  now the *only* reason a tile leaves the batch: animation stopped being one when
  the shader learned to read a frame off a table.
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

#### Light-passing is not an authoring choice for anything that moves

The two regressions the section above describes were both a missing flag, and
both were found by measuring rather than by reading: `dynamicLightTileIds`
returning an empty set cost ~22ms on every player step, and `cat` and `deer`
carrying no `lightPassing` cost the same again every 200ms while they grazed.

`lightPassingForced` makes that class unrepresentable. Every `item`, every
`battler` and everything {@link resolveActor} recognises passes light, whatever
is authored on it, and the tile editor shows a line of text where the checkbox
used to be. The three sets are not the same — four shipped shopkeepers are
authored `kind: "prop"` and still walk about — so the rule is the union and not
the `kind` field alone.

It is applied in two places on purpose. `resolveLightPassing` answers for it, so
a hand-edited catalogue behaves correctly the moment it is loaded.
`normalizeTileDef` writes it, so what is on disk says the same thing as what the
game does with it.

**A prop nothing drives is still free to block light**, which is most of the
world: a wall, a roof, a closed door. The cost being avoided is specific to
things that move — an occluder that stays in the static bake and re-bakes the
chunks around it every time it takes a step — and to items, which are never
omitted from the bake but make every drop, pickup and decay an occlusion-class
edit that invalidates the full `LIGHT_APRON` instead of nothing at all.

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

### A floor is a lid; what stands on it is not

`stackOcclusion` answers two questions and they are not the same question.
`opacity` is blocking *height* over a level — how much of the cell you can see
past **sideways**, so a half-height sign is 0.5 and light gets over it.
`sealsLevel` is whether anything solid is in the cell at all, and that is what
decides whether light may travel **down** through it: however short it stands, a
solid tile covers its cell's whole footprint at the level's floor plane.

The sky flood used to decide its vertical edges with `seals && opacity <
TRANSMISSION_EPSILON` — "sealed *and* height zero", which is a test for a bare
floor rather than for a lid. Put a sign, a bush, anything 1–3 high on a patch of
grass and the cell scored 0.5 opacity, failed that test, and the seal was
skipped: daylight descended at half strength into the sealed room underneath and
the flood then spread it sideways through the whole room. Nothing about the
floor had changed. Something had been placed on it.

The rule now is one line in five places — `rayTransmission`, `castEmitter` and
`denseRayTransmission` in `app/lib/lighting.ts`, the column seed and the spread
in `app/lib/lightingFlood.ts` — and it is **`seals` alone**. Opacity takes no
part in a vertical decision, which is coherent because `opacity > 0` implies
`seals` by construction: only a non-light-passing tile contributes height. So
the two facts stay orthogonal, opacity is purely horizontal, and the seed
collapses to "paint the cell, then let anything solid end the shaft".

Two things this deliberately does not touch. Light-passing tiles seal nothing,
so the pond authored over the city dungeon and the ladder-top in a shaft are
still holes in the ground. And horizontal attenuation is unchanged: a half-block
still passes half the light travelling across it, which is what makes a low wall
read as a low wall.

The knock-on is in `scripts/carve-caves.ts`, whose `SEALED_ROOF` mask only
carves under a surface column that is *either* a bare floor *or* a full block,
because everything in between leaked. That restriction exists only because of
this bug and can now be relaxed to "anything that seals" — which is most of the
map's surface rather than the fraction of it that happens to be bare.

Measured on the fixture town, the bake is unchanged: p50 ~44ms either way, p95
47–50ms against a 65ms budget.

#### The lid belongs to the upper of the two cells

A tile sits on its own level's floor plane, so the lid between `z` and `z + 1`
is the seal of the cell at `z + 1`. Climbing out of `z` crosses that lid and
dropping out of `z + 1` crosses the same one. All three vertical rays —
`rayTransmission` and `denseRayTransmission` in `app/lib/lighting.ts`,
`denseRayTransmission` in `app/lib/lightingFlood.ts` — used to read the seal of
the cell the step *arrived* in, which names the right lid going up and one a
storey too low coming down. The first floor under a light therefore never
blocked it, and the check has to happen *before* the loop breaks on arrival, or
the last crossing of a descent goes unasked.

The other half of it was in `castEmitter`: the emitter's own cell had both its
opacity and its seal zeroed so it could not shadow itself. The opacity is right
— a torch in a wall lights the room — but that seal is the floor the emitter is
standing on, and it is exactly what should stop the light reaching the storey
below. Clearing it meant a lantern in a cave lit the cave underneath, straight
through solid rock. Only the opacity is cleared now, which is safe because every
emitter in `data/tiles.json` is `lightPassing`: the tile never contributes the
seal it would then be blocked by. A fixture torch that is *not* `lightPassing`
is a fixture testing itself, and `app/lib/lighting.test.ts` was changed to match
the catalogue.

Measured over 400 cave cells on `data/map.json` that have a storey beneath them,
with a radius-6 lantern at each: the brightest light landing directly below the
lantern went from 0.53 to 0. What remains is light going down authored holes,
which is the whole point of a hole.

### Empty space with nothing under it is void, and void is black

A cell is **void** when its column holds no tile at that level or any level
below it — past the map's edge, under a bridge, beneath a pond authored over
nothing. `computeLightingFlood` in `app/lib/lightingFlood.ts` marks it from the
column's lowest tile (gathered on every level, so a windowed bake sees a tile
under its floor), and then three things are true of it: it bakes with sky 0 and
block 0, the sky flood never relaxes into it, and a block emitter never lands
light in it. Its opacity stays 0, so a ray still *crosses* it: a torch lights
the far side of a chasm and not the drop. `denseOcclusionIn` in
`app/lib/lighting.ts` carries the same mask for the per-frame overlay, probing
under the reach for a tile only in columns that have room below their lowest
one, so a carried torch at a cliff's edge does not relight what the bake left
black.

What it fixes is not the void itself — nothing is drawn there — but where the
shaft went afterwards. The column seed used to paint the full shaft down every
empty column to the bottom of the world, and the flood then carried it
*sideways* under the floor: a basement one cell in from the map's edge was
daylit through the ground, and got darker at night. The seed still paints down
to the first seal, wherever that is, so daylight lands on the top of every
column exactly as before; it only stops where the tiles stop. The frontier
seeding relies on this being the bottom of a column and nothing else: a column
void from the top gets a `fullFrom` below the domain, so it neither seeds
itself nor raises a neighbour's frontier.

The clear colour follows. `VOID_BACKGROUND` in `app/lib/lighting.ts` is black,
for play and for the editor's preview, replacing a sky tint that rode on the
clock keyframes and read as a lit floor plane under every level — the grey
around a level −1 cutaway that dimmed at dusk. Authoring keeps its paper
colour, and preview with lighting off keeps it too, where black behind fully
lit tiles would only read as a hole.

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

### The map a unit test runs against is never `data/map.json`

`data/map.json` is authored content, edited constantly and from inside the game
as much as by hand. Tests that read it broke on ordinary authoring — moving a
shopkeeper across the square, roofing a building, swapping a wall for a window
— and each break was a red build that said nothing about the code. They were
re-baselined a few times before it was worth admitting the map was not the
thing under test.

`app/lib/fixtureTown.ts` is the stand-in: a generated walled town on a road
grid, with roofed houses, a lamplit street grid, a forest and a cave under the
square. It exists for two reasons.

- **Coverage.** The mix is chosen for the branches the lighting and geometry
  paths split on: sky-exposed cells and roofed ones, half-height occluders that
  block sight but still take part in the sky flood, emitters at four levels,
  and a level under the ground plane that sees no sky at all.
- **A standing scale.** It is sized near the shipped map — 23.0k cells, 29.8k
  quads and 68 emitters against 20.9k / 38.7k / 68 — and measures ~44ms p50 /
  ~46ms p95 on the cold bake where the shipped map measured ~41/42. That is
  what makes `PERF_BUDGETS.lightingBakeMsP95` mean something a year from now:
  the budget used to be re-raised every time the world grew, and half of those
  raises were content rather than code. `app/lib/mapData.test.ts` pins the
  fixture's quad count so a future trim cannot silently make the budget pass.

`data/tiles.json` stays real in all of these. Heights, `lightPassing` flags and
per-frame emitter radii are what the code under test is reasoning about, and a
fixture tile with an invented radius tests the fixture. Keep the catalogue,
build the geometry.

#### A tile edit that reddens the suite is usually pointing at the fixture

The catalogue staying real has a cost, and it is worth naming so the next one
is read correctly rather than reverted. `torch` gained `lightPassing: true`,
which is a fix — a wall torch is a prop that hangs on a wall, and without the
flag its four height units sealed its own cell, so a torch shadowed itself and
cut the daylight to whatever was under it. That edit turned
`lightingChunksAsync.test.ts` red.

The test was asserting that a torch placed at `(0, 0, 0)` changes the level-0
plane once the off-thread bake lands. It never did. That cell is the fixture
town's square, sky-lit past anything a torch adds, and the emitter's light
lands on the levels around it and not on its own plane. The one thing the edit
had ever moved there was a single pixel — the torch's own cell, dimmed and
marked sealed by the occlusion it should never have had. Take the occlusion
away and the assertion had nothing left to hold.

So the failure was not the content and not the budget. **The test's scenario
never matched its claim, and a tile edit removed the coincidence that had been
standing in for it.** The fix is the same rule as the map: build the scenario
the test is about. The edit moved to `(4, 4, -1)`, on the cave floor under the
square, which is the part of the fixture that exists for exactly this — no sky
reaches it, so a torch there is the only light there is and its bake moves 94
pixels rather than one. The placement passes against the catalogue on either
side of the change, which is the point: it is measuring the light, not a side
effect of the tile's height.

Two things to do when a `data/tiles.json` edit turns a test red. Find which
pixels the assertion was actually holding onto — if it is one, or if it is the
edited cell itself, the scenario is the suspect and not the content. And check
whether the test still fails for the reason it exists: sabotage the mechanism
under test (here, releasing the bake against the pre-edit map) and confirm it
goes red.

Claims *about* the shipped world went with the map: "the shopkeeper is placed
somewhere", "the authored map is mostly static tiles". Both read as safe
because they name no coordinate, and both still failed on an afternoon's
authoring. If a claim really is about the world we ship, the Playwright run
against a real world is where it belongs.

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

- **A chunk that comes into range is built in the frame it does.** Geometry is
  per (level, chunk) now — see the section above — so the cliff that used to be
  a whole floor is at most `CHUNK_SIZE` squared. What is left is that the build
  happens on one frame rather than spread over several: walking into a fresh
  chunk column of dense cave is a handful of chunks at once. `MESH_WINDOW_MARGIN`
  is what buys the warning, and a budget that built one chunk per frame out of a
  queue is the structural answer if it is ever felt.
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
