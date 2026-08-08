import { describe, expect, it } from "vitest";
import { WALK_DURATION_MS } from "../game/constants";
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

describe("RemoteSession clock", () => {
  it("takes the world's time of day from the server", () => {
    const { session } = connected();
    expect(session.minutesOfDay()).toBe(SERVER_MINUTES);
  });
});
