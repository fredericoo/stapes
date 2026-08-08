import { describe, expect, it } from "vitest";
import { FALL_MS_PER_HEIGHT, WALK_DURATION_MS } from "../game/constants";
import type { FlatMapFile, PlacedTile, TileDef } from "../lib/types";
import { normalizeTileDef } from "../lib/types";
import { RemoteSession } from "./RemoteSession";
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
