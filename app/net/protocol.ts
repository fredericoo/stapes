import * as v from "valibot";
import { CAST_SQUARES, type CastSquare } from "../game/casting";
import type { Equipment } from "../game/equipment";
import type { SlotRef } from "../game/itemMoves";
import { SWING_OUTCOMES, type SwingOutcome } from "../game/GameSession";
import { STRIKE_KINDS, type StrikeKind } from "../game/strike";
import type { ConsumeSource } from "../game/itemUse";
import type { Conversation, TalkAction } from "../game/dialogRuntime";
import { masteryXpBlockSchema, type MasteryXp } from "../lib/mastery";
import type { ExtractCooling } from "../game/extract";
import type { PlacedTile } from "../lib/types";
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
 * Ids are minted by the `/online` loader as cookie values, so a real one is far
 * under this; the bound exists because the only inbound message carrying one is
 * a target, and a target is *kept* — an unbounded string would be held in an
 * actor slot for as long as the client cared to keep pointing at it.
 */
const MAX_ACTOR_ID_LENGTH = 128;

const hpPatchSchema = v.object({
  actorId: v.string(),
  hp: v.number(),
  maxHp: v.number(),
  rating: v.number(),
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
 * One resource this viewer is waiting on, and how far through the wait they
 * are.
 *
 * The shape `../game/extract` already holds it in — see `ExtractCooling`, whose
 * note argues why both numbers travel. Validated rather than trusted like
 * everything else here, and the remainder is not clamped against the duration:
 * a client that draws a bar reads them as a fraction and clamps it there.
 */
const extractCoolingSchema = v.object({
  key: v.string(),
  remainingMs: v.number(),
  durationMs: v.number(),
});

const carriedLightsPatchSchema = v.object({
  actorId: v.string(),
  tileIds: v.array(v.string()),
});

const statusIdsPatchSchema = v.object({
  actorId: v.string(),
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
  description: v.optional(v.string()),
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
        description: v.optional(v.string()),
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
   * A body threw a blow, and is planted for one of its own steps because of it.
   *
   * **Its own event rather than a flag on `strikeStarted`, because half the
   * blows in the game do not lean.** An archer never throws itself at anything
   * — the arrow is what travels — and a bow that let its holder keep walking
   * while a fist did not would be the balance rule applying to whoever picked
   * the wrong weapon.
   *
   * Carries no duration, on exactly the terms a walk carries none: how long a
   * body is planted is how long that body takes to walk one cell, and both ends
   * read that off the tile it is. See `../game/movement`'s
   * `resolveWalkDurationMs`.
   *
   * What it is *for* is the one body a client decides the footwork of — its
   * own. Everybody else's walking arrives as `walkStarted` already gated, so
   * this tells them nothing they are not about to be shown.
   */
  | { kind: "swung"; actorId: string }
  | { kind: "joined"; actorId: string; playerCount: number }
  | { kind: "left"; actorId: string; playerCount: number }
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
      /** The tile drawn in flight — a `directional8` one. */
      tileId: string;
      /** Cell on the plan and absolute height, at each end. */
      from: { x: number; y: number; elevAbs: number };
      to: { x: number; y: number; elevAbs: number };
      /**
       * How long the whole flight takes.
       *
       * Sent rather than re-derived from the weapon's speed, because the
       * receiver may not be able to: the shooter can drop the bow, or die, in
       * the same frame this arrives. What is in the air owes nothing to what
       * fired it.
       */
      durationMs: number;
    }
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
  /** Full state, on join and after the world restarts. */
  | {
      type: "hello";
      selfId: string;
      /** The flat on-disk shape; the client chunkifies it. */
      map: unknown;
      actorIds: string[];
      /**
       * How many people are in the world, this joiner included.
       *
       * Not derivable from `actorIds`: creatures are actors too, and from here
       * they are indistinguishable from players. The server counts sockets,
       * which is the one place the two are told apart.
       */
      playerCount: number;
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
       * Which resources this viewer may not work just yet.
       *
       * Sent in full on arrival on {@link tags}' terms and for the same
       * failure: a reconnecting player's waits are still running on the server —
       * the body at the far end is the one they left — so a client that started
       * blank would offer rows for bushes it is about to be refused. Sent whole
       * here rather than left to the first `extractCooling` message, because
       * that one only fires when something changes and a wait already running
       * changes nothing.
       */
      extractCooling: ExtractCooling[];
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
  | { type: "equipment"; equipment: Equipment }
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
   * "Here is where you are in a conversation, and what was just said to you."
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
   * "Here is every resource you may not work just yet."
   *
   * The per-player half of an extract — see `../lib/interactions`'
   * {@link ExtractInteraction.cooldownMs}. Addressed to one socket on
   * {@link tags}' terms and whole on them too: the list is what decides which
   * rows the client offers, and one rebuilt from "this one is cooling now"
   * events would strand a row hidden for ever the first time a message went
   * missing.
   *
   * **Two messages a pull, and none in between.** One when a placement starts
   * cooling and one when it stops; nothing is sent while a wait merely runs
   * down. That is what the `durationMs` beside the remainder buys — the client
   * has both halves of the fraction from the first message, so it can draw the
   * bar filling on its own rather than being told where it is thirty times a
   * second. Exactly the trade {@link StatusPatch} makes.
   */
  | { type: "extractCooling"; cooling: ExtractCooling[] }
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
      /** Only the actors whose carried lights changed since the last patch. */
      carriedLights: CarriedLightsPatch[];
      /** Only the actors whose statuses changed since the last patch. */
      statusIds: StatusIdsPatch[];
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
   * `equipSlotOf` — so naming it here would be the client telling the server
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
   * Talk to a body, press one of its buttons, go back to its first ones, or
   * close the panel.
   *
   * One message with a verb inside rather than four, because the four are one
   * thing — where the player is in a conversation — and a conversation is the
   * one piece of per-player state whose whole shape the server answers with
   * (`conversation` below). `index` is a position among the buttons on offer,
   * on `transmute`'s argument for a recipe index: both ends hold the tile
   * catalogue, so a position is something the server can check against a list
   * it already has. `amount` is the stepper, clamped server-side.
   */
  | { type: "talk"; action: TalkAction }
  /**
   * "I am spending that at this."
   *
   * The fourth message that changes what exists: one carried thing stops being
   * and one or more others begin. It is the only one that has to name *which*
   * of several things a placement offers, because a fire may cook three
   * different foods and every one of them is a row on the same cell — so a
   * `ref` alone cannot say which row was pressed.
   *
   * `recipe` is a position in the tile's authored list, on exactly the terms
   * {@link SlotRef} is an index rather than an instance id: both ends hold the
   * same tile catalogue, so a position is something the server can check
   * against a list it already has, where a name would be one more string to
   * disbelieve.
   *
   * Nothing about the *input* travels. Which slot it comes out of is a fact
   * about the kit, which is the server's — see `../game/transmute`. The client
   * asks the same question to decide whether to offer the row at all, and is
   * still not trusted with the answer.
   */
  | {
      type: "transmute";
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
  | { type: "cast"; square: CastSquare }
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
        amount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
      v.object({ kind: v.literal("back") }),
      v.object({ kind: v.literal("close") }),
    ]),
  }),
  v.object({
    type: v.literal("transmute"),
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
    type: v.literal("cast"),
    // A picklist off the game's own list, so a square added to a body is a
    // square this schema already accepts and a client naming a bag is refused
    // before anything looks a kit up.
    square: v.picklist(CAST_SQUARES),
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
    playerCount: v.number(),
    minutesOfDay: v.number(),
    hps: v.array(hpPatchSchema),
    carriedLights: v.array(carriedLightsPatchSchema),
    // Optional with an empty default, so a version skew degrades to "nobody
    // else's effects are drawn" rather than to a handshake that fails to parse.
    // The output type is still required, because the server always sends it.
    statusIds: v.optional(v.array(statusIdsPatchSchema), () => []),
    equipment: tolerantEquipmentSchema,
    tags: v.array(v.string()),
    // Optional with an empty default, on `statusIds`' terms: a version skew
    // should degrade to "every resource looks ready" — one refused tap — rather
    // than to a handshake that fails to parse.
    extractCooling: v.optional(v.array(extractCoolingSchema), () => []),
    masteryXp: tolerantMasteryXpSchema,
    statuses: v.array(statusPatchSchema),
  }),
  v.object({
    type: v.literal("equipment"),
    equipment: tolerantEquipmentSchema,
  }),
  v.object({
    type: v.literal("tags"),
    tags: v.array(v.string()),
  }),
  v.object({
    type: v.literal("conversation"),
    conversation: v.nullable(
      v.object({
        npcId: v.string(),
        tileId: v.string(),
        path: v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
        line: v.string(),
      }),
    ),
  }),
  v.object({
    type: v.literal("extractCooling"),
    cooling: v.array(extractCoolingSchema),
  }),
  v.object({
    type: v.literal("notice"),
    text: v.string(),
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
          durationMs: v.number(),
        }),
        v.object({
          kind: v.literal("joined"),
          actorId: v.string(),
          playerCount: v.number(),
        }),
        v.object({
          kind: v.literal("left"),
          actorId: v.string(),
          playerCount: v.number(),
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
    carriedLights: v.array(carriedLightsPatchSchema),
    // Optional with an empty default, so a version skew degrades to "nobody
    // else's effects are drawn" rather than to a handshake that fails to parse.
    // The output type is still required, because the server always sends it.
    statusIds: v.optional(v.array(statusIdsPatchSchema), () => []),
  }),
  v.object({
    type: v.literal("chat"),
    actorId: v.string(),
    tileId: v.string(),
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

/** Path the browser opens its socket on. */
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
export const PROTOCOL_VERSION = 4;

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
 * Close code for a socket closed because the client is stale.
 *
 * In the 4000–4999 range, which RFC 6455 reserves for the application. 1012
 * (Service Restart) is the other code this server sends, and the two mean
 * opposite things to the client: reconnect promptly, versus do not reconnect
 * until you have reloaded.
 */
export const CLOSE_OUTDATED_CLIENT = 4001;

/** Cookie carrying the actor id, minted by the /online loader. */
export const ACTOR_COOKIE = "stapes_uid";
