import * as v from "valibot";
import type { Equipment } from "../game/equipment";
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
      /** What this viewer is carrying. Theirs alone — see {@link Equipment}. */
      equipment: Equipment;
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
  | {
      type: "patch";
      cells: CellPatch[];
      events: MotionEvent[];
      /** Only the actors whose hit points changed since the last patch. */
      hps: HpPatch[];
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
    ref: v.object({
      x: v.pipe(v.number(), v.integer()),
      y: v.pipe(v.number(), v.integer()),
      z: v.pipe(v.number(), v.integer()),
      stackIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  }),
  v.object({
    type: v.literal("pickUp"),
    ref: v.object({
      x: v.pipe(v.number(), v.integer()),
      y: v.pipe(v.number(), v.integer()),
      z: v.pipe(v.number(), v.integer()),
      stackIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
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
    equipment: equipmentSchema,
  }),
  v.object({
    type: v.literal("equipment"),
    equipment: equipmentSchema,
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
