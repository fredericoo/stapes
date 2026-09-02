import { describe, expect, it } from "vitest";
import {
  FALL_MS_PER_HEIGHT,
  PLAYER_TILE_ID,
  STRIKE_DURATION_MS,
  WALK_DURATION_MS,
} from "../game/constants";
import type { FlatMapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { emptyEquipment } from "../game/equipment";
import { CHAT_LIFETIME_MS } from "./chat";
import { RemoteSession, STEP_CONFIRM_TIMEOUT_MS } from "./RemoteSession";
import type { CellPatch, HpPatch, MotionEvent } from "./protocol";
import { UNKNOWN_REMAINING_MS } from "../game/statuses";

/**
 * The client's half of the shared world: what it draws between the event that
 * announces a step and the patch that commits it.
 *
 * That gap is one network latency wide and it is where the walk twitch lived —
 * the lerp ended on its own timer, so for a few frames the sprite was drawn
 * back at the cell the map still had it standing in.
 */

const frame = {
  sprite: {
    tilesetId: "basic",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    base: { x: 0, y: 0 },
  },
  durationMs: 200,
};

function tile(
  partial: Record<string, unknown> & Pick<TileDef, "id" | "height">,
): TileDef {
  return normalizeTileDef({
    name: partial.id,
    directional: false,
    variants: { default: [frame] },
    attributes: {},
    ...partial,
  });
}

const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "wall", height: 4 }),
  // A rung: pressed from the cell you are standing in, and carrying its climb
  // on the tile rather than on the placement.
  tile({
    id: "ladder",
    height: 0,
    interactions: {
      teleport: {
        actionName: "Climb",
        trigger: "interactOver",
        destination: { kind: "relative", delta: { x: 0, y: 0, z: 1 } },
      },
    },
  }),
  tile({
    id: "player",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
  // A body that is not a person, which is the whole of what these fixtures need
  // from it: people share cells and nothing else does, so a creature has to be
  // a creature for a blocking test to be testing anything.
  tile({
    id: "rat",
    height: 4,
    directional: true,
    affectedByGravity: true,
    walkable: false,
    actor: true,
    variants: { n: [frame], e: [frame], s: [frame], w: [frame] },
  }),
];

const SELF = "me";

const grass: PlacedTile = { tileId: "grass" } as PlacedTile;
const player: PlacedTile = {
  tileId: "player",
  direction: "s",
  owner: SELF,
} as PlacedTile;

/** A strip of grass along y=0 with the actor standing at x=0. */
function flatMap(): FlatMapFile {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 4; x++) cells[`${x},0`] = [grass];
  cells["0,0"] = [grass, player];
  return { version: 1, levels: { "0": cells } } as unknown as FlatMapFile;
}

/**
 * Stands in for the socket. Only inbound frames matter here, so listeners are
 * invoked directly rather than going through a real event dispatch.
 */
class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: string, cb: (event: MessageEvent) => void) {
    this.listeners.add(cb);
  }

  removeEventListener(_type: string, cb: (event: MessageEvent) => void) {
    this.listeners.delete(cb);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  deliver(message: unknown) {
    const event = { data: JSON.stringify(message) } as MessageEvent;
    for (const cb of [...this.listeners]) cb(event);
  }
}

const SERVER_MINUTES = 7 * 60 + 30;

function connected(): { socket: FakeSocket; session: RemoteSession } {
  const socket = new FakeSocket();
  const session = new RemoteSession(socket as unknown as WebSocket, tiles);
  socket.deliver({
    type: "hello",
    selfId: SELF,
    map: flatMap(),
    actorIds: [SELF],
    playerCount: 1,
    minutesOfDay: SERVER_MINUTES,
    hps: [],
    carriedLights: [],
    equipment: emptyEquipment(),
    tags: [],
    statuses: [],
  });
  return { socket, session };
}

function patch(
  cells: CellPatch[],
  events: MotionEvent[] = [],
  hps: HpPatch[] = [],
) {
  return { type: "patch", cells, events, hps, carriedLights: [] };
}

/** The step from (0,0,0) to (1,0,0), as the server announces it. */
const walkStarted: MotionEvent = {
  kind: "walkStarted",
  actorId: SELF,
  from: { x: 0, y: 0, z: 0 },
  to: { x: 1, y: 0, z: 0 },
  direction: "e",
};

/** The same step, as the server commits it 200ms later. */
const stepCommitted: CellPatch[] = [
  { x: 0, y: 0, z: 0, stack: [grass] },
  { x: 1, y: 0, z: 0, stack: [grass, player] },
];

describe("RemoteSession walk interpolation", () => {
  it("holds the sprite at the destination until the patch commits the step", () => {
    const { socket, session } = connected();
    socket.deliver(patch([], [walkStarted]));

    // Well past the walk's own duration: the timer running out is not the same
    // event as the step becoming true, and the patch has not arrived yet.
    session.update(WALK_DURATION_MS + 100);

    const mid = session.getSnapshot().self;
    expect(mid.walk).not.toBeNull();
    expect(mid.walkProgress).toBe(1);
    // Still standing in the origin cell as far as the map is concerned — which
    // is exactly why dropping the walk here is what made the sprite twitch.
    expect(mid.x).toBe(0);

    socket.deliver(patch(stepCommitted));

    const after = session.getSnapshot().self;
    expect(after.walk).toBeNull();
    expect(after.x).toBe(1);
  });

  it("never reports a position behind the finished lerp", () => {
    const { socket, session } = connected();
    socket.deliver(patch([], [walkStarted]));

    // One frame at a time across the whole step and the latency after it. A
    // frame that shows progress 0 with the walk gone is the twitch.
    for (let elapsed = 0; elapsed < WALK_DURATION_MS * 3; elapsed += 16) {
      session.update(16);
      const self = session.getSnapshot().self;
      expect(self.walk).not.toBeNull();
    }

    socket.deliver(patch(stepCommitted));
    expect(session.getSnapshot().self.walk).toBeNull();
  });

  it("hands the next step straight to the lerp", () => {
    const { socket, session } = connected();
    socket.deliver(patch([], [walkStarted]));
    session.update(WALK_DURATION_MS);

    // A held key: the server commits one step and starts the next in the same
    // tick, so both travel in one patch — cells first, then the event.
    socket.deliver(
      patch(stepCommitted, [
        {
          kind: "walkStarted",
          actorId: SELF,
          from: { x: 1, y: 0, z: 0 },
          to: { x: 2, y: 0, z: 0 },
          direction: "e",
        },
      ]),
    );

    const self = session.getSnapshot().self;
    expect(self.x).toBe(1);
    expect(self.walk?.to).toEqual({ x: 2, y: 0, z: 0 });
    expect(self.walkProgress).toBe(0);
  });
});

/**
 * A drop of two height units from (0,0,1) onto the grass at (0,0,0).
 *
 * One level down, so the landing does move the actor's cell — but the fall is
 * released by elevation, not by that move, because a fall inside a level lands
 * without changing the cell at all.
 */
const LANDING_ABS = 0;
const fallStarted: MotionEvent = {
  kind: "fallStarted",
  actorId: SELF,
  feetAbs: 2,
  landingAbs: LANDING_ABS,
};

/** The landing, as the server commits it. */
const landingCommitted: CellPatch[] = [
  { x: 0, y: 0, z: 1, stack: [] },
  { x: 0, y: 0, z: 0, stack: [grass, player] },
];

/** The actor standing one level up, mid-air over the grass it will land on. */
function aloftMap(): FlatMapFile {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < 4; x++) cells[`${x},0`] = [grass];
  return {
    version: 1,
    levels: { "0": cells, "1": { "0,0": [player] } },
  } as unknown as FlatMapFile;
}

function connectedAloft(): { socket: FakeSocket; session: RemoteSession } {
  const socket = new FakeSocket();
  const session = new RemoteSession(socket as unknown as WebSocket, tiles);
  socket.deliver({
    type: "hello",
    selfId: SELF,
    map: aloftMap(),
    actorIds: [SELF],
    playerCount: 1,
    minutesOfDay: SERVER_MINUTES,
    hps: [],
    carriedLights: [],
    equipment: emptyEquipment(),
    tags: [],
    statuses: [],
  });
  return { socket, session };
}

describe("RemoteSession fall interpolation", () => {
  it("holds the sprite on the landing until the patch commits it", () => {
    const { socket, session } = connectedAloft();
    socket.deliver(patch([], [fallStarted]));

    // Past the whole two-unit drop, with the patch still in flight.
    session.update(FALL_MS_PER_HEIGHT * 2 + 100);

    const mid = session.getSnapshot().self;
    expect(mid.fall).not.toBeNull();
    // Standing on the landing already, so the sprite has nowhere left to go.
    expect(mid.fall?.feetAbs).toBe(LANDING_ABS);
    // And the map still has them a level up, which is why dropping the fall
    // here snapped the sprite back into the air.
    expect(mid.z).toBe(1);

    socket.deliver(patch(landingCommitted));

    const after = session.getSnapshot().self;
    expect(after.fall).toBeNull();
    expect(after.z).toBe(0);
  });

  it("never shows a frame between the landing and the patch", () => {
    const { socket, session } = connectedAloft();
    socket.deliver(patch([], [fallStarted]));

    for (let elapsed = 0; elapsed < FALL_MS_PER_HEIGHT * 4; elapsed += 16) {
      session.update(16);
      // A frame with no fall is a frame drawn at the map's stale position.
      expect(session.getSnapshot().self.fall).not.toBeNull();
    }

    socket.deliver(patch(landingCommitted));
    expect(session.getSnapshot().self.fall).toBeNull();
  });

  it("keeps the descent moving at one unit per fall step", () => {
    const { socket, session } = connectedAloft();
    socket.deliver(patch([], [fallStarted]));

    session.update(FALL_MS_PER_HEIGHT);
    // The first unit is done and the second is under way — not stalled at the
    // boundary waiting for anything.
    expect(session.getSnapshot().self.fall?.feetAbs).toBe(1);
  });
});

describe("RemoteSession clock", () => {
  it("takes the world's time of day from the server", () => {
    const { session } = connected();
    expect(session.minutesOfDay()).toBe(SERVER_MINUTES);
  });
});

/**
 * Speech is the one thing on this wire the server announces once and then
 * forgets about. Its whole lifetime is the client's to run, so this is where
 * "five seconds" is actually enforced.
 */
describe("RemoteSession chat", () => {
  const said = {
    type: "chat",
    actorId: SELF,
    tileId: PLAYER_TILE_ID,
    text: "hey there!",
    x: 2,
    y: 0,
    z: 0,
    stackIndex: 1,
  };

  it("hangs a bubble at the cell the server pinned it to", () => {
    const { socket, session } = connected();
    socket.deliver(said);

    const [bubble] = session.getSnapshot().chats;
    expect(bubble).toMatchObject({
      actorId: SELF,
      // The body the speaker was in travels with the words, so the renderer can
      // tell a person's line from a deer's without asking the board about a
      // speaker who may have walked off or been erased.
      tileId: PLAYER_TILE_ID,
      text: "hey there!",
      x: 2,
      y: 0,
      z: 0,
    });
  });

  it("leaves the bubble where it was said when its author walks off", () => {
    const { socket, session } = connected();
    socket.deliver(said);
    socket.deliver(patch(stepCommitted, [walkStarted]));

    // The actor has moved and the bubble has not: pinned to a coordinate, not
    // carried by a body.
    expect(session.getSnapshot().chats[0]).toMatchObject({ x: 2, y: 0 });
  });

  it("takes the bubble away after its five seconds", () => {
    const { socket, session } = connected();
    socket.deliver(said);

    session.update(CHAT_LIFETIME_MS - 1);
    expect(session.getSnapshot().chats).toHaveLength(1);

    session.update(1);
    expect(session.getSnapshot().chats).toHaveLength(0);
  });

  it("ages each bubble on its own clock", () => {
    const { socket, session } = connected();
    socket.deliver(said);
    session.update(CHAT_LIFETIME_MS - 100);
    socket.deliver({ ...said, text: "and another" });

    // The first is due and the second has just arrived.
    session.update(100);
    const texts = session.getSnapshot().chats.map((c) => c.text);
    expect(texts).toEqual(["and another"]);
  });

  it("gives two identical lines from one actor separate bubbles", () => {
    const { socket, session } = connected();
    socket.deliver(said);
    socket.deliver(said);

    const chats = session.getSnapshot().chats;
    expect(chats).toHaveLength(2);
    // Distinct ids, or the renderer's element cache would treat them as one
    // label that never moved and the second would be invisible.
    expect(chats[0]!.id).not.toBe(chats[1]!.id);
  });

  /**
   * Bubbles at one cell stack upward, so an unbounded column would climb the
   * screen and bury the world.
   */
  it("holds a cell to three bubbles, dropping the oldest at once", () => {
    const { socket, session } = connected();
    for (const text of ["one", "two", "three", "four"]) {
      socket.deliver({ ...said, text });
    }

    // The fourth does not wait for the first to time out.
    expect(session.getSnapshot().chats.map((c) => c.text)).toEqual([
      "two",
      "three",
      "four",
    ]);
  });

  it("counts that cap per cell, not across the board", () => {
    const { socket, session } = connected();
    for (const text of ["a1", "a2", "a3"]) socket.deliver({ ...said, text });
    for (const text of ["b1", "b2", "b3"]) {
      socket.deliver({ ...said, x: 3, text });
    }

    // Six bubbles alive, three at each of two cells.
    expect(session.getSnapshot().chats.map((c) => c.text)).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
      "b2",
      "b3",
    ]);
  });

  it("keeps oldest-first order, which is what the renderer stacks by", () => {
    const { socket, session } = connected();
    for (const text of ["first", "second"]) socket.deliver({ ...said, text });

    expect(session.getSnapshot().chats.map((c) => c.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("carries the speaker's stack index, so the bubble can clear their head", () => {
    const { socket, session } = connected();
    socket.deliver(said);

    expect(session.getSnapshot().chats[0]!.stackIndex).toBe(1);
  });

  /**
   * A restart moves everyone. Every bubble is pinned to a coordinate in a world
   * that no longer exists, so they would hang over whatever is there now.
   */
  it("clears bubbles when the world restarts", () => {
    const { socket, session } = connected();
    socket.deliver(said);
    socket.deliver({
      type: "hello",
      selfId: SELF,
      map: flatMap(),
      actorIds: [SELF],
      playerCount: 1,
      minutesOfDay: SERVER_MINUTES,
      hps: [],
      carriedLights: [],
    equipment: emptyEquipment(),
    tags: [],
    statuses: [],
    });

    expect(session.getSnapshot().chats).toHaveLength(0);
  });

  it("sends what was typed, trimmed", () => {
    const { socket, session } = connected();
    session.say("  hey there!  ");

    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "say",
      text: "hey there!",
    });
  });

  it("does not send an empty message", () => {
    const { socket, session } = connected();
    const before = socket.sent.length;
    session.say("   ");
    expect(socket.sent).toHaveLength(before);
  });

  it("sends a slashed line as an instruction rather than as speech", () => {
    const { socket, session } = connected();
    session.say("  /mastery blade 10  ");

    // The whole reason the sorting happens here: a command that went out as
    // `say` would be a private line the room reads before the server takes it
    // back. @see ../game/commands
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "command",
      text: "/mastery blade 10",
    });
  });

  it("still says a sentence with a slash inside it", () => {
    const { socket, session } = connected();
    session.say("and/or");
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "say",
      text: "and/or",
    });
  });
});

/**
 * Walking your own actor, drawn before the server has heard about it.
 *
 * The latency this removes is not the round trip on any one step — that one
 * could be hidden by predicting the first step alone. It is the stall that
 * follows: a walk lerp finishes in 200ms and the patch confirming it cannot
 * arrive for a round trip after that, so a client that predicted only the start
 * would stand at the destination waiting, and a held key would stutter its way
 * across the room. Predicting the *chain* is the point, and most of what is
 * below is about the chain not stalling and the corrections not being visible.
 */

/** Every step frame this client has put on the wire, in order. */
function stepsSent(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "step");
}

function framesOfType(socket: FakeSocket, type: string) {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === type);
}

/** The commit of a step from x=`from` to x=`from + 1`, as the server sends it. */
function committedTo(from: number): CellPatch[] {
  return [
    { x: from, y: 0, z: 0, stack: [grass] },
    { x: from + 1, y: 0, z: 0, stack: [grass, player] },
  ];
}

/** Somebody swinging east, as the server announces it. */
const strikeStarted: MotionEvent = {
  kind: "strikeStarted",
  actorId: SELF,
  strike: "swing",
  dx: 1,
  dy: 0,
  dElev: 0,
};

describe("RemoteSession strikes", () => {
  it("leans on the event and recovers on its own clock", () => {
    const { socket, session } = connected();
    socket.deliver(patch([], [strikeStarted]));

    expect(session.getSnapshot().self.strike).toMatchObject({ dx: 1, dy: 0 });

    // No patch confirms a lean, because a lean changes nothing about the board:
    // unlike a walk, the only thing that ends it is the clock.
    session.update(STRIKE_DURATION_MS);

    expect(session.getSnapshot().self.strike).toBeNull();
  });

  /**
   * The subtle one. Every other event about this client's own body is motion it
   * never predicted, and arriving is grounds for throwing its guesses away. A
   * strike is not: the striker never leaves its cell, so a swing thrown while
   * walking has nothing to say about where the walker is — and a client that
   * treated it as news would drop its own footwork on every blow it landed.
   */
  it("does not cost the walker the step it predicted", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    const predicted = session.getSnapshot().self.walk;

    socket.deliver(patch([], [strikeStarted]));

    const self = session.getSnapshot().self;
    expect(self.walk).toBe(predicted);
    expect(self.strike).not.toBeNull();
  });
});

/** The plant a blow costs its thrower, as the server announces it. */
const swung: MotionEvent = { kind: "swung", actorId: SELF };

/**
 * The one rule this side has to re-run rather than be told the outcome of.
 *
 * Everything else about a fight arrives settled — what a blow came to, what a
 * body has left. A recovery is different because it refuses a *step*, and steps
 * are the one thing this client decides for itself: predict through one and
 * every cell of the run is a guess the server holds back, so the body walks at
 * the pace of the socket. @see `../game/GameSession`
 */
describe("RemoteSession attack recovery", () => {
  it("refuses to predict a step while this body is recovering", () => {
    const { socket, session } = connected();
    socket.deliver(patch([], [swung]));

    session.setInput({ directions: ["e"] });

    expect(session.getSnapshot().self.walk).toBeNull();
    expect(stepsSent(socket)).toEqual([]);
  });

  it("takes the step the frame the recovery runs out", () => {
    const { socket, session } = connected();
    socket.deliver(patch([], [swung]));
    session.setInput({ directions: ["e"] });

    session.update(WALK_DURATION_MS);

    expect(session.getSnapshot().self.walk?.to).toEqual({ x: 1, y: 0, z: 0 });
    expect(stepsSent(socket)).toHaveLength(1);
  });

  /**
   * A blow costs the step, not the aim — the same split the simulation draws,
   * and it has to be drawn in the same place or a planted player would face one
   * way here and another there.
   */
  it("still turns a planted body to face where it is asked to go", () => {
    const { socket, session } = connected();
    socket.deliver(patch([], [swung]));

    session.setInput({ directions: ["n"] });

    expect(session.getSnapshot().self.direction).toBe("n");
    expect(framesOfType(socket, "face")).toHaveLength(1);
  });

  /**
   * Only the start of a step. A walk already drawn cannot be taken back without
   * dragging the sprite backwards across a cell it has half crossed — which is
   * the one thing the simulation, which lets that walk finish, would never ask
   * for.
   */
  it("never interrupts a step already being drawn", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    const predicted = session.getSnapshot().self.walk;

    socket.deliver(patch([], [swung]));

    expect(session.getSnapshot().self.walk).toBe(predicted);
  });

  /** Somebody else's blow says nothing about this body's footwork. */
  it("ignores a blow thrown by anybody else", () => {
    const { socket, session } = connected();
    socket.deliver(patch([], [{ kind: "swung", actorId: "somebody-else" }]));

    session.setInput({ directions: ["e"] });

    expect(session.getSnapshot().self.walk?.to).toEqual({ x: 1, y: 0, z: 0 });
  });
});

describe("RemoteSession prediction", () => {
  it("walks on the key press, without waiting for the server", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });

    // No frame has been rendered and nothing has come back, yet the step is
    // already on screen. This is the whole feature.
    const self = session.getSnapshot().self;
    expect(self.walk?.to).toEqual({ x: 1, y: 0, z: 0 });
    expect(self.walkProgress).toBe(0);
    expect(stepsSent(socket)).toEqual([
      { type: "step", seq: 0, direction: "e", preferDescend: false },
    ]);
  });

  it("starts the next step the moment the last one lands", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);

    // Nothing has arrived from the server at all — no patch, no event. A client
    // that waited to be told would be standing still here.
    const self = session.getSnapshot().self;
    expect(self.x).toBe(1);
    expect(self.walk?.to).toEqual({ x: 2, y: 0, z: 0 });
    expect(self.walkProgress).toBe(0);
    expect(stepsSent(socket)).toHaveLength(2);
  });

  it("walks at the same pace whatever the frame rate", () => {
    const distanceAfterThreeSteps = (frameMs: number) => {
      const { session } = connected();
      session.setInput({ directions: ["e"] });
      // Three steps' worth of frames, with nothing back from the server at all.
      for (let t = 0; t < WALK_DURATION_MS * 3; t += frameMs) {
        session.update(frameMs);
      }
      return session.getSnapshot().self.x;
    };

    // A step is 200ms of the world's time, not of drawn time. Throwing away the
    // part of a frame that overran a landing would make a step cost a whole
    // extra frame each — and a 20fps client walk visibly slower than a 60fps one.
    expect(distanceAfterThreeSteps(20)).toBe(3);
    expect(distanceAfterThreeSteps(50)).toBe(3);
  });

  it("walks the steps a dropped frame covered rather than losing them", () => {
    const { session } = connected();
    session.setInput({ directions: ["e"] });

    // One frame worth two steps: a tab coming back from the background.
    session.update(WALK_DURATION_MS * 2);

    expect(session.getSnapshot().self.x).toBe(2);
  });

  it("does not move when the confirmation finally lands", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);
    session.setInput({ directions: [] });

    const before = session.getSnapshot().self;
    socket.deliver(
      patch(committedTo(0), [
        { ...walkStarted, from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } },
      ]),
    );

    // The server catching up with a step already drawn must be invisible: the
    // actor was here before the patch and is here after it.
    const after = session.getSnapshot().self;
    expect(after.x).toBe(before.x);
    expect(after.walk?.to).toEqual(before.walk?.to);
  });

  it("ignores the server's account of a walk it drew itself", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS / 2);

    const progress = session.getSnapshot().self.walkProgress;
    socket.deliver(patch([], [walkStarted]));

    // Replaying it would restart the lerp and jerk the sprite backwards.
    expect(session.getSnapshot().self.walkProgress).toBe(progress);
  });

  it("puts the actor back when the server refuses a step", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);
    session.setInput({ directions: [] });
    expect(session.getSnapshot().self.x).toBe(1);

    socket.deliver({ type: "stepRejected", seq: 0 });

    const self = session.getSnapshot().self;
    expect(self.x).toBe(0);
    expect(self.walk).toBeNull();
  });

  it("drops the steps taken after a refused one too", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS * 2);
    session.setInput({ directions: [] });
    expect(session.getSnapshot().self.x).toBe(2);

    // The second step was chosen from a cell the first never reached, so it was
    // never a step from anywhere the actor stood.
    socket.deliver({ type: "stepRejected", seq: 0 });

    expect(session.getSnapshot().self.x).toBe(0);
  });

  it("keeps the earlier steps when a later one is refused", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS * 2);
    session.setInput({ directions: [] });

    socket.deliver({ type: "stepRejected", seq: 1 });

    expect(session.getSnapshot().self.x).toBe(1);
  });

  it("gives up on a step nothing ever answers for", () => {
    const { session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);
    session.setInput({ directions: [] });

    for (let t = 0; t < STEP_CONFIRM_TIMEOUT_MS; t += 16) session.update(16);

    expect(session.getSnapshot().self.x).toBe(0);
  });

  it("hands the board back to the server when it says we are falling", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);
    session.setInput({ directions: [] });

    // Motion this client never predicted: whatever it thought it was doing is
    // void, and the server's board is the only one worth drawing.
    socket.deliver(patch([], [fallStarted]));

    const self = session.getSnapshot().self;
    expect(self.x).toBe(0);
    expect(self.fall).not.toBeNull();
  });

  it("stops the moment the key is released", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);
    session.setInput({ directions: [] });
    session.update(WALK_DURATION_MS * 3);

    // Two steps drawn, two steps sent, and no third of either. Nothing is
    // holding a key on this side, and the server is never asked to guess.
    expect(session.getSnapshot().self.x).toBe(2);
    expect(stepsSent(socket)).toHaveLength(2);
  });

  it("turns without walking when asked only to face", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"], faceOnly: true });

    const self = session.getSnapshot().self;
    expect(self.direction).toBe("e");
    expect(self.walk).toBeNull();
    expect(stepsSent(socket)).toHaveLength(0);
    expect(framesOfType(socket, "face")).toEqual([
      { type: "face", direction: "e" },
    ]);
  });

  it("sends one facing, however long the key is held", () => {
    const { socket, session } = connected();
    session.setInput({ directions: ["e"], faceOnly: true });
    for (let t = 0; t < WALK_DURATION_MS * 2; t += 16) session.update(16);

    expect(framesOfType(socket, "face")).toHaveLength(1);
  });

});

describe("RemoteSession headcount", () => {
  const OTHER = "them";

  it("takes the count from the hello", () => {
    const { session } = connected();
    expect(session.playerCount()).toBe(1);
  });

  it("tells a listener registered after the hello", () => {
    const { session } = connected();
    const seen: number[] = [];
    session.setOnPlayers((count) => seen.push(count));

    expect(seen).toEqual([1]);
  });

  it("follows arrivals and departures", () => {
    const { socket, session } = connected();
    const seen: number[] = [];
    session.setOnPlayers((count) => seen.push(count));

    socket.deliver(patch([], [{ kind: "joined", actorId: OTHER, playerCount: 2 }]));
    socket.deliver(patch([], [{ kind: "left", actorId: OTHER, playerCount: 1 }]));

    expect(seen).toEqual([1, 2, 1]);
    expect(session.playerCount()).toBe(1);
  });

  /**
   * The count travels whole rather than as a delta, so the `joined` announcing
   * an arrival the `hello` had already counted is a no-op — the case that would
   * have every tab open one player too many.
   */
  it("says nothing when a repeat lands on the same number", () => {
    const { socket, session } = connected();
    const seen: number[] = [];
    session.setOnPlayers((count) => seen.push(count));

    socket.deliver(patch([], [{ kind: "joined", actorId: SELF, playerCount: 1 }]));

    expect(seen).toEqual([1]);
  });
});

/**
 * Attack mode, which is the client's stance rather than the world's state.
 *
 * The wire carries who you are pointing at and whether you mean it, and neither
 * says when a blow lands — that stays the server's clock. What matters here is
 * that the two survive the things that replace one end of the connection.
 */
describe("RemoteSession attack mode", () => {
  it("puts the stance on the wire, once per change", () => {
    const { socket, session } = connected();
    session.setAttackMode(true);
    session.setAttackMode(true);

    expect(framesOfType(socket, "attackMode")).toEqual([
      { type: "attackMode", enabled: true },
    ]);
    expect(session.getSnapshot().attacking).toBe(true);
  });

  /**
   * A restart seats a fresh body that is not swinging at anybody, so a stance
   * held here would be one the server never heard about — the button lit and
   * nothing happening. The target is dropped in the same breath, because it
   * names somebody in a world that no longer exists.
   */
  it("says it again when the world is replaced under it", () => {
    const { socket, session } = connected();
    session.setTarget("them");
    session.setAttackMode(true);

    socket.deliver({
      type: "hello",
      selfId: SELF,
      map: flatMap(),
      actorIds: [SELF],
      playerCount: 1,
      minutesOfDay: SERVER_MINUTES,
      hps: [],
      carriedLights: [],
    equipment: emptyEquipment(),
    tags: [],
    statuses: [],
    });

    expect(framesOfType(socket, "attackMode")).toEqual([
      { type: "attackMode", enabled: true },
      { type: "attackMode", enabled: true },
    ]);
    expect(session.getSnapshot().attacking).toBe(true);
    expect(session.getSnapshot().targetId).toBeNull();
  });

  it("says nothing again when it was never on", () => {
    const { socket } = connected();

    socket.deliver({
      type: "hello",
      selfId: SELF,
      map: flatMap(),
      actorIds: [SELF],
      playerCount: 1,
      minutesOfDay: SERVER_MINUTES,
      hps: [],
      carriedLights: [],
    equipment: emptyEquipment(),
    tags: [],
    statuses: [],
    });

    expect(framesOfType(socket, "attackMode")).toEqual([]);
  });
});

/**
 * Death, which is the one thing on this wire the client cannot work out for
 * itself.
 *
 * A body missing from the board is the ordinary state of somebody walking
 * through a doorway this client has not been patched about yet, so "dead" has
 * to be *told* — and it is told once, after which the socket goes silent until
 * this side asks for a body back.
 */
describe("RemoteSession death", () => {
  /** The kit a death leaves behind: nothing, because it is all on the floor. */
  function died(equipment = emptyEquipment()) {
    return { type: "died", equipment };
  }

  /** The whole state a `rebirth` is answered with. @see GameServer.rebirth */
  function helloAgain() {
    return {
      type: "hello",
      selfId: SELF,
      map: flatMap(),
      actorIds: [SELF],
      playerCount: 1,
      minutesOfDay: SERVER_MINUTES,
      hps: [],
      carriedLights: [],
      equipment: emptyEquipment(),
      tags: [],
      statuses: [],
    };
  }

  it("tells a listener the moment the server says so", () => {
    const { socket, session } = connected();
    const seen: boolean[] = [];
    session.setOnDead((dead) => seen.push(dead));

    socket.deliver(died());

    expect(seen).toEqual([false, true]);
    expect(session.isDead()).toBe(true);
  });

  it("tells a listener that arrives after the death", () => {
    const { socket, session } = connected();
    socket.deliver(died());

    const seen: boolean[] = [];
    session.setOnDead((dead) => seen.push(dead));

    expect(seen).toEqual([true]);
  });

  /**
   * The kit rides on the death rather than on an `equipment` message, because
   * the runtime an `equipment` message is read off is what the death deletes.
   * Without this the panel keeps showing a sword that is lying on the floor.
   */
  it("takes the emptied kit off the death itself", () => {
    const { socket, session } = connected();

    socket.deliver(died());

    expect(session.getSnapshot().equipment).toEqual(emptyEquipment());
  });

  /**
   * The chips are the viewer's own and are flushed off a live runtime, which a
   * death deletes — so nothing else would ever take them down, and a corpse
   * would sit there poisoned behind the screen.
   */
  it("takes the statuses off a body that is gone", () => {
    const { socket, session } = connected();
    socket.deliver({
      type: "statuses",
      statuses: [{ defId: "poison", remainingMs: 5000, durationMs: 10_000 }],
    });
    expect(session.getSnapshot().self.statuses).toHaveLength(1);

    socket.deliver(died());

    expect(session.getSnapshot().self.statuses).toEqual([]);
  });

  it("stops stepping once it is dead", () => {
    const { socket, session } = connected();
    socket.deliver(died());

    session.setInput({ directions: ["e"] });

    // Told rather than inferred: the body is still on this client's copy of the
    // board — the patch that removes it is a separate message — so nothing but
    // the death itself could have stopped this step.
    expect(framesOfType(socket, "step")).toEqual([]);
  });

  it("asks for a body back, and only while it has none", () => {
    const { socket, session } = connected();

    session.rebirth();
    expect(framesOfType(socket, "rebirth")).toEqual([]);

    socket.deliver(died());
    session.rebirth();

    expect(framesOfType(socket, "rebirth")).toEqual([{ type: "rebirth" }]);
  });

  it("comes back to life on the hello that answers it", () => {
    const { socket, session } = connected();
    socket.deliver(died());
    const seen: boolean[] = [];
    session.setOnDead((dead) => seen.push(dead));

    socket.deliver(helloAgain());

    expect(seen).toEqual([true, false]);
    expect(session.isDead()).toBe(false);
  });

  it("steps again once it has a body", () => {
    const { socket, session } = connected();
    socket.deliver(died());
    socket.deliver(helloAgain());

    session.setInput({ directions: ["e"] });

    expect(framesOfType(socket, "step")).toHaveLength(1);
  });
});

/**
 * The one interaction whose gate is asked of the *body* rather than of the
 * board alone, and the one this side forgot to ask at all: the row said "Climb"
 * — the list builds it from `../game/affordances`, which this client shares —
 * while `canInteract` refused the tap it sends, so a ladder online was scenery
 * with a button that did nothing.
 */
describe("RemoteSession teleports", () => {
  const RUNG = { x: 0, y: 0, z: 0, stackIndex: 1 };
  const ladder: PlacedTile = { tileId: "ladder" } as PlacedTile;
  const wall: PlacedTile = { tileId: "wall" } as PlacedTile;

  /** Standing on a rung, with the level above open or walled off. */
  function onLadder(above: PlacedTile[]) {
    const socket = new FakeSocket();
    const session = new RemoteSession(socket as unknown as WebSocket, tiles);
    socket.deliver({
      type: "hello",
      selfId: SELF,
      map: {
        version: 1,
        levels: {
          "0": { "0,0": [grass, ladder, player] },
          "1": { "0,0": above },
        },
      } as unknown as FlatMapFile,
      actorIds: [SELF],
      playerCount: 1,
      minutesOfDay: SERVER_MINUTES,
      hps: [],
      carriedLights: [],
      equipment: emptyEquipment(),
      tags: [],
      statuses: [],
    });
    return { socket, session };
  }

  it("offers the climb it is standing on", () => {
    const { session } = onLadder([grass]);
    expect(session.canInteract(RUNG)).toBe(true);
  });

  it("puts the tap on the wire", () => {
    const { socket, session } = onLadder([grass]);
    expect(session.interact(RUNG)).toBe(true);
    expect(framesOfType(socket, "interact")).toEqual([
      { type: "interact", ref: RUNG },
    ]);
  });

  it("offers nothing when the far end has no room for the climber", () => {
    // The same refusal the server would make — see `teleportFits` — so the two
    // ends agree about which ladders are climbable.
    const { socket, session } = onLadder([wall]);
    expect(session.canInteract(RUNG)).toBe(false);
    expect(session.interact(RUNG)).toBe(false);
    expect(framesOfType(socket, "interact")).toEqual([]);
  });
});

/**
 * A creature killed mid-step never arrives anywhere, and this client is the
 * only one holding the reservation its walk made.
 */
describe("RemoteSession bodies taken off the board", () => {
  const RAT = "rat";
  const ratBody: PlacedTile = {
    tileId: "rat",
    direction: "w",
    owner: RAT,
  } as PlacedTile;

  /** The strip again, with a rat standing at x=2 facing the player. */
  function mapWithRat(): FlatMapFile {
    const flat = flatMap();
    const cells = flat.levels["0"] as unknown as Record<string, PlacedTile[]>;
    cells["2,0"] = [grass, ratBody];
    return flat;
  }

  function connectedWithRat(): { socket: FakeSocket; session: RemoteSession } {
    const socket = new FakeSocket();
    const session = new RemoteSession(socket as unknown as WebSocket, tiles);
    socket.deliver({
      type: "hello",
      selfId: SELF,
      map: mapWithRat(),
      actorIds: [SELF, RAT],
      playerCount: 1,
      minutesOfDay: SERVER_MINUTES,
      hps: [],
      carriedLights: [],
      equipment: emptyEquipment(),
      tags: [],
      statuses: [],
    });
    return { socket, session };
  }

  it("draws another body under a status the wire broadcast the ids of", () => {
    const { socket, session } = connectedWithRat();
    expect(session.getSnapshot().actors.find((a) => a.id === RAT)?.statuses)
      .toEqual([]);

    socket.deliver({
      ...patch([]),
      statusIds: [{ actorId: RAT, defIds: ["burned"] }],
    });

    const rat = session.getSnapshot().actors.find((a) => a.id === RAT);
    expect(rat?.statuses.map((s) => s.defId)).toEqual(["burned"]);
    // No countdown is broadcast, so the instance says so rather than guessing a
    // number — which reads through `taperAt` as "not winding down". Somebody
    // else's fire burns at full strength until it ends. @see StatusIdsPatch
    expect(rat?.statuses[0]?.remainingMs).toBe(UNKNOWN_REMAINING_MS);
  });

  it("takes a status off a body the wire says is clear", () => {
    const { socket, session } = connectedWithRat();
    socket.deliver({
      ...patch([]),
      statusIds: [{ actorId: RAT, defIds: ["burned"] }],
    });

    // An empty list is the server saying "put out", which is not the same as
    // never having heard about it.
    socket.deliver({
      ...patch([]),
      statusIds: [{ actorId: RAT, defIds: [] }],
    });
    expect(session.getSnapshot().actors.find((a) => a.id === RAT)?.statuses)
      .toEqual([]);
  });

  it("keeps the viewer's own countdown rather than the broadcast ids", () => {
    const { socket, session } = connectedWithRat();
    // Both arrive: the broadcast names everybody, the addressed message carries
    // the viewer's own figures. Their own has to win, or their effects would
    // stop winding down the moment somebody else caught fire.
    socket.deliver({
      type: "statuses",
      statuses: [{ defId: "poison", remainingMs: 4_000, durationMs: 9_000 }],
    });
    socket.deliver({
      ...patch([]),
      statusIds: [
        { actorId: SELF, defIds: ["poison"] },
        { actorId: RAT, defIds: ["burned"] },
      ],
    });

    const self = session.getSnapshot().actors.find((a) => a.id === SELF);
    expect(self?.statuses[0]?.remainingMs).toBe(4_000);
  });

  it("frees the cell a creature was walking into when it dies on the way", () => {
    const { socket, session } = connectedWithRat();

    // The rat steps towards the player, and is killed before it lands: the
    // whole of the news is its body leaving the board.
    socket.deliver(
      patch(
        [],
        [
          {
            kind: "walkStarted",
            actorId: RAT,
            from: { x: 2, y: 0, z: 0 },
            to: { x: 1, y: 0, z: 0 },
            direction: "w",
          },
        ],
      ),
    );
    session.update(WALK_DURATION_MS / 2);
    socket.deliver(patch([{ x: 2, y: 0, z: 0, stack: [grass] }]));

    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);

    expect(session.getSnapshot().self.x).toBe(1);
  });

  /**
   * The order the two arrive in is the trap: forget the rat on the cells and
   * the event behind them puts the reservation straight back.
   */
  it("frees it when the step and the death arrive in one frame", () => {
    const { socket, session } = connectedWithRat();

    socket.deliver(
      patch(
        [{ x: 2, y: 0, z: 0, stack: [grass] }],
        [
          {
            kind: "walkStarted",
            actorId: RAT,
            from: { x: 2, y: 0, z: 0 },
            to: { x: 1, y: 0, z: 0 },
            direction: "w",
          },
        ],
      ),
    );

    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);

    expect(session.getSnapshot().self.x).toBe(1);
  });

  it("still holds the cell for a creature that is only walking into it", () => {
    const { socket, session } = connectedWithRat();

    socket.deliver(
      patch(
        [],
        [
          {
            kind: "walkStarted",
            actorId: RAT,
            from: { x: 2, y: 0, z: 0 },
            to: { x: 1, y: 0, z: 0 },
            direction: "w",
          },
        ],
      ),
    );

    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);

    // Two bodies into one cell is the step the server would take back, so it is
    // the step this client must never draw.
    expect(session.getSnapshot().self.x).toBe(0);
  });

  /**
   * A step empties the cell behind it, which is the same evidence a death
   * leaves — and the reason absence is asked of the whole board rather than of
   * the cells one patch happened to carry.
   */
  it("keeps holding it across the patch that commits the creature's step", () => {
    const { socket, session } = connectedWithRat();

    socket.deliver(
      patch(
        [
          { x: 2, y: 0, z: 0, stack: [grass] },
          { x: 1, y: 0, z: 0, stack: [grass, ratBody] },
        ],
        [
          {
            kind: "walkStarted",
            actorId: RAT,
            from: { x: 1, y: 0, z: 0 },
            to: { x: 0, y: 0, z: 0 },
            direction: "w",
          },
        ],
      ),
    );

    session.setInput({ directions: ["e"] });
    session.update(WALK_DURATION_MS);

    // Still on the board one cell along, and still walking: the player is
    // blocked by the rat's body rather than by its reservation.
    expect(session.getSnapshot().self.x).toBe(0);
    expect(session.getSnapshot().actors).toHaveLength(2);
  });

  it("stops drawing a body the board no longer holds", () => {
    const { socket, session } = connectedWithRat();
    expect(session.getSnapshot().actors).toHaveLength(2);

    socket.deliver(patch([{ x: 2, y: 0, z: 0, stack: [grass] }]));

    expect(session.getSnapshot().actors).toHaveLength(1);
  });
});
