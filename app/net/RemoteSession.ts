import {
  FALL_MS_PER_HEIGHT,
  PUSH_STEP_MS,
  WALK_DURATION_MS,
} from "../game/constants";
import { actorDirection, locateActor, type ActorLocation } from "../game/actors";
import {
  canPushFrom,
  canSwitchFrom,
  type ObjectRef,
} from "../game/affordances";
import type {
  ActorSnapshot,
  FallState,
  GameInput,
  GameSnapshot,
  PlaySession,
  SlideSnapshot,
  WalkState,
} from "../game/GameSession";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import { chunkifyMap, emptyMap, setStacks } from "../lib/mapData";
import type { FlatMapFile, MapFile, TileDef } from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  parseServerMessage,
  type CellPatch,
  type ClientMessage,
  type MotionEvent,
} from "./protocol";

/** Motion a client is animating, with its own clock. */
type RemoteMotion = {
  walk: WalkState | null;
  fall: FallState | null;
  slide: { object: ObjectRef; from: { x: number; y: number; z: number }; elapsedMs: number } | null;
  /** Last place this actor was found, so relocating them stays a cell lookup. */
  lastSeen: ActorLocation | null;
};

/**
 * The world as this browser sees it.
 *
 * Implements the same interface as the local simulation, so the renderer cannot
 * tell them apart. The difference is only where truth comes from: cells arrive
 * as patches and are authoritative, while motion is interpolated locally from
 * the events that announced it.
 *
 * There is no client-side prediction. Input goes to the server and the answer
 * comes back as a `walkStarted`, so a step costs one round trip before it is
 * seen — simple and never wrong, at the price of feeling heavy on a slow link.
 */
export class RemoteSession implements PlaySession {
  private map: MapFile = emptyMap();
  private readonly tilesById: Record<string, TileDef>;
  private selfId = "";
  private serverMinutesOfDay: MinutesOfDay = DEFAULT_PLAY_MINUTES;
  private readonly motions = new Map<string, RemoteMotion>();
  private hovered: ObjectRef | null = null;
  private lastInput: string = "";
  private ready = false;
  private onReady: (() => void) | null = null;

  constructor(
    private readonly socket: WebSocket,
    tiles: TileDef[],
  ) {
    this.tilesById = tilesByIdFromList(tiles);
    socket.addEventListener("message", this.onMessage);
  }

  /** Fires once the first `hello` has landed and there is a world to draw. */
  setOnReady(cb: (() => void) | null) {
    this.onReady = cb;
    if (this.ready) cb?.();
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * The world's time of day as of the last `hello`.
   *
   * Read once, when the renderer starts: from there the renderer runs the same
   * rate the server does, so a single anchor is enough to keep two browsers in
   * the same hour without a clock on the wire every tick.
   */
  minutesOfDay(): MinutesOfDay {
    return this.serverMinutesOfDay;
  }

  dispose() {
    this.socket.removeEventListener("message", this.onMessage);
  }

  private onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const message = parseServerMessage(event.data);
    if (!message) return;

    if (message.type === "hello") {
      this.selfId = message.selfId;
      this.serverMinutesOfDay = message.minutesOfDay;
      this.map = chunkifyMap(message.map as FlatMapFile);
      // A restart moves everyone, so nothing that was animating still applies.
      this.motions.clear();
      for (const id of message.actorIds) this.motions.set(id, emptyMotion());
      this.ready = true;
      this.onReady?.();
      return;
    }

    this.applyCells(message.cells);
    for (const event of message.events) this.applyEvent(event);
  };

  /**
   * Cells are whole-stack replacements, applied in one `setStacks` call so each
   * affected chunk is copied once — the same discipline the simulation uses for
   * a multi-cell edit.
   */
  private applyCells(cells: CellPatch[]) {
    if (cells.length === 0) return;
    this.map = setStacks(this.map, cells);
  }

  private applyEvent(event: MotionEvent) {
    if (event.kind === "joined") {
      this.motions.set(event.actorId, emptyMotion());
      return;
    }
    if (event.kind === "left") {
      this.motions.delete(event.actorId);
      return;
    }

    const motion = this.motions.get(event.actorId) ?? emptyMotion();
    this.motions.set(event.actorId, motion);

    if (event.kind === "walkStarted") {
      motion.walk = {
        from: event.from,
        to: event.to,
        direction: event.direction,
        elapsedMs: 0,
      };
    } else if (event.kind === "fallStarted") {
      motion.fall = {
        feetAbs: event.feetAbs,
        landingAbs: event.landingAbs,
        elapsedMs: 0,
      };
    } else {
      motion.slide = { object: event.object, from: event.from, elapsedMs: 0 };
    }
  }

  /**
   * Advance local animation clocks.
   *
   * A finished walk is held at its destination rather than dropped, because the
   * timer running out is not the same event as the step becoming true. The
   * server announces the walk when it starts and commits it 200ms later, so the
   * patch lands one network latency after the lerp ends — drop the lerp on the
   * timer and the sprite falls back to the cell it is still standing in for
   * those few frames, then jumps forward again when the patch arrives. That is
   * the twitch. {@link releaseArrivedWalk} ends the walk on the patch instead.
   */
  update(dtMs: number) {
    for (const motion of this.motions.values()) {
      if (motion.walk) {
        motion.walk.elapsedMs = Math.min(
          WALK_DURATION_MS,
          motion.walk.elapsedMs + dtMs,
        );
      }
      // Mirrors the simulation's own fall: feet step down one height unit at a
      // time, and progress is the fraction of the *current* unit — which is
      // what the renderer subtracts from feetAbs to place the sprite.
      if (motion.fall) {
        motion.fall.elapsedMs += dtMs;
        while (motion.fall && motion.fall.elapsedMs >= FALL_MS_PER_HEIGHT) {
          motion.fall.elapsedMs -= FALL_MS_PER_HEIGHT;
          const nextFeet = motion.fall.feetAbs - 1;
          if (nextFeet <= motion.fall.landingAbs) {
            motion.fall = null;
            break;
          }
          motion.fall.feetAbs = nextFeet;
        }
      }
      if (motion.slide) {
        motion.slide.elapsedMs += dtMs;
        if (motion.slide.elapsedMs >= PUSH_STEP_MS) motion.slide = null;
      }
    }
  }

  getMap(): MapFile {
    return this.map;
  }

  /**
   * Where an actor is, read off the map rather than tracked separately.
   *
   * The map is the authority and it already carries ownership, so there is no
   * second copy of "where everyone is" to drift. `locateActor` confirms the
   * last known cell before it searches, so this stays a lookup per frame.
   */
  private locate(id: string, motion: RemoteMotion): ActorLocation | null {
    const found = locateActor(this.map, id, motion.lastSeen ?? undefined);
    motion.lastSeen = found;
    if (found) this.releaseArrivedWalk(motion, found);
    return found;
  }

  /**
   * End a walk once the map has moved the actor out of the cell it started in.
   *
   * Arrival is both when the walk *must* end and the only signal that it may.
   * The lerp is anchored on `from` — it drags the tile sitting in that stack
   * slot towards the destination — so once the patch commits the step, that slot
   * holds something else and the lerp would be animating the wrong tile.
   *
   * Held indefinitely until then, deliberately: the patch is the only thing
   * that can make the new position true, and if it never comes the actor is not
   * moving anyway. A grace period would just restore the twitch on a slow link.
   */
  private releaseArrivedWalk(motion: RemoteMotion, at: ActorLocation) {
    const from = motion.walk?.from;
    if (!from) return;
    if (at.x !== from.x || at.y !== from.y || at.z !== from.z) {
      motion.walk = null;
    }
  }

  private actorSnapshot(id: string, motion: RemoteMotion): ActorSnapshot | null {
    const loc = this.locate(id, motion);
    if (!loc) return null;

    const slide: SlideSnapshot | null = motion.slide
      ? {
          object: motion.slide.object,
          from: motion.slide.from,
          progress: Math.min(1, motion.slide.elapsedMs / PUSH_STEP_MS),
        }
      : null;

    return {
      id,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      direction: actorDirection(loc),
      walk: motion.walk,
      fall: motion.fall,
      walkProgress: motion.walk
        ? Math.min(1, motion.walk.elapsedMs / WALK_DURATION_MS)
        : 0,
      fallProgress: motion.fall
        ? Math.min(1, motion.fall.elapsedMs / FALL_MS_PER_HEIGHT)
        : 0,
      slide,
    };
  }

  getSnapshot(): GameSnapshot {
    const actors: ActorSnapshot[] = [];
    let self: ActorSnapshot | null = null;
    for (const [id, motion] of this.motions) {
      const snapshot = this.actorSnapshot(id, motion);
      if (!snapshot) continue;
      actors.push(snapshot);
      if (id === this.selfId) self = snapshot;
    }

    return {
      map: this.map,
      // Before the first hello, or in the gap after a restart, there is nothing
      // to centre on. A placeholder keeps the renderer's contract total rather
      // than making every caller handle a null actor.
      self: self ?? offscreenActor(this.selfId),
      actors,
      hover: this.hovered && this.canInteract(this.hovered) ? this.hovered : null,
    };
  }

  setHoveredObject(ref: ObjectRef | null) {
    this.hovered = ref;
  }

  /**
   * Answered locally, from the same rules the server validates with.
   *
   * Asking the server would put a round trip between the pointer moving and the
   * outline appearing. Because both sides run `../game/affordances` over the
   * same board, a client cannot offer something the server will refuse — beyond
   * the round trip of staleness that any shared world has.
   */
  canInteract(ref: ObjectRef): boolean {
    const motion = this.motions.get(this.selfId);
    if (!motion) return false;
    // Mid-motion the answer is no, matching the session's own gate.
    if (motion.walk || motion.fall || motion.slide) return false;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return false;
    return (
      canSwitchFrom(this.map, this.tilesById, loc, ref) ||
      canPushFrom(this.map, this.tilesById, loc, ref)
    );
  }

  interact(ref: ObjectRef): boolean {
    if (!this.canInteract(ref)) return false;
    this.send({ type: "interact", ref });
    // The board does not change here — it changes when the patch lands.
    return true;
  }

  /**
   * Send held input, but only when it actually changed.
   *
   * The renderer calls this on every key event, and a held key repeats; without
   * the guard a walk across a room would be hundreds of identical frames.
   */
  setInput(input: GameInput) {
    const message: ClientMessage = {
      type: "input",
      directions: input.directions,
      faceOnly: Boolean(input.faceOnly),
      preferDescend: Boolean(input.preferDescend),
    };
    const encoded = JSON.stringify(message);
    if (encoded === this.lastInput) return;
    this.lastInput = encoded;
    this.sendRaw(encoded);
  }

  private send(message: ClientMessage) {
    this.sendRaw(JSON.stringify(message));
  }

  private sendRaw(payload: string) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(payload);
  }
}

function emptyMotion(): RemoteMotion {
  return { walk: null, fall: null, slide: null, lastSeen: null };
}

/** Stand-in for an actor not on the board yet. Drawn nowhere, centres nothing. */
function offscreenActor(id: string): ActorSnapshot {
  return {
    id,
    x: 0,
    y: 0,
    z: 0,
    stackIndex: 0,
    direction: "s",
    walk: null,
    fall: null,
    walkProgress: 0,
    fallProgress: 0,
    slide: null,
  };
}
