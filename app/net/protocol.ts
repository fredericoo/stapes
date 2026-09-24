import * as v from "valibot";
import { CAST_SQUARES, type CastProgress, type CastSlot } from "../game/casting";
import { MAX_SPELL_NAME_LENGTH } from "../lib/battler";
import type { Equipment } from "../game/equipment";
import type { SlotRef } from "../game/itemMoves";
import { SWING_OUTCOMES, type SwingOutcome } from "../game/GameSession";
import { STRIKE_KINDS, type StrikeKind } from "../game/strike";
import type { ConsumeSource } from "../game/itemUse";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import { masteryXpBlockSchema, type MasteryXp } from "../lib/mastery";
import type { Extraction, ExtractionProgress } from "../game/extract";
import type { Progress } from "../game/progress";
import type { Coord, PlacedTile } from "../lib/types";
import { TRANSITION_SIDES, type TileTransitionNote } from "../lib/tileTransition";
import { MAX_CHAT_RAW_LENGTH } from "./chat";
import { MAX_COMMAND_LENGTH } from "../game/commands";

/**
 * The wire between a browser and the game server.
 *
 * Two kinds of thing travel here, and keeping them apart is what makes the
 * protocol cheap:
 *
 * - **Cell patches** are the truth. The map is copy-on-write and chunked, so
 *   the server diffs one tick against the last broadcast by chunk identity and
 *   a step falls out as exactly the cells it touched — two, on a floor of
 *   thousands. Everyone is at the same map version, so it is one diff and one
 *   serialization per tick regardless of how many people are connected.
 * - **Motion events** are animation hints for things the map cannot express
 *   yet. A walk commits to the map only when it lands, so the server announces
 *   it at the start and the cell patch arrives 200ms later, exactly as the
 *   client's interpolation finishes. There is no position stream: a walking
 *   actor costs one event, not one message per tick.
 *
 * Both are the server talking about *other* people. A client draws its own
 * movement the instant it decides on it and tells the server afterwards, so for
 * the actor it owns these two are confirmation arriving late rather than news —
 * see {@link ClientMessage}'s `step`.
 *
 * Chat is the third kind and rides on its own message rather than inside a
 * patch, because it is the only thing here that is *not* for everybody. A
 * message goes to the sockets on the author's level and no further, so it cannot
 * share the one-serialization-for-all broadcast that makes patches cheap. Kept
 * apart, the patch path keeps that property untouched and chat pays its fan-out
 * only in the moment somebody talks.
 *
 * Everything inbound is parsed rather than cast — it arrives from a browser
 * nobody controls, and a malformed message must be a dropped message, not a
 * crashed world.
 */

const coordSchema = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
});

/**
 * An end of a projectile's flight: a cell on the plan and an absolute height.
 *
 * Not a {@link coordSchema}, and the difference is the whole reason a shot can
 * be aimed at somebody standing on a crate: `z` names a floor, and a body half a
 * level up is on the same floor as the one that shot at it. See
 * `../game/distance`, which measures reach in these and never in floors.
 */
const flightPointSchema = v.object({
  x: v.number(),
  y: v.number(),
  elevAbs: v.number(),
});

const objectRefSchema = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
  stackIndex: v.number(),
});

const directionSchema = v.picklist(["n", "e", "s", "w"] as const);

/**
 * Cap on an actor id crossing the wire inbound.
 *
 * A real one is a uuid — an actor id is a character id, minted when the
 * character was made — so it is far under this; the bound exists because the
 * only inbound message carrying one is a target, and a target is *kept*. An
 * unbounded string would be held in an actor slot for as long as the client
 * cared to keep pointing at it.
 */
const MAX_ACTOR_ID_LENGTH = 128;

const hpPatchSchema = v.object({
  actorId: v.string(),
  hp: v.number(),
  maxHp: v.number(),
  rating: v.number(),
});

const namePatchSchema = v.object({
  actorId: v.string(),
  name: v.string(),
});

/**
 * One running status, as the viewer's own client needs it.
 *
 * `durationMs` travels beside the remainder so a client could draw how far
 * through it is without having to have seen it start — which a reconnecting one
 * never did.
 */
const statusPatchSchema = v.object({
  defId: v.string(),
  remainingMs: v.number(),
  durationMs: v.number(),
});

/**
 * The pull this viewer is part-way through, and how far through it they are.
 *
 * The shape `../game/extract` already holds it in — see `Extraction`, whose
 * note argues why both numbers travel. Validated rather than trusted like
 * everything else here, and the remainder is not clamped against the duration:
 * a client that draws a bar reads them as a fraction and clamps it there.
 */
const extractionSchema = v.object({
  key: v.string(),
  remainingMs: v.number(),
  durationMs: v.number(),
});

/**
 * The wait before this viewer's next blow, and how far through it they are.
 *
 * The shape `../game/progress` already holds it in, on {@link extractionSchema}'s
 * terms and with one fewer field: a wait has no key, because there is only ever
 * one of them and it belongs to the body being told about it.
 */
const nextBlowSchema = v.object({
  remainingMs: v.number(),
  durationMs: v.number(),
});

const carriedLightsPatchSchema = v.object({
  actorId: v.string(),
  tileIds: v.array(v.string()),
});

/**
 * Where a cast came from, as it travels.
 *
 * The one shape both directions use: a client says which button it pressed, and
 * the broadcast says which button a body is busy with. A variant rather than a
 * string, on `../game/casting`'s {@link CastSlot} terms — a spell somebody
 * called "charm" must not be the charm square.
 */
const castSlotSchema = v.variant("from", [
  v.object({ from: v.literal("square"), square: v.picklist(CAST_SQUARES) }),
  v.object({
    from: v.literal("natural"),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SPELL_NAME_LENGTH)),
  }),
]);

const statusIdsPatchSchema = v.object({
  actorId: v.string(),
  defIds: v.array(v.string()),
});

const pvpPatchSchema = v.object({
  actorId: v.string(),
  on: v.boolean(),
});

const extractionPatchSchema = v.object({
  actorId: v.string(),
  progress: v.nullable(v.object({ remainingMs: v.number(), durationMs: v.number() })),
});

/**
 * The cast a body is part-way through, shaped exactly like the pull above it.
 *
 * Two schemas rather than one shared one, because they are two facts that
 * happen to be two numbers: a body may be told to stop pulling and to start
 * casting in the same patch, and a single field would make that one message
 * arguing with itself. @see CastingPatch
 */
const castingPatchSchema = v.object({
  actorId: v.string(),
  progress: v.nullable(
    v.object({
      remainingMs: v.number(),
      durationMs: v.number(),
      // Which button, so the caster's own row can offer to stop it — the same
      // shape the `cast` message names one with. @see CastingPatch
      slot: castSlotSchema,
      // Who it will land on, for the line drawn between the two. Absent for a
      // spell at the caster's own body. @see CastingPatch
      targetId: v.optional(v.string()),
    }),
  ),
});

const afflictedPatchSchema = v.object({
  x: v.number(),
  y: v.number(),
  z: v.number(),
  tileId: v.string(),
  defIds: v.array(v.string()),
});

/**
 * One carried thing, as it travels.
 *
 * Loose in `contents` rather than recursive, because a container may not hold a
 * container — see `../lib/item`. Depth is exactly one, so a schema that recursed
 * would be describing a shape the rules already forbid.
 */
const itemInstanceSchema = v.object({
  id: v.string(),
  tileId: v.string(),
  direction: v.optional(directionSchema),
  channel: v.optional(v.string()),
  /**
   * What is written on it, and what turning it over tells you — two different
   * questions, and named separately here for {@link count}'s reason: a
   * validated object drops what it does not name, so a missing one is a sign
   * that arrives blank or a skull that forgets what killed its owner.
   */
  inscription: v.optional(v.string()),
  description: v.optional(v.string()),
  /**
   * Whose this one is, for a thing whose name has a hole in it.
   *
   * Named here for the reason {@link count} is: a validated object drops what it
   * does not name, so an engraving missing from this schema is a skull that
   * arrives in the bag belonging to nobody. On the `contents` shape too — a
   * skull in a chest is the ordinary place to keep one. See `../lib/engraving`.
   */
  engraved: v.optional(v.string()),
  /**
   * How long an arcane stone has left before it can be cast again.
   *
   * **The one field a kit carries that is about time**, and it has to be on this
   * schema rather than left to ride along: a validated object drops what it does
   * not name, so a cooldown missing here is a button that never dims however
   * carefully the server counts. Absent for every item in the world that is not
   * a cooling stone, which is nearly all of them.
   *
   * Not on the `contents` shape below, and deliberately: a stone may not be in a
   * bag while it is cooling — see `../game/equipment`'s `stoneLocked` — so a
   * cooldown down there would be describing a state the rules forbid.
   */
  cooldownMs: v.optional(v.number()),
  /**
   * How many of it this is — a pile of berries rather than a berry.
   *
   * Named here for the reason {@link cooldownMs} is: a validated object drops
   * what it does not name, so a count missing from this schema is twelve berries
   * arriving as one the moment the wire is crossed. On the `contents` shape too,
   * unlike the cooldown, because a bag full of piles is the ordinary place to
   * find them. See `../lib/piles`.
   */
  count: v.optional(v.number()),
  contents: v.optional(
    v.array(
      v.object({
        id: v.string(),
        tileId: v.string(),
        direction: v.optional(directionSchema),
        channel: v.optional(v.string()),
        inscription: v.optional(v.string()),
        description: v.optional(v.string()),
        engraved: v.optional(v.string()),
        count: v.optional(v.number()),
      }),
    ),
  ),
});

const equipmentSchema = v.object({
  weapon: v.nullable(itemInstanceSchema),
  // Defaulted rather than required, so a client from before the off hand existed
  // still reads a `hello` from a server that has one. Every slot added after the
  // first two is defaulted for that reason and keeps it: a square nobody had yet
  // has a right answer for its own absence, which is the same answer an empty
  // one gives. `weapon` and `bag` stay required because no build that could
  // reach this schema has ever been without them.
  offhand: v.optional(v.nullable(itemInstanceSchema), null),
  armor: v.optional(v.nullable(itemInstanceSchema), null),
  head: v.optional(v.nullable(itemInstanceSchema), null),
  charm: v.optional(v.nullable(itemInstanceSchema), null),
  footwear: v.optional(v.nullable(itemInstanceSchema), null),
  bag: v.nullable(itemInstanceSchema),
});

/**
 * A kit, or nothing at all — never a reason to throw the message away.
 *
 * The one field on this wire that is allowed to fail on its own, and the
 * asymmetry is the point. Every other part of a `hello` describes the world, and
 * a client that could not read it has nothing to draw; equipment describes one
 * player's pockets, and a client that cannot read *that* can still stand in the
 * world and walk around in it.
 *
 * Without this the two were one fate. An instance the schema would not accept —
 * an item minted by a build that did not exist yet, or one that missed a minting
 * pass — took the whole `hello` down with it, and `RemoteSession` drops an
 * unparseable frame silently. The result was a tab that connected, streamed
 * patches for as long as you left it open, and never finished joining, with no
 * way in the game to put down the thing that was doing it. A kit is not worth a
 * world.
 *
 * **Empty rather than partial**, which is also what keeps this from becoming a
 * duplication bug. The server is the only authority on who is holding what; a
 * client that salvaged the half of a kit it could read would be inventing the
 * other half, and two clients inventing differently about the same contested
 * item is how one sword becomes two on the screen. Showing nothing is a client
 * that is visibly out of date, which is a thing a player can see and a refresh
 * can mend — and the server's next `equipment` message corrects it outright.
 */
const tolerantEquipmentSchema = v.fallback(equipmentSchema, {
  weapon: null,
  offhand: null,
  armor: null,
  head: null,
  charm: null,
  footwear: null,
  bag: null,
});

/**
 * What somebody has learnt, or nothing at all — tolerant on exactly the terms a
 * kit is.
 *
 * A block of experience describes one player's competence, and a client that
 * cannot read it can still stand in the world and swing at things: the fight is
 * resolved server-side and this is only what the panel draws. Empty rather than
 * partial for the same reason, too — the server is the authority, and a client
 * salvaging half a block would draw a mastery list that is quietly wrong until
 * the next message corrects it.
 */
const tolerantMasteryXpSchema = v.fallback(masteryXpBlockSchema, {});

/** One cell's whole stack, replacing whatever the client had there. */
export type CellPatch = {
  x: number;
  y: number;
  z: number;
  stack: PlacedTile[];
  /**
   * What is running on the placements in this cell — the ground that is on
   * fire. Replaces what the client had for the cell, like the stack does, so
   * **absent means nothing is burning here**. @see CellAffliction
   */
  afflicted?: CellAffliction[];
};

/**
 * What is running on one placement in a cell, named by tile id — see
 * `../game/endure`'s `poolKey` for why an index is not a name a placement can
 * keep.
 *
 * **Carried on the cell rather than in a list of its own**, so it goes wherever
 * the cell goes and nowhere else: a status change marks its cell changed, and
 * the cell is scoped to the clients subscribed to its chunk exactly as a tile
 * swap is (`./scope`'s `cellsInScope`). A chunk handed over as it comes into
 * reach carries its fires with it. Nothing about a fire outside a client's
 * ground goes on the wire, and the server keeps no per-client record to decide
 * that.
 *
 * No countdown, for {@link StatusIdsPatch}'s reason: a remaining time is a
 * per-second message per cell that only a wind-down would read.
 */
export type CellAffliction = {
  tileId: string;
  defIds: string[];
};

/**
 * What to call one body, said once and never again.
 *
 * **The only fact on this wire that cannot change.** A character's name is
 * typed at creation and is fixed after that, so this is not a diff of anything
 * — it is the server introducing a body the client has not met. A client holds
 * what it is told forever: there is no message that corrects a name, because
 * there is nothing that could move one.
 *
 * Creatures are absent from this entirely. A deer is named after its tile, off
 * the catalogue both ends already hold, and sending "Deer" once per deer per
 * `hello` would be a string for every body on the board to say what the tile id
 * beside it already says. @see `../game/displayName`
 */
export type NamePatch = {
  actorId: string;
  name: string;
};

/**
 * One actor's hit points, as the server last saw them.
 *
 * State rather than an event, and it travels on the same terms cell patches do:
 * a whole current value replacing whatever the client had, sent only for the
 * actors whose reading actually changed. A client that added up damage events
 * instead would drift the moment one was missed, and the bar over somebody's
 * head would go on being wrong with nothing to correct it.
 */
export type HpPatch = {
  actorId: string;
  hp: number;
  maxHp: number;
  /**
   * The body's ⭐, riding beside its hit points.
   *
   * Its own channel would be a third diff and a third message for a number that
   * moves less often than anything else here — a creature's never moves at all.
   * They belong together besides: both answer "what is this body, right now",
   * and both are the part of a body everybody is allowed to see.
   */
  rating: number;
};

/**
 * One status running on the viewer's own body.
 *
 * A `StatusInstance` minus its cadence accumulator, which is the server's
 * bookkeeping and nothing a client could draw. Everything else about a status —
 * its name, its line, its icon, what it does — is in the catalogue both ends
 * already load, so what travels is an id and two clocks.
 */
export type StatusPatch = {
  defId: string;
  remainingMs: number;
  durationMs: number;
};

/**
 * The lit things one actor is carrying, as the server last saw them.
 *
 * The one part of a kit that is broadcast rather than sent to its owner alone,
 * and the split is not arbitrary: **everybody can see a torch.** The rest of an
 * inventory changes nothing anybody else can observe — there is no paperdoll and
 * a drawn sword is not a different sprite — but a lantern lights the room for
 * whoever is standing in it, so its existence is world state.
 *
 * Tile ids rather than resolved lights, for the reason the protocol sends tile
 * ids everywhere: the catalogue is already on every client, and sending what the
 * receiver can look up would be sending the same three numbers per torch per
 * change.
 *
 * State, diffed exactly as {@link HpPatch} is — a whole current list replacing
 * whatever the client had, sent only for the actors whose list changed. It
 * changes when somebody equips something and never on a tick of walking, so in
 * practice it is absent from almost every patch.
 */
export type CarriedLightsPatch = {
  actorId: string;
  tileIds: string[];
};

/**
 * Which statuses a body is under, and deliberately **not how long they have
 * left**.
 *
 * Broadcast, unlike {@link StatusPatch}, and the difference between the two is
 * the whole design. `StatusPatch` is the viewer's own: it carries a countdown
 * because a countdown is drawn beside their icons, and it is per-socket data, so
 * folding it into the shared patch would cost one serialization per player.
 * This is the same list stripped of everything only the bearer needs, which
 * makes it the *same bytes for everybody* — one diff, one serialization, and an
 * empty array on almost every tick.
 *
 * The ids are enough for what other bodies are drawn with: a tint, a plume and a
 * cast light are all properties of the *def*, so a client that knows a rat is
 * poisoned can draw a poisoned rat. What it cannot do is wind the effect down —
 * see `../lib/statusVfx`'s `taperMs` — because that needs a remaining time, and
 * a remaining time is a per-second message per body that nothing else would use.
 * Somebody else's poison therefore burns at full strength until it ends. That is
 * a deliberate trade, not an oversight.
 */
export type StatusIdsPatch = {
  actorId: string;
  defIds: string[];
};

/**
 * Whether a body is fighting other players. @see `../game/pvp`
 *
 * Its own patch rather than a field on {@link StatusIdsPatch}, and the two are
 * not the same kind of fact however alike the message looks: a status is
 * something happening to a body right now, and this is a standing decision
 * somebody made that survives their reconnecting. Folded together, every burn
 * in the world would carry a switch nobody moved.
 *
 * Broadcast because it is drawn: the mark beside a name says whether that
 * stranger can be fought, which is a thing you have to be able to read before
 * deciding anything. Sent when it changes, which for most bodies is never.
 */
export type PvpPatch = {
  actorId: string;
  on: boolean;
};

/**
 * The pull a body is part-way through, or null once it has stopped.
 *
 * Broadcast beside the viewer's own `extracting` message rather than instead of
 * it: that one carries the key the viewer's interaction row matches against,
 * and this carries only the fraction a bar over a head needs — which makes it
 * the same bytes for everybody, the argument {@link StatusIdsPatch} makes.
 *
 * Sent when a pull starts and when it ends, never while it runs. Both halves of
 * the fraction travel, so a client winds the bar on its own render clock.
 */
export type ExtractionPatch = {
  actorId: string;
  progress: ExtractionProgress | null;
};

/**
 * The cast a body is part-way through, or null once it has stopped.
 *
 * {@link ExtractionPatch} for spells, and it carries the same two numbers for
 * the same reason: what everybody else can see of somebody's cast is a bar over
 * their head, and the bar needs both halves of a fraction to fill on its own.
 *
 * **Which square travels too**, for the caster's own row: the button the cast
 * came out of is the one that stops it, so it has to know it is that button.
 * Nobody else draws it — the bar is the same bar whatever is being cast — and it
 * rides the broadcast rather than an owner's channel because it is one word on
 * a message that was going out anyway. @see `../game/casting`'s `CastProgress`
 *
 * **Who it is aimed at travels too**, for everybody: the dotted line from caster
 * to target is drawn on every screen that can see them, and it is sent again
 * when the caster points at somebody else mid-cast, as well as at the two ends.
 *
 * Sent when a cast starts, when its target changes and when it ends — never for
 * the clock running down.
 */
export type CastingPatch = {
  actorId: string;
  progress: CastProgress | null;
};

/**
 * One burning placement and the cell it is in, for a `hello`: the map a joiner
 * is sent has no room for it, so the fires in the joiner's ground travel beside
 * it. After that, every change arrives on a cell. @see CellAffliction
 */
export type AfflictedPatch = {
  x: number;
  y: number;
  z: number;
  /** Which placement in the cell — see `../game/endure`'s `poolKey`. */
  tileId: string;
  defIds: string[];
};

export type MotionEvent =
  | {
      kind: "walkStarted";
      actorId: string;
      from: { x: number; y: number; z: number };
      to: { x: number; y: number; z: number };
      direction: "n" | "e" | "s" | "w";
    }
  | {
      kind: "fallStarted";
      actorId: string;
      feetAbs: number;
      landingAbs: number;
    }
  | {
      kind: "slideStarted";
      actorId: string;
      /** Lowest of the shoved placements. @see SlideSnapshot */
      object: { x: number; y: number; z: number; stackIndex: number };
      from: { x: number; y: number; z: number };
      /** How many placements travelled, `object` included. */
      count: number;
    }
  /**
   * A body moved because of a blow — the swinger throwing itself forward, or the
   * defender getting out of the way.
   *
   * The whole of what the animation needs, and deliberately not the other body's
   * id: by the time this is drawn that body may be gone, since a killing blow
   * takes its target off the board on the same tick. The delta is the direction
   * the lean goes, and it outlives whoever it was measured against.
   *
   * Its own event rather than a flag on `damage`, because the two are not the
   * same fact: a blow out of arm's reach floats a number and no lean, and a
   * dodge is now the reverse — a movement and no number at all.
   */
  | {
      kind: "strikeStarted";
      actorId: string;
      /** Which end of the blow this body was on. @see `../game/strike` */
      strike: StrikeKind;
      /** Cells to travel on the plan. */
      dx: number;
      dy: number;
      /** Height units to travel, absolute. */
      dElev: number;
    }
  /**
   * Somebody arrived, or somebody went.
   *
   * Both carry the headcount that resulted rather than leaving the client to
   * add and subtract, because a client that keeps its own tally has to start it
   * from somewhere and the `hello` that would seed it crosses with the `joined`
   * announcing the same arrival — so the very first thing a tab learns would be
   * counted twice. Sent as a whole number that replaces the last one, these
   * cannot drift.
   */
  /**
   * Somebody was moved by the board rather than by their own legs.
   *
   * Carries no destination, because the cell patches in the same frame already
   * say where everybody is. What it carries is the only thing the board cannot:
   * that whatever this client was drawing for that body is void. For your own
   * body that is a prediction to throw away — see `RemoteSession`, which treats
   * any motion of its own it did not predict as exactly that — and for anybody
   * else's it is a lerp that must stop rather than drag a sprite across the map.
   */
  | { kind: "teleported"; actorId: string }
  /**
   * A body threw a blow, and is planted for two of its own steps because of it.
   *
   * **Its own event rather than a flag on `strikeStarted`, because half the
   * blows in the game do not lean.** An archer never throws itself at anything
   * — the arrow is what travels — and a bow that let its holder keep walking
   * while a fist did not would be the balance rule applying to whoever picked
   * the wrong weapon.
   *
   * Carries no duration, on exactly the terms a walk carries none: how long a
   * body is planted is how long that body takes to walk, twice, and both ends
   * read that off the tile it is. See `../game/combat`'s `strikeRecoveryMs`.
   *
   * What it plants is the aim as well as the feet — a body that has just swung
   * faces what it swung at until the recovery runs out — so this is also the
   * event that tells a predicting client to stop painting its own facing over
   * the server's. @see `../game/GameSession`'s `turnToward`
   *
   * What it is *for* is the one body a client decides the footwork of — its
   * own. Everybody else's walking arrives as `walkStarted` already gated, so
   * this tells them nothing they are not about to be shown.
   */
  | { kind: "swung"; actorId: string }
  | { kind: "joined"; actorId: string }
  | { kind: "left"; actorId: string }
  /**
   * A body the world has taken on since this client's `hello`.
   *
   * **A client's actor set is `hello` plus what it is told afterwards**, and
   * until this existed the only things it was told about were sockets opening
   * and closing. Everything else a world adopts at runtime — a creature that
   * respawned, one somebody summoned with `/tile` — arrived with no
   * announcement, and reached the client only when it happened to move: a
   * `walkStarted` for a body it has never heard of is the event that quietly
   * added it. So a body that never moves was never added at all. Its tile is
   * drawn, because a body is a tile in a stack and cell patches carry that, and
   * everything keyed on it is absent: no name over its head, no health bar, no
   * Talk row. That is a shopkeeper who cannot be spoken to until you reload.
   *
   * Distinct from {@link joined} rather than folded into it because a joiner is
   * a *person*, and the count it carries is the answer to "how many people are
   * in the world". A rat is not one of them.
   *
   * Carries the id and the cell, and nothing else: what the body is holding and
   * what it has left are on their way in the same frame, as the hit-point and
   * light diffs beside this.
   *
   * **The cell is here to keep the receiver off a board sweep.** A client's
   * `motions` entry is looked up through `locateActor`, which confirms the last
   * cell it saw a body in before searching — and a body it has never heard of
   * has no last cell, so the lookup falls all the way through to
   * `findActorAnywhere` and walks the whole board. Once a spawn was a rare
   * event and that was a cost nobody could measure; now every body entering a
   * client's subscription is one, so the sweep would be paid for every creature
   * a player walks past. @see `./scope`
   */
  | {
      kind: "spawned";
      actorId: string;
      /** Where its tile is in this same frame's board. */
      at: { x: number; y: number; z: number; stackIndex: number };
    }
  /**
   * A body this client is no longer being told about.
   *
   * {@link spawned}'s other half, and it exists because the subscription moves:
   * a body that walks out of the chunks this client holds — or that stands
   * still while the client walks away from it — stops being somebody the server
   * sends hit points, statuses or steps for, and the client has to stop holding
   * an entry for it on exactly the same tick.
   *
   * **The entry is what costs, not the memory.** `RemoteSession` reads every
   * body's position off its own board, and a body it has no ground for is the
   * one case where that lookup sweeps the whole board rather than confirming a
   * cell — every frame, for as long as the entry sits there.
   *
   * This is not a death and does not mean the body is gone: it says only that
   * this client is no longer being kept current about it. What a death looks
   * like on the wire is unchanged — the tile is simply not in any cell of the
   * frame that took it off the board. @see `RemoteSession.forgetDeparted`
   *
   * Never sent for a client's own body, on the terms `ownersLeaving` excludes
   * it: a player's own death is told rather than inferred, and the subscription
   * is centred on their body, so the only way to be outside it is to have no
   * body at all.
   */
  | { kind: "despawned"; actorId: string }
  /**
   * A blow landed, worth this much.
   *
   * An event rather than state, unlike {@link HpPatch}, and the pair is the same
   * split the whole protocol is built on: the bar over a head is a fact about
   * the world right now, while the number floating off it is something that
   * *happened* and cannot be recovered by comparing two readings — three hits in
   * one tick are three numbers and one new total.
   *
   * The cell travels rather than only the actor id, because a killing blow takes
   * its target off the board on the same tick: by the time this is drawn there
   * may be nobody by that name left to ask where they were standing.
   */
  /**
   * A shot was loosed.
   *
   * **Its own event rather than a flag on `damage`, on exactly the terms
   * `strikeStarted` is one.** The two are not the same fact: a melee blow floats
   * a number and puts nothing in the air, and a shot that killed its target
   * floats a number over a body that is already gone while the arrow carries on
   * to where it was standing. One is what the blow came to; the other is what it
   * looked like.
   *
   * Carries no actor id at either end, and that is the same reasoning
   * `strikeStarted` carries a delta rather than a target: by the time this is
   * drawn there may be nobody at either end to look up. What it carries is two
   * fixed points and a duration, which is everything the flight needs and
   * nothing that can go stale.
   *
   * **The damage for this shot is in the same frame, already settled.** The
   * arrow is a receipt arriving late and can never contradict it — see
   * `../game/projectile` for why that is the only arrangement two clients can
   * agree about.
   */
  | {
      kind: "projectileFired";
      id: string;
      /**
       * Which projectile — the id of a `projectile` tile.
       *
       * **A tile id, and it used to come with a duration.** That had to be sent
       * because the speed lived on a weapon the shooter could drop in the same
       * frame; the speed is on the tile now, and the catalogue is resolved once
       * per load and cannot be dropped, so the receiver derives the flight time
       * itself from the two points below and the tile this names. See
       * `../lib/projectile`.
       *
       * An id the catalogue has lost draws nothing, and so does one naming a
       * tile that is not a projectile.
       */
      tileId: string;
      /** Cell on the plan and absolute height, at each end. */
      from: { x: number; y: number; elevAbs: number };
      to: { x: number; y: number; elevAbs: number };
      /**
       * The body it was aimed at, if it was aimed at one.
       *
       * **So the receiver can draw it following.** The blow this depicts waits
       * out the flight, so a slow shot gives its target a second of walking,
       * and an arrow held to the point it was aimed at bursts where they were
       * rather than where they are. The dice were read when the string was let
       * go, so nothing about the fight turns on this — see
       * `../game/projectile`'s `ProjectileFlight.targetId`.
       *
       * An id rather than a live point, on the terms `tileId` is an id: the
       * receiver already holds the board and can ask it where that body is on
       * whatever frame it is drawing, which is finer than anything a tick could
       * have sent.
       */
      targetId?: string;
      /**
       * Whether the blow this is a receipt for connected.
       *
       * **The one thing this event says about the fight**, and it buys exactly
       * one thing: which side plays where the shot lands — `hit` or
       * `disappear`. The flight is drawn identically either way, because the
       * arrow was loosed either way.
       *
       * A flag rather than the effect itself, which is the whole difference a
       * catalogue makes: what to play is on the tile both ends already hold,
       * and only *which* of it can come from the fight.
       */
      hit: boolean;
    }
  /**
   * A tile formed or dissolved for a reason worth playing.
   *
   * **Its own event because a cell patch cannot say why.** The patch in this
   * same frame already says the flame is gone; what it cannot say is whether it
   * burned out or was picked up, and only one of those is a thing to draw. Sent
   * only for a tile with that side authored — see `../lib/tileTransition`.
   */
  | ({ kind: "tileTransition" } & TileTransitionNote)
  | {
      kind: "damage";
      id: string;
      targetId: string;
      /**
       * Which of the three this was. A miss and a dodge both carry
       * `amount: 0`, and the word is the only thing telling them apart.
       */
      outcome: SwingOutcome;
      amount: number;
      x: number;
      y: number;
      z: number;
      stackIndex: number;
    };

export type ServerMessage =
  /**
   * The headcount moved: somebody connected or left. Sent to administrators
   * only, on the terms of `hello`'s `playerCount`.
   */
  | {
      type: "players";
      playerCount: number;
    }
  /**
   * The world's clock was moved, by `/time`, to this hour.
   *
   * Broadcast to everybody, because a client anchors its clock once from
   * {@link hello} and runs it forward on its own: without this, only a joiner
   * would ever see the new hour.
   */
  | {
      type: "clock";
      minutesOfDay: number;
    }
  /**
   * Whether this client's own body is hidden from other players.
   *
   * Sent to its owner and to nobody else — to everybody else a hidden body is
   * not there, and a message saying so would be the one thing that says it is.
   * Sent after a `hello` when it is on, and whenever it moves. Absent means off,
   * which is what a client assumes at the start of every connection.
   * @see ClientMessage `hidden`
   */
  | {
      type: "hidden";
      on: boolean;
    }
  /** Full state, on join and after the world restarts. */
  | {
      type: "hello";
      selfId: string;
      /** The flat on-disk shape; the client chunkifies it. */
      map: unknown;
      actorIds: string[];
      /**
       * How many people are in the world, this joiner included. Sent to
       * administrators only, and absent for everybody else: a player is not
       * told how many others are online. Kept current by {@link players}.
       *
       * Not derivable from `actorIds`: creatures are actors too, and from here
       * they are indistinguishable from players. The server counts sockets,
       * which is the one place the two are told apart.
       */
      playerCount?: number;
      /**
       * The world's time of day, as the server reads it right now. Clients
       * carry it forward at the shared rate rather than keeping a clock of
       * their own, so everyone is standing in the same hour.
       */
      minutesOfDay: number;
      /**
       * Everybody's hit points as of this moment.
       *
       * Sent in full here and only as a diff afterwards, exactly like the map:
       * a joiner has nothing to patch against, and health bars have to be right
       * on the first frame rather than on the first blow.
       */
      hps: HpPatch[];
      /**
       * What to call everybody in reach who is a person.
       *
       * In full here on {@link hps}' terms — a joiner has nothing to patch
       * against, and a name tag has to be right on the first frame rather than
       * the first time somebody speaks. Unlike the hit points, what follows is
       * not a diff: a name never changes, so the patches after this only ever
       * *add*. @see NamePatch
       */
      names: NamePatch[];
      /**
       * Everybody's carried lights as of this moment, on the same terms
       * {@link hps} is sent in full here: a joiner has nothing to patch against,
       * and a room lit by somebody else's lantern has to be lit on the first
       * frame rather than on the next time they pick something up.
       */
      carriedLights: CarriedLightsPatch[];
      /**
       * Everybody's statuses as of this moment, on the terms
       * {@link carriedLights} is sent in full here: a joiner has nothing to
       * patch against, and a rat that is already on fire has to be on fire on
       * the first frame rather than the next time somebody sets it alight.
       */
      statusIds: StatusIdsPatch[];
      /**
       * Who is fighting other players, on the terms {@link statusIds} is sent
       * in full here: a joiner has nothing to patch against, and somebody who
       * can be fought has to be marked on the first frame rather than the next
       * time anybody touches the switch. @see PvpPatch
       */
      pvp: PvpPatch[];
      /**
       * Everybody's pulls in progress, on the terms {@link statusIds} is sent in
       * full here: a deer already at a bush has to show its bar on the first
       * frame, and the next patch about it is the one saying it has finished.
       */
      extractions: ExtractionPatch[];
      /**
       * Everybody's casts in progress, on the terms {@link extractions} is sent
       * in full here: somebody who was half way through a flame when this client
       * arrived has to have a bar on the first frame.
       */
      castings: CastingPatch[];
      /**
       * Every placement alight in the ground this viewer is sent, on
       * {@link statusIds}' terms: a joiner has nothing to patch against, and a
       * wood that is already burning has to be burning on the first frame.
       * Replaces what the client held. @see AfflictedPatch
       */
      afflicted: AfflictedPatch[];
      /** What this viewer is carrying. Theirs alone — see {@link Equipment}. */
      equipment: Equipment;
      /**
       * Which rewards this viewer has already taken.
       *
       * Sent in full on arrival like {@link hps}, and for a sharper reason: a
       * client with no tags yet offers every chest in the world, so a joiner
       * missing this would be shown a room full of things it turns out they
       * cannot have.
       */
      tags: string[];
      /**
       * Where this viewer comes back after a death.
       *
       * Sent in full on arrival on {@link tags}' terms and for the same
       * failure: a client that started blank would offer "Set respawn point" on
       * the very marker the player is already anchored to. Sent here rather
       * than left to the first `spawnPoint` message, because that one only
       * fires when the mark *moves* and a mark that has not moved since they
       * joined is exactly the common case.
       *
       * Never null in practice — the server mints a row the first time it sees
       * anybody — but typed nullable because the client has to behave when a
       * world with no storage behind it says nothing.
       */
      spawnAt: Coord | null;
      /**
       * The pull this viewer is part-way through, if any.
       *
       * Sent on arrival on {@link tags}' terms and for the same failure: a
       * reconnecting player's pull is still running on the server — the body at
       * the far end is the one they left — so a client that started blank would
       * offer a row for a vein it is about to be refused. Sent here rather than
       * left to the first `extracting` message, because that one only fires
       * when something changes and a pull already running changes nothing.
       */
      extracting: Extraction | null;
      /**
       * The wait before this viewer's next blow, if they are in one.
       *
       * Sent on arrival on {@link extracting}'s terms and for the same failure:
       * a reconnecting fighter is still standing beside whatever they were
       * fighting, and a client that started blank would draw a breathing
       * outline round a body it is about to hit. @see `../game/progress`
       */
      nextBlow: Progress | null;
      /**
       * What this viewer has learnt, as raw experience.
       *
       * Theirs alone, beside the kit and sent in full on arrival for the same
       * reason: there is nothing to patch against, and the panel showing it is
       * on screen before the first blow.
       */
      masteryXp: MasteryXp;
      /**
       * What is running on this viewer's own body.
       *
       * Sent in full on arrival like the kit and the tags, and for the same
       * reason: there is nothing to patch against, and the lane that draws it is
       * on screen before the first berry.
       */
      statuses: StatusPatch[];
    }
  /**
   * "Here is what you are carrying now."
   *
   * The second message addressed to a single client rather than to the world,
   * and the reason is the same one that keeps patches cheap. A patch is diffed
   * once and serialized once for everybody, which only works because everybody
   * is being told the same thing. Equipment is *not* the same thing — it is
   * different per socket, and folding it into the patch would turn one
   * serialization per tick into one per player.
   *
   * So it rides alone, sent only to the owner and only when theirs changed.
   * Nothing is lost by that: nobody else's inventory is drawn, because there is
   * no paperdoll and a sword changes no sprite.
   *
   * Whole state replacing whatever the client had, on the same terms
   * {@link HpPatch} is: an inventory rebuilt from a stream of add-and-remove
   * events would drift the moment one was missed, and go on being wrong with
   * nothing to correct it.
   */
  | {
      type: "equipment";
      equipment: Equipment;
      /**
       * How long each of this body's *own* spells has left, by name — the same
       * fact the cooldowns inside `equipment` carry, for the spells that are
       * not carried. @see `../lib/battler`'s `BattlerDef.spells`
       *
       * On this message rather than one of its own because it is the same kind
       * of thing said about the same body to the same socket, and the two
       * change at the same moment. Whole state, on the terms the kit beside it
       * is: a record rebuilt from "this one started cooling" events drifts the
       * moment one is missed, and a caster left holding a dimmed button has no
       * way to clear it.
       */
      spellCooldowns: Record<string, number>;
    }
  /**
   * "Here is everything you have taken."
   *
   * Addressed to one socket for the same reason equipment is — it differs per
   * player, and folding it into the patch would turn one serialization per tick
   * into one per player — and whole rather than incremental for the same reason
   * too: a list rebuilt from "you also got this" events drifts the moment one is
   * missed, and a dropped tag is a chest that can be opened twice.
   */
  | { type: "tags"; tags: string[] }
  /**
   * "Here is where you come back now."
   *
   * Addressed to one socket on exactly the terms `tags` is, and whole on them
   * too — it is one cell, so there is no incremental form to get wrong. Sent
   * only when the mark moves, which is rare enough that the alternative
   * (riding along with every patch) would be a coordinate per player per tick
   * for a number that changes once an hour.
   *
   * The client draws nothing from it but a grey row. What *acts* on it is the
   * server's own `spawn:` record, and this message is sent after that record
   * has moved rather than before.
   */
  | { type: "spawnPoint"; at: Coord }
  /**
   * "Here is where you are in a conversation, and everything said so far."
   *
   * Addressed to one socket for the reason `tags` is: it differs per player,
   * and it is the player's state rather than the NPC's — see
   * `../game/dialogRuntime`'s `Conversation`. Whole state every time, and null
   * when the panel should close, whether the player pressed Close or walked
   * out of reach. The buttons are not on it: the client holds the tile
   * catalogue and draws them from the path.
   */
  | { type: "conversation"; conversation: Conversation | null }
  /**
   * "Here is the pull you are part-way through, or nothing."
   *
   * The per-player half of an extract — see `../lib/interactions`'
   * {@link ExtractInteraction.durationMs}. Addressed to one socket on
   * {@link tags}' terms and whole on them too: what a client holds is replaced
   * outright, so a message that went missing costs a row for a moment rather
   * than stranding a bar on screen for ever.
   *
   * **Two messages a pull, and none in between.** One when a pull starts and
   * one when it lands or is taken away; nothing is sent while it merely runs.
   * That is what the `durationMs` beside the remainder buys — the client has
   * both halves of the fraction from the first message, so it can draw the bar
   * filling on its own rather than being told where it is thirty times a
   * second. Exactly the trade {@link StatusPatch} makes.
   */
  | { type: "extracting"; extracting: Extraction | null }
  /**
   * "Here is how long until you can hit the thing you are fighting."
   *
   * Addressed to one socket on `extracting`'s terms — it is the viewer's own
   * fight and nobody else's frame can show it — and whole on them too. What it
   * feeds is the fight outline, which fills as the wait runs down instead of
   * breathing on a clock of its own: see `../render/overlayMeshes`'
   * {@link readyAlphaAt}.
   *
   * **Two messages a wait, and none in between**, exactly as a pull is: one
   * when the wait changes — a windup armed, a blow thrown — and one when the
   * body stops being engaged. The `durationMs` beside the remainder is what
   * buys that, the same trade {@link StatusPatch} makes.
   */
  | { type: "nextBlow"; nextBlow: Progress | null }
  /**
   * "Here is something to tell you."
   *
   * One sentence for one player, drawn at the foot of their view and then gone
   * — see `../render/notifications`. Addressed rather than broadcast for the
   * reason a kit and a tag are, and more sharply: the whole content of a notice
   * is the word "you".
   *
   * **Fire-and-forget, and the only message here that is.** Everything else
   * addressed to one socket carries whole state precisely so a dropped message
   * self-corrects on the next one; this carries an event, and a lost line is a
   * line the player never reads. That is the right trade — the alternative is
   * acknowledgements and a replay buffer for a sentence that is stale four
   * seconds after it is composed — but it is why nothing may ever depend on a
   * notice having arrived. The reward it describes is confirmed by the `tags`
   * and `equipment` messages beside it, which are whole.
   *
   * Composed on the server rather than derived by the client, because it says
   * what *happened*: the mastery line the client works out for itself is a
   * reading of totals it already holds, and this is an event only the board saw.
   */
  | { type: "notice"; text: string }
  /**
   * "Here is what is running on you now."
   *
   * **Addressed to one socket, and deliberately not folded into the tick
   * patch.** A patch is diffed once and serialized once for everybody, which
   * only works because everybody is being told the same thing — and nothing
   * draws anybody else's statuses, so nobody else needs telling. Putting this in
   * the patch would turn one serialization per tick into one per player, to say
   * something no other client can see.
   *
   * Whole state replacing whatever the client had, on the terms `HpPatch` and
   * `equipment` are: a list rebuilt from a stream of gained-and-lost events
   * drifts the moment one is missed and goes on being wrong with nothing to
   * correct it.
   *
   * **Sent when the reading changes, not every tick.** What a client can draw is
   * a set of statuses and a whole-second countdown each, so that is the grain
   * the server compares at — about one message a second per status rather than
   * thirty, and the number on screen is the exact one rather than a local
   * timer's guess.
   */
  | { type: "statuses"; statuses: StatusPatch[] }
  /**
   * "Here is what you have learnt now."
   *
   * Addressed to one socket on exactly the terms the kit and the tags are, and
   * sent whenever the experience moves rather than only when a level does. A bar
   * that could move only on a level-up would sit still through a dozen fights
   * and then jump, which reads as nothing happening.
   *
   * That makes it the most frequent of the three — about one per landed blow for
   * whoever is fighting — and it is still cheap: one small message to one socket
   * on a tick that is already broadcasting a damage number to everybody.
   */
  | { type: "masteries"; masteryXp: MasteryXp }
  | {
      type: "patch";
      cells: CellPatch[];
      events: MotionEvent[];
      /** Only the actors whose hit points changed since the last patch. */
      hps: HpPatch[];
      /**
       * Only the people this client had not been told the name of yet.
       *
       * Empty on almost every tick, because it is not a diff of a changing
       * fact: a name is fixed for the life of a character, so this carries one
       * only when somebody walks into a client's subscription for the first
       * time. @see NamePatch
       */
      names: NamePatch[];
      /** Only the actors whose carried lights changed since the last patch. */
      carriedLights: CarriedLightsPatch[];
      /** Only the actors whose statuses changed since the last patch. */
      statusIds: StatusIdsPatch[];
      /** Only the actors whose switch moved since the last patch. @see PvpPatch */
      pvp: PvpPatch[];
      /** Only the actors whose pull started or ended since the last patch. */
      extractions: ExtractionPatch[];
      /** Only the actors whose cast started or ended since the last patch. */
      castings: CastingPatch[];
    }
  /**
   * Something somebody said, pinned to the cell they said it in.
   *
   * The coordinate travels rather than the speaker, because the bubble stays
   * where it was said: its author can walk out from under it, or disconnect,
   * and the words are still there for their five seconds.
   *
   * `stackIndex` is where the speaker was standing in that cell's stack, and it
   * travels so the client can hang the bubble over the ground *under* them
   * rather than over their own head. Without it the bubble sits a body's height
   * too high until they walk away, and then drops.
   *
   * `tileId` is the body the speaker was in, and it travels for the same reason
   * the coordinate does: it is what the speaker *was* when they spoke, and the
   * bubble outlives them. It is how the client knows whether to write a
   * person's name over the words or the creature's — asking the live board
   * would be asking about a deer that may have wandered off or been erased.
   *
   * Sent only to sockets on `z`. A client never sees a message from another
   * level, so there is nothing to filter on arrival.
   */
  | {
      type: "chat";
      actorId: string;
      tileId: string;
      /**
       * What the speaker is called, or null for a creature — which is named
       * after {@link tileId} instead.
       *
       * Travels for the reason the tile does: the bubble outlives its author,
       * so naming the speaker off the live board when it is drawn would be
       * asking about somebody who has since walked away or been killed.
       */
      name: string | null;
      text: string;
      x: number;
      y: number;
      z: number;
      stackIndex: number;
    }
  /**
   * A noise something made, pinned to the cell it was made in.
   *
   * **Carries no speaker and no body**, which is the entire difference between
   * this and `chat` and the reason it is a message of its own rather than a flag
   * on that one. A noise is not attributable: "crunch" is what the room heard,
   * not what somebody said, so there is nobody to name and the client is given
   * nothing it could use to name one.
   *
   * A message rather than an event inside the patch, unlike a damage number,
   * because a noise can happen *between* ticks — eating something is input, and
   * the patch is the tick's. It is level-scoped like chat for the same reason
   * chat is: a sound two floors up is not one you heard.
   */
  | {
      type: "noise";
      id: string;
      text: string;
      x: number;
      y: number;
      z: number;
      stackIndex: number;
    }
  /**
   * "That step of yours never happened."
   *
   * The one message here addressed to a single client rather than to the world,
   * because it is the only thing on this wire that is about somebody's guess
   * rather than about the board. A refusal means the client walked somewhere the
   * authoritative board would not allow — into a doorway that shut, or a cell
   * somebody else reached first — and it has to put itself back.
   *
   * Only refusals travel. An accepted step needs no word of its own: the cell
   * patch that commits it is the confirmation, and it was being sent anyway.
   */
  | { type: "stepRejected"; seq: number }
  /**
   * "You are dead."
   *
   * The last thing a socket hears until it asks to come back: from the tick
   * that sends this until a `rebirth`, the server stops broadcasting to it
   * entirely. That silence is the point — a dead player watching the world
   * carry on without them is being shown a board they have no body in, and
   * every patch of it is bandwidth spent on somebody who cannot act.
   *
   * Sent *after* the patch of the tick that killed them, never instead of it,
   * so the last frame they are left looking at is the true one: their body
   * gone from the cell, and everything they were carrying lying in it.
   *
   * Carries the kit rather than leaving the client to guess it, because the
   * usual channel cannot say this. `equipment` messages are read off a live
   * runtime, and a death is exactly the moment that runtime stops existing —
   * so an emptied bag would never be announced, and the panel would sit there
   * showing a sword that is on the floor. Normally empty; the whole kit when
   * the cell refused the pile, which is the one case where the dead still own
   * what they were holding.
   */
  | { type: "died"; equipment: Equipment }
  /**
   * The world is going away for a moment, and will be back.
   *
   * Sent before the sockets are closed on a deploy, so the page can say the
   * world is updating rather than showing the face it shows for a crash.
   */
  /** Nothing to say, said on purpose. See the schema below. */
  | { type: "keepalive" }
  | { type: "serverRestarting" }
  /**
   * This tab speaks a protocol the server no longer does.
   *
   * Followed immediately by a close carrying {@link CLOSE_OUTDATED_CLIENT},
   * which is what the page acts on — a rejected upgrade would reach it as an
   * indistinguishable failure, so the socket is accepted in order to say this.
   */
  | { type: "outdated"; serverVersion: number };

export type ClientMessage =
  /**
   * "I have started walking one cell this way."
   *
   * Past tense, and that is the whole of client-side prediction: the browser
   * decides when its own steps happen and draws them immediately, then tells the
   * server, which re-runs the same rule and either agrees or refuses. Held
   * directions never travel — a client that streamed them would be asking the
   * server to decide, which is the round trip being removed.
   *
   * `seq` is only ever read back in a {@link ServerMessage} refusal, so the
   * client knows which of the steps it is still holding has to be undone.
   */
  | {
      type: "step";
      seq: number;
      direction: "n" | "e" | "s" | "w";
      preferDescend: boolean;
    }
  /** Turning on the spot: shift-facing, or pressing into a wall. */
  | { type: "face"; direction: "n" | "e" | "s" | "w" }
  | { type: "interact"; ref: { x: number; y: number; z: number; stackIndex: number } }
  /**
   * "I am taking that."
   *
   * Its own message rather than an `interact` on the same slot, because the row
   * that sends it says "Pick up" by name: a tile authored as both an item and a
   * switch would run the switch under `interact`'s precedence, and the player
   * would have pressed a button that did something else.
   *
   * Every reason it might be refused — reach, a full bag, a bag already on your
   * back — is re-asked on this side. The client asks the same questions to
   * decide whether to offer the row at all, which is what stops it offering one
   * the server will not honour, but it is not trusted with the answer.
   */
  | { type: "pickUp"; ref: { x: number; y: number; z: number; stackIndex: number } }
  /**
   * "I am putting that on."
   *
   * `pickUp`'s sibling and not a flag on it, because the two say different
   * things: one stows a thing, the other arms you with it, and the list draws
   * them as separate rows with separate verbs. A tap that meant either
   * depending on what the server felt like would make "Wield" a suggestion.
   *
   * **No slot travels with it.** Where a thing goes is a fact about the tile —
   * `equipSlotsFor` — so naming it here would be the client telling the server
   * something the server already knows, and one more field to disbelieve. Which
   * slot must be *free* is a fact about the kit, which is the server's.
   */
  | { type: "equip"; ref: { x: number; y: number; z: number; stackIndex: number } }
  /**
   * "Put that there."
   *
   * One message for equipping, unequipping, looting and stashing, because under
   * the model they are one operation: an instance leaves a slot and arrives in
   * another, and the board's population is the same afterwards. Splitting them
   * into four would be four schemas and four validations of the same three
   * rules — capacity, nesting, and reach for an end that is on the floor.
   *
   * **This never crosses the line pickUp and drop cross.** Nothing is created
   * and nothing is destroyed here, which is why it carries no coordinate of its
   * own: a ground endpoint names a container that is already on the board, and
   * the item stays in the world either way.
   *
   * Refusals are silent. The client asks the same question — see
   * `../game/itemMoves` — before it offers the drag at all, so a move arriving
   * here that cannot be honoured is a race with the board or a client making
   * things up, and neither has a reply worth sending.
   */
  | { type: "moveItem"; from: SlotRef; to: SlotRef }
  /**
   * "I am putting that down there."
   *
   * The other message that crosses the line, and the inverse of `pickUp`: an
   * instance becomes a placement, contents and all. It carries the world-shaped
   * validation that goes with crossing — a throw's range, line of sight so the
   * range cannot reach through a wall, and whether the target stack has room —
   * none of which `moveItem` has any use for.
   *
   * A cell rather than a stack slot, because you are not choosing a *height*:
   * the thing lands on top of whatever is there and gravity takes it from
   * there, exactly as a shoved crate does.
   */
  | { type: "drop"; from: SlotRef; to: { x: number; y: number; z: number } }
  /**
   * "I am eating that" — out of a slot in my kit, or straight off the floor.
   *
   * The third message that changes the board's population, and the only one
   * where a thing stops existing entirely. Both arms are re-validated on the
   * server's terms: the floor arm runs a pickup's gates (reach, cover,
   * idleness), the slot arm a move's, and either way the thing must actually
   * be a consumable — the client offered the row from these same rules and is
   * not trusted with the answer.
   */
  | { type: "consume"; from: ConsumeSource }
  /**
   * Talk to a body, press a choice, take or refuse a trade, or close the
   * panel.
   *
   * One message with a verb inside rather than four, because the four are one
   * thing — where the player is in a conversation — and a conversation is the
   * one piece of per-player state whose whole shape the server answers with
   * (`conversation` below). `index` is a position among the buttons on offer,
   * on `craft`'s argument for a recipe index: both ends hold the tile
   * catalogue, so a position is something the server can check against a list
   * it already has. `amount` is the stepper, clamped server-side.
   */
  | { type: "talk"; action: TalkAction }
  /**
   * "Make this, at that."
   *
   * The fourth message that changes what exists: carried things stop being and
   * whatever the dice give begins. It is the only one that has to name *which*
   * of several things a placement offers, because a forge lists every recipe
   * the player can afford in one window — so a `ref` alone cannot say which
   * one was pressed.
   *
   * `recipe` is a position in the tile's authored list, on exactly the terms
   * {@link SlotRef} is an index rather than an instance id: both ends hold the
   * same tile catalogue, so a position is something the server can check
   * against a list it already has, where a name would be one more string to
   * disbelieve.
   *
   * Nothing about the *inputs* travels, and nothing about the outcome. Which
   * squares pay is a fact about the kit and the roll is the server's dice —
   * see `../game/craft`. The client asks the same question to decide whether
   * to list the recipe at all, and is still not trusted with the answer.
   */
  | {
      type: "craft";
      ref: { x: number; y: number; z: number; stackIndex: number };
      recipe: number;
    }
  | { type: "say"; text: string }
  /**
   * "Do this", as opposed to "say this".
   *
   * A separate message rather than a slash the server notices inside `say`,
   * because the two want different things done to them: a command is never
   * broadcast, never sanitised for a bubble it will not appear in, and never
   * heard by a creature standing next to you. Routed by `../game/commands`'s
   * one rule about a leading slash, on the client, so the server never holds a
   * private line it has to remember not to repeat.
   *
   * The text arrives raw and is parsed on the far side. What is *in* a command
   * is not the wire's business — the schema's only job here is that this is a
   * string of bounded length, which is the same job it does for a chat line.
   */
  | { type: "command"; text: string }
  /**
   * "This is who I am pointing at" — or null, for nobody.
   *
   * The client picks the target because picking one is pointing at something on
   * a screen; it does not get to say when a blow lands, which is why there is no
   * `attack` message here at all. The server swings on its own clock at whoever
   * this names, so a client cannot attack faster by asking more often.
   */
  | { type: "target"; actorId: string | null }
  /**
   * "I am fighting whoever I am pointing at" — or not.
   *
   * The other half of {@link ClientMessage} `target`, and still not a request to
   * swing: it says which of the two things pointing at somebody means, and the
   * server keeps its own clock either way. A client that flipped this a thousand
   * times a second would land exactly as many blows as one that flipped it once.
   */
  | { type: "attackMode"; enabled: boolean }
  /**
   * "I am in the fighting" — or not. @see `../game/pvp`
   *
   * A standing decision rather than a mode, which is what separates it from
   * {@link ClientMessage} `attackMode` above: that one says what this body is
   * doing right now, and this says who is allowed to do it to whom. Refused by
   * the server while the body is in a fight, so a client cannot turn its own
   * invulnerability on halfway through one.
   */
  | { type: "pvp"; enabled: boolean }
  /**
   * "Hide me from other players", or "show me again". Administrators only.
   *
   * While hidden, every other client is told the body has left, and nothing
   * about it afterwards: not its cell, its motion, its health, its statuses,
   * what it says or what it sounds like. Creatures stop noticing it too. The
   * server ignores this from anybody who is not an administrator, and answers
   * the owner with a {@link ServerMessage} `hidden` either way.
   */
  | { type: "hidden"; enabled: boolean }
  /**
   * "Cast the stone in this square."
   *
   * **A square, never an instance id**, on exactly the grounds every
   * {@link SlotRef} in this protocol names one: an id is a thing the server has
   * to go looking for, where a square is something it can read straight off a
   * kit it already holds. There are three of them — both hands and the charm —
   * and the client cannot name a fourth.
   *
   * Server-authoritative with no prediction, exactly as attacking is. The client
   * asks `../game/casting` the same question before it draws the button lit, so
   * a cast arriving that cannot be honoured is a race with the board or a client
   * making things up — and like a refused move it gets no reply, because the
   * equipment message the server sends whenever a kit changes is the only
   * confirmation there is anything to say.
   *
   * Nothing about the *target* travels either: whom this player is pointing at
   * is already on the server, put there by {@link ClientMessage} `target`, and a
   * second copy arriving here would be one more thing to disbelieve.
   */
  | { type: "cast"; slot: CastSlot }
  /**
   * "Stop the cast I am making."
   *
   * **Its own message rather than a second `cast` of the same slot**, because
   * a cast is queued behind the steps sent before it and a stop is not: stopping
   * depends on nothing about where the caster is standing, and a "stop" that
   * waited its turn behind a "start" would arrive to find nothing running. Two
   * `cast`s that meant "start, then stop" would be told apart only by what the
   * server happened to be doing when each came off the queue.
   *
   * Carries nothing. A body makes one cast at a time, and the server knows
   * which. Sent only while this client can see itself casting — see
   * `RemoteSession.cancelCast` — and harmless when it arrives late: a stop for
   * a cast that has already landed stops nothing.
   */
  | { type: "cancelCast" }
  /**
   * "Put me back in."
   *
   * The only thing a dead client may say. Every other message is dropped for
   * an actor with no body — the server's gate is "is there a runtime by this
   * name", and a death deletes it — so this one is answered ahead of that gate
   * rather than inside it.
   *
   * Carries nothing. Where somebody comes back in is the server's answer
   * (`spawn:<id>`, written the first time the world saw them), and a client
   * that could name its own cell could name any of them.
   *
   * The reply is a whole `hello`, not a patch: a dead socket has been receiving
   * nothing, so its map is as many ticks stale as the player sat on the death
   * screen, and there is no diff that could catch it up.
   */
  | { type: "rebirth" };

/**
 * Inbound from the browser. Held to a tighter standard than outbound: a client
 * can say anything, so directions are bounded and coordinates must be finite
 * numbers before they reach a map lookup.
 */
/**
 * A stack slot as a browser is allowed to name one: whole numbers, and an index
 * that is at least somewhere in a stack.
 *
 * Whether it names anything real is not this schema's business — every reader
 * looks the cell up and finds nothing, which is a refusal by the same path an
 * out-of-reach one takes.
 */
const inboundRefSchema = v.object({
  x: v.pipe(v.number(), v.integer()),
  y: v.pipe(v.number(), v.integer()),
  z: v.pipe(v.number(), v.integer()),
  stackIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/**
 * A slot, inbound.
 *
 * The index is bounded below and left unbounded above on purpose: what an index
 * may be is decided by the size of the container it is read against, which the
 * server knows and this schema does not. An index past the end reads as an empty
 * slot and is refused there, in the one place capacity is understood.
 */
const inboundSlotRefSchema = v.variant("kind", [
  v.object({ kind: v.literal("weapon") }),
  v.object({ kind: v.literal("offhand") }),
  v.object({ kind: v.literal("armor") }),
  v.object({ kind: v.literal("head") }),
  v.object({ kind: v.literal("charm") }),
  v.object({ kind: v.literal("footwear") }),
  v.object({ kind: v.literal("bag") }),
  v.object({
    kind: v.literal("contents"),
    index: v.pipe(v.number(), v.integer(), v.minValue(0)),
    // Which container on the body, absent meaning the pack on the back. See
    // `../game/itemMoves`' `SlotRef`: a hand can hold a pack, and a pack in a
    // hand is a pack you can move things in and out of.
    of: v.optional(v.picklist(["weapon", "offhand"])),
  }),
  v.object({
    kind: v.literal("ground"),
    ref: inboundRefSchema,
    index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
]);

const clientMessageSchema = v.variant("type", [
  v.object({
    type: v.literal("step"),
    // Only ever echoed back in a refusal, so the bound is about keeping the
    // number a number: anything the client counts up cannot become a NaN or an
    // object on the way to being compared.
    seq: v.pipe(v.number(), v.integer(), v.minValue(0)),
    direction: directionSchema,
    preferDescend: v.boolean(),
  }),
  v.object({
    type: v.literal("face"),
    direction: directionSchema,
  }),
  v.object({
    type: v.literal("interact"),
    ref: inboundRefSchema,
  }),
  v.object({
    type: v.literal("pickUp"),
    ref: inboundRefSchema,
  }),
  v.object({
    type: v.literal("equip"),
    ref: inboundRefSchema,
  }),
  v.object({
    type: v.literal("moveItem"),
    from: inboundSlotRefSchema,
    to: inboundSlotRefSchema,
  }),
  v.object({
    type: v.literal("drop"),
    from: inboundSlotRefSchema,
    to: v.object({
      x: v.pipe(v.number(), v.integer()),
      y: v.pipe(v.number(), v.integer()),
      z: v.pipe(v.number(), v.integer()),
    }),
  }),
  v.object({
    type: v.literal("consume"),
    from: v.variant("kind", [
      v.object({ kind: v.literal("slot"), slot: inboundSlotRefSchema }),
      v.object({ kind: v.literal("floor"), ref: inboundRefSchema }),
    ]),
  }),
  v.object({
    type: v.literal("talk"),
    action: v.variant("kind", [
      v.object({ kind: v.literal("open"), ref: inboundRefSchema }),
      v.object({
        kind: v.literal("choose"),
        index: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
      v.object({
        kind: v.literal("trade"),
        amount: v.pipe(v.number(), v.integer(), v.minValue(1)),
      }),
      v.object({ kind: v.literal("cancel") }),
      v.object({ kind: v.literal("close") }),
    ]),
  }),
  v.object({
    type: v.literal("craft"),
    ref: inboundRefSchema,
    // Bounded below and left unbounded above, exactly as a slot index is: how
    // many recipes a tile has is decided by the tile, which the server knows
    // and this schema does not. A position past the end reads as "no recipe
    // there" and is refused in the one place the list is understood.
    recipe: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.object({
    type: v.literal("say"),
    // The raw cap, not the drawn one: `sanitizeChatText` decides what the
    // message actually is, and this only stops a client handing it something
    // unbounded to walk.
    text: v.pipe(v.string(), v.maxLength(MAX_CHAT_RAW_LENGTH)),
  }),
  v.object({
    type: v.literal("command"),
    // Its own cap rather than chat's, because a command carries a uuid and chat
    // carries a sentence. Both exist for the same reason: the socket is the
    // boundary and a client must not hand the parser something unbounded.
    text: v.pipe(v.string(), v.maxLength(MAX_COMMAND_LENGTH)),
  }),
  v.object({
    type: v.literal("target"),
    // Bounded so a client cannot hand the server an unbounded string to carry
    // around in an actor slot. Whether it names anybody real is not this
    // schema's business — the session looks it up on every swing regardless.
    actorId: v.nullable(v.pipe(v.string(), v.maxLength(MAX_ACTOR_ID_LENGTH))),
  }),
  v.object({
    type: v.literal("attackMode"),
    enabled: v.boolean(),
  }),
  v.object({
    type: v.literal("pvp"),
    enabled: v.boolean(),
  }),
  v.object({
    type: v.literal("hidden"),
    enabled: v.boolean(),
  }),
  v.object({
    type: v.literal("cast"),
    // A square off the game's own list, or the name of a spell the body has —
    // so a square added to a body is a square this schema already accepts, a
    // client naming a bag is refused before anything looks a kit up, and a name
    // nothing answers to is refused by `castability` rather than here. What the
    // name may be is not this schema's to know: it is authored content, exactly
    // as a tile id in a kit is.
    slot: castSlotSchema,
  }),
  v.object({
    type: v.literal("cancelCast"),
  }),
  v.object({
    type: v.literal("rebirth"),
  }),
]);

/** Parse an inbound frame, or null when it is not something we accept. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = v.safeParse(clientMessageSchema, json);
  return parsed.success ? (parsed.output as ClientMessage) : null;
}

const serverMessageSchema = v.variant("type", [
  v.object({
    type: v.literal("hello"),
    selfId: v.string(),
    map: v.unknown(),
    actorIds: v.array(v.string()),
    playerCount: v.optional(v.number()),
    minutesOfDay: v.number(),
    hps: v.array(hpPatchSchema),
    // Optional with an empty default, on `statusIds`' terms below: a skew
    // degrades to a room of bodies labelled `Nobody` rather than to a
    // handshake that fails to parse. @see `../game/displayName`
    names: v.optional(v.array(namePatchSchema), () => []),
    carriedLights: v.array(carriedLightsPatchSchema),
    // Optional with an empty default, so a version skew degrades to "nobody
    // else's effects are drawn" rather than to a handshake that fails to parse.
    // The output type is still required, because the server always sends it.
    statusIds: v.optional(v.array(statusIdsPatchSchema), () => []),
    // And the same for the switch: a skew degrades to "nobody is marked", which
    // is how every client read the world before this existed.
    pvp: v.optional(v.array(pvpPatchSchema), () => []),
    // Optional with an empty default, on `statusIds`' terms: a skew degrades to
    // "nobody else's pull is drawn".
    extractions: v.optional(v.array(extractionPatchSchema), () => []),
    // And the same for casts, on the same terms: a skew degrades to "nobody
    // else's cast bar is drawn".
    castings: v.optional(v.array(castingPatchSchema), () => []),
    // Optional on `statusIds`' terms: a version skew degrades to "no fire is
    // drawn" rather than to a handshake that fails to parse.
    afflicted: v.optional(v.array(afflictedPatchSchema), () => []),
    equipment: tolerantEquipmentSchema,
    tags: v.array(v.string()),
    // Optional with a null default, on `statusIds`' terms: a skew degrades to
    // "the respawn point you are standing on offers a live row", which costs
    // one press that answers with a sentence instead of doing anything.
    spawnAt: v.optional(v.nullable(coordSchema), () => null),
    // Optional with a null default, on `statusIds`' terms: a version skew
    // should degrade to "you are not mining anything" — one refused tap —
    // rather than to a handshake that fails to parse.
    extracting: v.optional(v.nullable(extractionSchema), () => null),
    // Optional with a null default, on `extracting`'s terms: a version skew
    // should degrade to an outline that breathes rather than one that fills,
    // which is exactly the outline every client drew before this existed.
    nextBlow: v.optional(v.nullable(nextBlowSchema), () => null),
    masteryXp: tolerantMasteryXpSchema,
    statuses: v.array(statusPatchSchema),
  }),
  v.object({
    type: v.literal("equipment"),
    // Defaulted rather than required, on the terms every optional block on this
    // wire is: a body with no spells of its own sends nothing, which is almost
    // every body.
    spellCooldowns: v.optional(v.record(v.string(), v.number()), () => ({})),
    equipment: tolerantEquipmentSchema,
  }),
  v.object({
    type: v.literal("tags"),
    tags: v.array(v.string()),
  }),
  v.object({
    type: v.literal("spawnPoint"),
    at: coordSchema,
  }),
  v.object({
    type: v.literal("conversation"),
    conversation: v.nullable(
      v.object({
        npcId: v.string(),
        tileId: v.string(),
        pc: v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
        transcript: v.array(
          v.object({ who: v.picklist(["npc", "you", "note"]), text: v.string() }),
        ),
      }),
    ),
  }),
  v.object({
    type: v.literal("extracting"),
    extracting: v.nullable(extractionSchema),
  }),
  v.object({
    type: v.literal("nextBlow"),
    nextBlow: v.nullable(nextBlowSchema),
  }),
  v.object({
    type: v.literal("notice"),
    text: v.string(),
  }),
  v.object({
    type: v.literal("clock"),
    minutesOfDay: v.number(),
  }),
  v.object({
    type: v.literal("hidden"),
    on: v.boolean(),
  }),
  v.object({
    type: v.literal("players"),
    playerCount: v.number(),
  }),
  v.object({
    type: v.literal("statuses"),
    statuses: v.array(statusPatchSchema),
  }),
  v.object({
    type: v.literal("masteries"),
    masteryXp: tolerantMasteryXpSchema,
  }),
  v.object({
    type: v.literal("patch"),
    cells: v.array(
      v.object({
        x: v.number(),
        y: v.number(),
        z: v.number(),
        stack: v.array(v.looseObject({ tileId: v.string() })),
        // Optional because absent is the ordinary answer: nothing is burning.
        afflicted: v.optional(
          v.array(v.object({ tileId: v.string(), defIds: v.array(v.string()) })),
        ),
      }),
    ),
    events: v.array(
      v.variant("kind", [
        v.object({
          kind: v.literal("walkStarted"),
          actorId: v.string(),
          from: coordSchema,
          to: coordSchema,
          direction: directionSchema,
        }),
        v.object({
          kind: v.literal("fallStarted"),
          actorId: v.string(),
          feetAbs: v.number(),
          landingAbs: v.number(),
        }),
        v.object({
          kind: v.literal("slideStarted"),
          actorId: v.string(),
          object: objectRefSchema,
          from: coordSchema,
          count: v.number(),
        }),
        v.object({
          kind: v.literal("teleported"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("swung"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("strikeStarted"),
          actorId: v.string(),
          strike: v.picklist(STRIKE_KINDS),
          dx: v.number(),
          dy: v.number(),
          dElev: v.number(),
        }),
        v.object({
          kind: v.literal("projectileFired"),
          id: v.string(),
          tileId: v.string(),
          from: flightPointSchema,
          to: flightPointSchema,
          // Named here as well as in the type, because valibot strips what a
          // schema does not mention — a field dropped on the way in would leave
          // every shot aimed at the point it was loosed at and nothing saying
          // why.
          targetId: v.optional(v.string()),
          hit: v.boolean(),
        }),
        v.object({
          kind: v.literal("tileTransition"),
          id: v.string(),
          side: v.picklist(TRANSITION_SIDES),
          tileId: v.string(),
          // The arrow whose hit is playing on the body this note is about, for
          // the one kind of note whose effect is not the placement's own —
          // see `../lib/tileTransition`'s `TileTransitionNote.struckBy`. Named
          // here because valibot strips what a schema does not mention, and a
          // struck note arriving without it would look up a side the body does
          // not have and play nothing.
          struckBy: v.optional(v.string()),
          // Whole, because each of these is a map lookup on the far side.
          x: v.pipe(v.number(), v.integer()),
          y: v.pipe(v.number(), v.integer()),
          z: v.pipe(v.number(), v.integer()),
          stackIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
        }),
        v.object({
          kind: v.literal("joined"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("left"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("spawned"),
          actorId: v.string(),
          // Named here as well as in the type: valibot strips what a schema
          // does not mention, and a cell dropped on the way in would put the
          // receiver straight back on the board sweep this carries it to avoid.
          at: objectRefSchema,
        }),
        v.object({
          kind: v.literal("despawned"),
          actorId: v.string(),
        }),
        v.object({
          kind: v.literal("damage"),
          id: v.string(),
          targetId: v.string(),
          // **Not optional, and its absence here was a real bug.** Valibot
          // strips keys a schema does not name, so a field the type promised and
          // the schema forgot arrived as `undefined` — and the one thing that
          // reads it turns "hit" into a number and everything else into a word.
          // Every blow online drew nothing at all, for as long as `outcome` has
          // existed.
          outcome: v.picklist(SWING_OUTCOMES),
          amount: v.number(),
          x: v.number(),
          y: v.number(),
          z: v.number(),
          stackIndex: v.number(),
        }),
      ]),
    ),
    hps: v.array(hpPatchSchema),
    // Optional with an empty default, on `statusIds`' terms below.
    names: v.optional(v.array(namePatchSchema), () => []),
    carriedLights: v.array(carriedLightsPatchSchema),
    // Optional with an empty default, so a version skew degrades to "nobody
    // else's effects are drawn" rather than to a handshake that fails to parse.
    // The output type is still required, because the server always sends it.
    statusIds: v.optional(v.array(statusIdsPatchSchema), () => []),
    pvp: v.optional(v.array(pvpPatchSchema), () => []),
    extractions: v.optional(v.array(extractionPatchSchema), () => []),
    castings: v.optional(v.array(castingPatchSchema), () => []),
  }),
  v.object({
    type: v.literal("chat"),
    actorId: v.string(),
    tileId: v.string(),
    // Optional with a null default, on the `names` array's terms: a skew
    // degrades to `Nobody says: …` rather than to a bubble that fails to parse.
    name: v.optional(v.nullable(v.string()), () => null),
    text: v.string(),
    x: v.number(),
    y: v.number(),
    z: v.number(),
    stackIndex: v.number(),
  }),
  v.object({
    type: v.literal("noise"),
    id: v.string(),
    text: v.string(),
    x: v.number(),
    y: v.number(),
    z: v.number(),
    stackIndex: v.number(),
  }),
  v.object({
    type: v.literal("stepRejected"),
    seq: v.number(),
  }),
  v.object({
    type: v.literal("died"),
    equipment: tolerantEquipmentSchema,
  }),
  /**
   * Nothing to say, said on purpose.
   *
   * A world at rest sends nothing at all — `sleepIfIdle` stops the tick when
   * everybody is standing still — and a silent socket is one a proxy is
   * entitled to close. Reconnecting costs a whole `hello`, which carries the
   * map, so an idle player behind a proxy would re-download the world on a
   * loop. This is cheaper than that by four orders of magnitude.
   */
  v.object({
    type: v.literal("keepalive"),
  }),
  /**
   * Nothing to say, said on purpose.
   *
   * A world at rest sends nothing at all — `sleepIfIdle` stops the tick when
   * everybody is standing still — and a silent socket is one a proxy is
   * entitled to close. Reconnecting costs a whole `hello`, which carries the
   * map, so an idle player behind a proxy would re-download the world on a
   * loop. This is cheaper than that by four orders of magnitude.
   */
  v.object({
    type: v.literal("keepalive"),
  }),
  /**
   * The world is going away for a moment, and will be back.
   *
   * Sent before the sockets are closed on a deploy, so the client can say the
   * world is updating rather than showing the face it shows for a crash. It
   * carries nothing: what follows is a close and a reconnect, and the `hello`
   * on the other side is the whole state again.
   */
  v.object({
    type: v.literal("serverRestarting"),
  }),
  /**
   * This tab is running against a protocol the server no longer speaks.
   *
   * Sent on a socket that is then closed, rather than refused at the upgrade,
   * and the difference is the point: a browser hands a rejected upgrade to the
   * page as an indistinguishable failure, so a client told that way cannot tell
   * "you are stale" from "the server is down" and would sit in its reconnect
   * backoff forever.
   */
  v.object({
    type: v.literal("outdated"),
    serverVersion: v.number(),
  }),
]);

/**
 * Parse an inbound frame from the server.
 *
 * Validated too, though the server is ours: the socket is the boundary, and a
 * version skew between a long-lived tab and a freshly deployed Worker is the
 * realistic way this goes wrong.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = v.safeParse(serverMessageSchema, json);
  return parsed.success ? (parsed.output as ServerMessage) : null;
}

/**
 * Path the browser opens its socket on.
 *
 * Still says `/online`, which is no longer a page: the game moved to `/` and
 * this did not follow it. A wire path is not a URL anybody types, and changing
 * it would refuse every tab that was open across the deploy at the upgrade —
 * which is the one failure the version handshake cannot explain to them, since
 * a browser reports a rejected upgrade as an indistinguishable failure.
 */
export const GAME_SOCKET_PATH = "/online/ws";

/**
 * What this build of the wire looks like.
 *
 * **Bump it in the same commit as any change to the schemas above.** Client and
 * server import this one constant, so they always agree on what the current
 * value is; the question the handshake asks is whether the two halves that are
 * actually running were built from the same one.
 *
 * The client sends it as `?v=` when it opens the socket and the server compares
 * exactly. A mismatch is a forced reload for everybody connected, which is both
 * honest and rare — and far better than the alternative, which is a tab quietly
 * mis-parsing a message it half understands.
 *
 * This is deliberately not the build id. A client deploy that changes no
 * messages should not disconnect anybody, and most client deploys are that.
 */
export const PROTOCOL_VERSION = 22;

/**
 * How many steps a client may send that the world has not yet walked.
 *
 * One number for both halves, because they used to be two. The client walks up
 * to this many cells ahead of the server's answer, and the server refuses a step
 * once this many are waiting in its queue. When the server kept two and the
 * client drew eight, a server busy for half a second — a burst of players
 * joining — received the steps sent meanwhile in one batch, refused all but
 * two, and the client rolled its player back to where the refusals began.
 *
 * Eight covers a round trip well past a second. Past that something is wrong
 * rather than slow, and `STEP_CONFIRM_GRACE_MS` is what notices. It does not
 * change the pace: the world takes a queued step only when the body is free.
 */
export const MAX_STEPS_AHEAD = 8;

/**
 * How often the world says nothing, to keep a proxy from hanging up.
 *
 * Well inside the shortest idle timeout worth designing against — Cloudflare
 * and most reverse proxies sit around a minute or two — and small enough that
 * the cost is invisible: a dozen bytes per player per interval.
 */
export const KEEPALIVE_INTERVAL_MS = 30_000;

/** Query parameter carrying {@link PROTOCOL_VERSION} on the socket URL. */
export const PROTOCOL_VERSION_PARAM = "v";

/**
 * Query parameter naming which of the account's characters is being played.
 *
 * **Safe to take from the client because it is checked, not trusted.** The
 * session cookie says who the account is, and `server/index.ts` looks the named
 * character up against *that account* before the socket opens — so naming
 * somebody else's character is a 403 rather than a way into their body. What
 * the client is choosing here is which of its own three to be, which is a thing
 * only the client knows.
 *
 * On the query string rather than in a cookie because it is a property of this
 * tab and not of this browser: two tabs on one account playing two different
 * characters is a reasonable thing to do, and a cookie would make the second
 * one silently change the first.
 */
export const CHARACTER_PARAM = "character";

/**
 * Close code for a socket closed because the client is stale.
 *
 * In the 4000–4999 range, which RFC 6455 reserves for the application. 1012
 * (Service Restart) is the other code this server sends, and the two mean
 * opposite things to the client: reconnect promptly, versus do not reconnect
 * until you have reloaded.
 */
export const CLOSE_OUTDATED_CLIENT = 4001;

/**
 * Close code for a socket closed because the same actor connected again.
 *
 * One connection per actor, and the newest wins. The client must not reconnect
 * on this code: the connection that replaced it would be replaced in turn, and
 * two tabs doing that to each other retry for ever.
 */
export const CLOSE_REPLACED = 4002;

/**
 * Close code for a socket refused because nobody is signed in, or because the
 * character named on it is not this account's.
 *
 * Distinct from every other close for the same reason {@link CLOSE_REPLACED}
 * is: the client must not reconnect on it. A backoff loop against a session
 * that has expired is a tab hammering the server until somebody notices, when
 * what it should do is put the sign-in screen back up. @see
 * `../routes/game`
 */
export const CLOSE_SIGNED_OUT = 4003;

/**
 * Close code for a socket closed, or refused, because the world is in
 * maintenance.
 *
 * The client must not reconnect on it, on the terms {@link CLOSE_SIGNED_OUT}
 * gives: every attempt would be refused the same way until somebody switches
 * maintenance off. The page shows `app/components/MaintenanceScreen.tsx`
 * instead, which asks `GET /api/maintenance` on a slow timer and reloads when
 * the answer is that the world is open.
 */
export const CLOSE_MAINTENANCE = 4004;

/**
 * Close code for a socket refused because the world already holds
 * `MAX_ONLINE_PLAYERS` (`server/GameServer.ts`). Administrators are never
 * refused with it.
 *
 * Unlike {@link CLOSE_MAINTENANCE}, the next attempt may succeed — a seat
 * opens whenever somebody leaves. So the client does try again, but on a slow
 * timer rather than its reconnect backoff: every refused tab is knocking on a
 * server that is, by definition, at its limit. @see
 * `app/components/WorldFullScreen.tsx`
 */
export const CLOSE_WORLD_FULL = 4005;
