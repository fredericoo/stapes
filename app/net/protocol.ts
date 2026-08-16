import * as v from "valibot";
import type { Equipment } from "../game/equipment";
import type { SlotRef } from "../game/itemMoves";
import type { ConsumeSource } from "../game/itemUse";
import type { PlacedTile } from "../lib/types";
import { MAX_CHAT_RAW_LENGTH } from "./chat";

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
});

const carriedLightsPatchSchema = v.object({
  actorId: v.string(),
  tileIds: v.array(v.string()),
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
  contents: v.optional(
    v.array(
      v.object({
        id: v.string(),
        tileId: v.string(),
        direction: v.optional(directionSchema),
        channel: v.optional(v.string()),
        description: v.optional(v.string()),
      }),
    ),
  ),
});

const equipmentSchema = v.object({
  weapon: v.nullable(itemInstanceSchema),
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
  bag: null,
});

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
      object: { x: number; y: number; z: number; stackIndex: number };
      from: { x: number; y: number; z: number };
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
  | {
      kind: "damage";
      id: string;
      targetId: string;
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
  | {
      type: "patch";
      cells: CellPatch[];
      events: MotionEvent[];
      /** Only the actors whose hit points changed since the last patch. */
      hps: HpPatch[];
      /** Only the actors whose carried lights changed since the last patch. */
      carriedLights: CarriedLightsPatch[];
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
  | { type: "stepRejected"; seq: number };

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
  | { type: "say"; text: string }
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
  | { type: "attackMode"; enabled: boolean };

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
  v.object({ kind: v.literal("bag") }),
  v.object({
    kind: v.literal("contents"),
    index: v.pipe(v.number(), v.integer(), v.minValue(0)),
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
    type: v.literal("say"),
    // The raw cap, not the drawn one: `sanitizeChatText` decides what the
    // message actually is, and this only stops a client handing it something
    // unbounded to walk.
    text: v.pipe(v.string(), v.maxLength(MAX_CHAT_RAW_LENGTH)),
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
    equipment: tolerantEquipmentSchema,
    tags: v.array(v.string()),
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

/** Cookie carrying the actor id, minted by the /online loader. */
export const ACTOR_COOKIE = "stapes_uid";
