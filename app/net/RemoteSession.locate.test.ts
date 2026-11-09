import { describe, expect, it, vi } from "vitest";
import { MAP_FILE_VERSION } from "../lib/types";
import type { FlatMapFile, PlacedTile, TileDef } from "../lib/types";
import { FRAME, tile } from "../lib/testTile";
import { emptyEquipment } from "../game/equipment";
import { findActorAnywhere } from "../game/actors";
import { presentLevels } from "../lib/mapData";
import { RemoteSession } from "./RemoteSession";
import type { CellPatch, MotionEvent } from "./protocol";

/**
 * Every walk of the whole board, `findActorAnywhere` included, starts by asking
 * which levels the board has. Wrapped rather than replaced, so the session
 * still gets the real answer and the test can count the walks.
 */
vi.mock("../lib/mapData", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mapData")>();
  return { ...actual, presentLevels: vi.fn(actual.presentLevels) };
});

const sweeps = vi.mocked(presentLevels);

const body = { height: 4, walkable: false, affectedByGravity: true, directional: true } as const;
const tiles: TileDef[] = [
  tile({ id: "grass", height: 0 }),
  tile({ id: "player", ...body, variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] } }),
  tile({
    id: "rat",
    ...body,
    actor: true,
    variants: { n: [FRAME], e: [FRAME], s: [FRAME], w: [FRAME] },
  }),
];

const SELF = "me";
const RAT = "n1";
const WIDTH = 20;
const RAT_HOME = 10;

const grass: PlacedTile = { tileId: "grass" };
const me: PlacedTile = { tileId: "player", direction: "s", owner: SELF };
const rat: PlacedTile = { tileId: "rat", direction: "s", owner: RAT };

function row(): FlatMapFile {
  const cells: Record<string, PlacedTile[]> = {};
  for (let x = 0; x < WIDTH; x++) cells[`${x},0`] = [grass];
  cells["0,0"] = [grass, me];
  cells[`${RAT_HOME},0`] = [grass, rat];
  return { version: MAP_FILE_VERSION, levels: { "0": cells } } as unknown as FlatMapFile;
}

class FakeSocket {
  readyState = 1;
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  addEventListener(_type: string, cb: (event: MessageEvent) => void) {
    this.listeners.add(cb);
  }

  removeEventListener(_type: string, cb: (event: MessageEvent) => void) {
    this.listeners.delete(cb);
  }

  send() {}

  deliver(message: unknown) {
    const event = { data: JSON.stringify(message) } as MessageEvent;
    for (const cb of [...this.listeners]) cb(event);
  }
}

function hello() {
  return {
    type: "hello",
    selfId: SELF,
    map: row(),
    actorIds: [SELF, RAT],
    minutesOfDay: 0,
    hps: [],
    carriedLights: [],
    equipment: emptyEquipment(),
    tags: [],
    statuses: [],
  };
}

function connected() {
  const socket = new FakeSocket();
  const session = new RemoteSession(socket as unknown as WebSocket, tiles);
  socket.deliver(hello());
  sweeps.mockClear();
  return { socket, session };
}

function patch(cells: CellPatch[], events: MotionEvent[] = []) {
  return { type: "patch", cells, events, hps: [], carriedLights: [] };
}

function moveRat(from: number, to: number): CellPatch[] {
  return [
    { x: from, y: 0, z: 0, stack: [grass] },
    { x: to, y: 0, z: 0, stack: [grass, rat] },
  ];
}

function drawnAt(session: RemoteSession, id: string) {
  const actor = session.getSnapshot().actors.find((a) => a.id === id);
  return actor ? { x: actor.x, y: actor.y, z: actor.z, stackIndex: actor.stackIndex } : null;
}

/** Counted before the sweep is run as the reference, which walks the board itself. */
function expectDrawnWithoutSweeping(
  session: RemoteSession,
  id: string,
  expected: { x: number; y: number; z: number; stackIndex: number } | null,
) {
  const drawn = drawnAt(session, id);
  expect(sweeps).not.toHaveBeenCalled();
  expect(drawn).toEqual(expected);
  const swept = findActorAnywhere(session.getMap(), id);
  expect(drawn).toEqual(
    swept && { x: swept.x, y: swept.y, z: swept.z, stackIndex: swept.stackIndex },
  );
  sweeps.mockClear();
}

describe("RemoteSession finds bodies without sweeping the board", () => {
  it("finds every body on the first snapshot after a hello", () => {
    const { session } = connected();

    expectDrawnWithoutSweeping(session, SELF, { x: 0, y: 0, z: 0, stackIndex: 1 });
    expectDrawnWithoutSweeping(session, RAT, { x: RAT_HOME, y: 0, z: 0, stackIndex: 1 });
  });

  it("finds a body that moved several cells across patches between two looks", () => {
    const { socket, session } = connected();
    drawnAt(session, RAT);

    for (let x = RAT_HOME; x < RAT_HOME + 5; x++) socket.deliver(patch(moveRat(x, x + 1)));

    expectDrawnWithoutSweeping(session, RAT, { x: RAT_HOME + 5, y: 0, z: 0, stackIndex: 1 });
  });

  it("finds the player's own body after a teleport", () => {
    const { socket, session } = connected();
    drawnAt(session, SELF);

    socket.deliver(
      patch(
        [
          { x: 0, y: 0, z: 0, stack: [grass] },
          { x: 7, y: 0, z: 0, stack: [grass, me] },
        ],
        [{ kind: "teleported", actorId: SELF }],
      ),
    );

    expectDrawnWithoutSweeping(session, SELF, { x: 7, y: 0, z: 0, stackIndex: 1 });
  });

  it("finds nobody for a dead player, frame after frame", () => {
    const { socket, session } = connected();
    socket.deliver(patch([{ x: 0, y: 0, z: 0, stack: [grass] }]));
    socket.deliver({ type: "died", equipment: emptyEquipment() });

    for (let frame = 0; frame < 3; frame++) {
      session.update(16);
      expect(session.spells()).toEqual([]);
      socket.deliver(patch([]));
    }
    expectDrawnWithoutSweeping(session, SELF, null);
  });
});
