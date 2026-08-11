import { describe, expect, it } from "vitest";
import { FALL_MS_PER_HEIGHT, WALK_DURATION_MS } from "../game/constants";
import type { FlatMapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { CHAT_LIFETIME_MS } from "./chat";
import { RemoteSession, STEP_CONFIRM_TIMEOUT_MS } from "./RemoteSession";
import type { CellPatch, MotionEvent } from "./protocol";

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
  tile({
    id: "player",
    height: 2,
    directional: true,
    affectedByGravity: true,
    walkable: false,
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
  });
  return { socket, session };
}

function patch(cells: CellPatch[], events: MotionEvent[] = []) {
  return { type: "patch", cells, events };
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
