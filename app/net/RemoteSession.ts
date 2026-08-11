import {
  FALL_MS_PER_HEIGHT,
  PLAYER_TILE_ID,
  PUSH_STEP_MS,
  WALK_DURATION_MS,
} from "../game/constants";
import {
  actorDirection,
  actorStillAt,
  locateActor,
  type ActorLocation,
} from "../game/actors";
import {
  canPushFrom,
  canSwitchFrom,
  type ObjectRef,
} from "../game/affordances";
import { moveEntity, setEntityDirection } from "../game/mapMutations";
import { chooseStep } from "../game/stepping";
import type {
  ActorSnapshot,
  ChatBubble,
  FallState,
  GameInput,
  GameSnapshot,
  PlaySession,
  SlideSnapshot,
  WalkState,
} from "../game/GameSession";
import { resolveWalkDurationMs, standingAbs } from "../game/movement";
import { DEFAULT_PLAY_MINUTES, type MinutesOfDay } from "../lib/clock";
import { chunkifyMap, emptyMap, getStack, setStacks } from "../lib/mapData";
import type {
  Coord,
  Direction,
  FlatMapFile,
  MapFile,
  TileDef,
} from "../lib/types";
import { tilesByIdFromList } from "../lib/validation";
import {
  CHAT_LIFETIME_MS,
  MAX_CHAT_LENGTH,
  MAX_CHATS_PER_CELL,
} from "./chat";
import {
  parseServerMessage,
  type CellPatch,
  type ClientMessage,
  type MotionEvent,
} from "./protocol";

/** A bubble on screen, with the clock that will take it away. */
type LiveChat = ChatBubble & { elapsedMs: number };

/** Motion a client is animating, with its own clock. */
type RemoteMotion = {
  walk: WalkState | null;
  fall: FallState | null;
  slide: { object: ObjectRef; from: { x: number; y: number; z: number }; elapsedMs: number } | null;
  /** Last place this actor was found, so relocating them stays a cell lookup. */
  lastSeen: ActorLocation | null;
};

/**
 * A step this client took on its own authority, still waiting to become true.
 *
 * `landed` is about the drawing rather than the server: it turns true when the
 * lerp finishes and the move goes into the predicted board, which is what lets
 * the next step be chosen from the cell this one reached. Until then the actor
 * is still being dragged out of the cell below and the board must still hold
 * them there.
 */
type PredictedStep = {
  seq: number;
  to: Coord;
  direction: Direction;
  landed: boolean;
  /** Time since it was sent, for {@link STEP_CONFIRM_TIMEOUT_MS}. */
  waitedMs: number;
};

/**
 * How far ahead of the server this client will walk before it waits.
 *
 * A step is confirmed a round trip *plus* a walk after it was sent, so several
 * are legitimately outstanding at once on exactly the slow link this prediction
 * exists for — a tight cap here would reinstate the stall it is meant to
 * remove. Eight covers a round trip well past a second. Past that something is
 * wrong rather than slow, and {@link STEP_CONFIRM_TIMEOUT_MS} is what notices.
 */
const MAX_PREDICTED_STEPS = 8;

/**
 * How long the oldest unconfirmed step waits before this client gives up on it.
 *
 * The backstop, not the mechanism: a refused step normally comes back as its own
 * message and is rolled back at once. This catches only the cases where no
 * answer arrives at all, and sits well past the round trip a confirmation takes
 * so an ordinary slow link never trips it.
 */
export const STEP_CONFIRM_TIMEOUT_MS = 2_000;

/**
 * The world as this browser sees it.
 *
 * Implements the same interface as the local simulation, so the renderer cannot
 * tell them apart. The difference is only where truth comes from: cells arrive
 * as patches and are authoritative, while motion is interpolated locally from
 * the events that announced it.
 *
 * Your own walking is the exception, and it is the reason this class is not
 * simply a patch applier. Asking the server to decide each step put a round trip
 * between pressing a key and moving, which on a distant object is the difference
 * between a game and a remote control. So this client decides its own steps from
 * the same rule the server validates with, draws them at once, and tells the
 * server afterwards.
 *
 * That leaves two boards. {@link serverMap} is what the server last said, and
 * {@link map} — the one everything else reads — is that board with the steps it
 * has not confirmed yet replayed on top. Every patch rebuilds the second from
 * the first, so a mistaken guess is corrected by the next thing the server says
 * rather than accumulating. Only your own walking is predicted: falls, pushes
 * and switches still cost their round trip, which keeps the guessing to the one
 * thing that is held down for seconds at a time.
 */
export class RemoteSession implements PlaySession {
  /** The board as the server last described it. */
  private serverMap: MapFile = emptyMap();
  /** {@link serverMap} plus {@link pending}. What the renderer draws. */
  private map: MapFile = emptyMap();
  private readonly tilesById: Record<string, TileDef>;
  private selfId = "";
  private serverMinutesOfDay: MinutesOfDay = DEFAULT_PLAY_MINUTES;
  private readonly motions = new Map<string, RemoteMotion>();
  /** Steps drawn but not yet confirmed by the server, oldest first. */
  private pending: PredictedStep[] = [];
  private nextStepSeq = 0;
  /** What the player is holding, so a finished step can chain into the next. */
  private held: GameInput = { directions: [] };
  /** Last facing sent, so a held key does not resend it every frame. */
  private facing: Direction | null = null;
  /** Where the server last had us, so finding it stays a cell lookup. */
  private serverSeen: ActorLocation | null = null;
  private chats: LiveChat[] = [];
  /** Ticks up per message, so two lines from one actor are two bubbles. */
  private nextChatId = 0;
  private hovered: ObjectRef | null = null;
  private ready = false;
  private onReady: (() => void) | null = null;
  /** How many people the server last said were here. */
  private players = 0;
  private onPlayers: ((count: number) => void) | null = null;

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
   * Watch the headcount.
   *
   * Pushed rather than polled because it changes on somebody else's timetable
   * and can sit unchanged for hours; asking every frame would be a render of
   * the same number sixty times a second. Fires on registration too, for a
   * listener that arrives after the `hello` it would have learnt from.
   */
  setOnPlayers(cb: ((count: number) => void) | null) {
    this.onPlayers = cb;
    if (this.ready) cb?.(this.players);
  }

  playerCount(): number {
    return this.players;
  }

  /** Take a headcount from the wire, telling anyone watching if it moved. */
  private setPlayers(count: number) {
    if (count === this.players) return;
    this.players = count;
    this.onPlayers?.(count);
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
      this.serverMap = chunkifyMap(message.map as FlatMapFile);
      this.map = this.serverMap;
      // A restart moves everyone, so nothing that was animating still applies —
      // including every step this client was still holding a guess about.
      this.pending = [];
      this.facing = null;
      this.serverSeen = null;
      this.motions.clear();
      // And every bubble is pinned to a coordinate in a world that no longer
      // exists, which would leave them hanging over whatever is there now.
      this.chats = [];
      for (const id of message.actorIds) this.motions.set(id, emptyMotion());
      this.setPlayers(message.playerCount);
      this.ready = true;
      this.onReady?.();
      return;
    }

    if (message.type === "chat") {
      // Arrives already scoped to this viewer's level — the server sends it
      // nowhere else — so there is nothing to filter here.
      this.chats.push({
        id: `chat-${this.nextChatId++}`,
        actorId: message.actorId,
        text: message.text,
        x: message.x,
        y: message.y,
        z: message.z,
        stackIndex: message.stackIndex,
        elapsedMs: 0,
      });
      this.evictOldestAtCell(message);
      return;
    }

    if (message.type === "stepRejected") {
      this.rollBackFrom(message.seq);
      return;
    }

    this.applyCells(message.cells);
    for (const event of message.events) this.applyEvent(event);
    this.rebuildPredicted();
  };

  /**
   * How fast whatever is standing at `at` walks.
   *
   * Taken from the top of the stack, which is where a body sits. A cell that
   * has already been patched out from under the event falls back to the
   * player's pace — the wrong answer for one step of one creature, and better
   * than refusing to animate it.
   */
  private walkDurationAt(at: { x: number; y: number; z: number }): number {
    const stack = getStack(this.map, at.x, at.y, at.z);
    const def = this.tilesById[stack[stack.length - 1]?.tileId ?? ""];
    return def ? resolveWalkDurationMs(def) : WALK_DURATION_MS;
  }

  /**
   * Cells are whole-stack replacements, applied in one `setStacks` call so each
   * affected chunk is copied once — the same discipline the simulation uses for
   * a multi-cell edit.
   *
   * Applied to the server's board rather than the drawn one. The drawn board is
   * derived — see {@link rebuildPredicted} — and writing a patch straight into
   * it would bake this client's guesses into the very thing that is supposed to
   * be able to correct them.
   */
  private applyCells(cells: CellPatch[]) {
    if (cells.length === 0) return;
    this.serverMap = setStacks(this.serverMap, cells);
  }

  private applyEvent(event: MotionEvent) {
    if (event.kind === "joined") {
      this.motions.set(event.actorId, emptyMotion());
      this.setPlayers(event.playerCount);
      return;
    }
    if (event.kind === "left") {
      this.motions.delete(event.actorId);
      this.setPlayers(event.playerCount);
      return;
    }

    if (event.actorId === this.selfId) {
      // A walk of our own is one we drew a round trip ago and are still holding
      // a guess about; this is the server agreeing, not news, and replaying it
      // would restart a lerp that has already finished.
      if (event.kind === "walkStarted" && this.pending.length > 0) return;
      // Anything else it does to us is motion this client never predicted — a
      // fall above all — so whatever it thought it was doing is void.
      this.abandonPrediction();
    }

    const motion = this.motions.get(event.actorId) ?? emptyMotion();
    this.motions.set(event.actorId, motion);

    if (event.kind === "walkStarted") {
      motion.walk = {
        from: event.from,
        to: event.to,
        direction: event.direction,
        elapsedMs: 0,
        // Read off the body rather than sent with the event: this side already
        // knows which tile is walking, so deriving the pace here cannot
        // disagree with the server and costs nothing on the wire.
        durationMs: this.walkDurationAt(event.from),
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
   *
   * None of which applies to this client's own walking, which is predicted: it
   * lands on its own timer because this side is the one that decided it, and
   * {@link landPredictedStep} is what commits it.
   */
  update(dtMs: number) {
    for (const [id, motion] of this.motions) {
      if (motion.walk) {
        // A predicted walk is allowed past its own duration; every other walk
        // is held at it. The overshoot is not wasted time, it is the part of
        // the frame that belongs to the *next* step, and
        // {@link landPredictedStep} hands it on. Rounded away instead, a step
        // would cost a whole frame more than it should — 208ms at 60fps, 231ms
        // at 30fps — and how fast you walk would depend on your frame rate.
        motion.walk.elapsedMs = this.isPredicting(id)
          ? motion.walk.elapsedMs + dtMs
          : Math.min(motion.walk.durationMs, motion.walk.elapsedMs + dtMs);
      }
      // Mirrors the simulation's own fall: feet step down one height unit at a
      // time, and progress is the fraction of the *current* unit — which is
      // what the renderer subtracts from feetAbs to place the sprite. A fall
      // that has reached its landing stops advancing and waits to be released,
      // for the same reason a finished walk does; see {@link releaseLandedFall}.
      const fall = motion.fall;
      if (fall && fall.feetAbs > fall.landingAbs) {
        fall.elapsedMs += dtMs;
        while (fall.elapsedMs >= FALL_MS_PER_HEIGHT) {
          fall.elapsedMs -= FALL_MS_PER_HEIGHT;
          const nextFeet = fall.feetAbs - 1;
          if (nextFeet <= fall.landingAbs) {
            fall.feetAbs = fall.landingAbs;
            fall.elapsedMs = 0;
            break;
          }
          fall.feetAbs = nextFeet;
        }
      }
      if (motion.slide) {
        motion.slide.elapsedMs += dtMs;
        if (motion.slide.elapsedMs >= PUSH_STEP_MS) motion.slide = null;
      }
    }

    this.agePendingSteps(dtMs);
    this.advancePrediction();
    this.expireChats(dtMs);
  }

  /**
   * Land whatever finished this frame, and start what comes next.
   *
   * A loop rather than a single pass, because one frame is not always one step:
   * a tab coming back from the background, or a device that dropped a few
   * hundred milliseconds, arrives with enough elapsed time for more than one.
   * Walking them all is what keeps a step worth 200ms of the world's time
   * rather than 200ms of *drawn* time.
   *
   * Bounded by how far ahead this client is willing to be anyway, so a stall
   * measured in seconds stops rather than sprinting off across the map.
   */
  private advancePrediction() {
    for (let taken = 0; taken < MAX_PREDICTED_STEPS; taken++) {
      const carryMs = this.landPredictedStep();
      this.predictStep(carryMs ?? 0);
      if (carryMs === null) return;
    }
  }

  /** Is this actor's current walk one this client drew for itself? */
  private isPredicting(id: string): boolean {
    if (id !== this.selfId) return false;
    const last = this.pending[this.pending.length - 1];
    return last ? !last.landed : false;
  }

  /**
   * Give up on a step nobody ever answered for.
   *
   * Only the oldest is timed, because they are confirmed in order: while the
   * front of the queue is moving, everything behind it is being answered too.
   */
  private agePendingSteps(dtMs: number) {
    const oldest = this.pending[0];
    if (!oldest) return;
    oldest.waitedMs += dtMs;
    if (oldest.waitedMs >= STEP_CONFIRM_TIMEOUT_MS) this.abandonPrediction();
  }

  /**
   * Put a finished step into the predicted board.
   *
   * The moment the lerp ends, not the moment the server confirms it — which is
   * the whole of what makes walking feel immediate. Holding the sprite at the
   * destination until the patch arrives is right for *other* people's walks,
   * because their next step is news that has not reached us; ours is not news,
   * so the actor arrives, the cell under them becomes true locally, and the next
   * step can be chosen from it without a pause.
   *
   * @returns the milliseconds the step overran by, which belong to the step
   *   after it, or null when nothing landed.
   */
  private landPredictedStep(): number | null {
    const motion = this.motions.get(this.selfId);
    const walk = motion?.walk;
    if (!motion || !walk || walk.elapsedMs < walk.durationMs) return null;

    const step = this.pending.find((pending) => !pending.landed);
    if (!step) return null;

    const at = locateActor(this.map, this.selfId, motion.lastSeen ?? undefined);
    if (!at) return null;

    const carryMs = walk.elapsedMs - walk.durationMs;

    this.map = moveEntity(this.map, at, step.to, step.direction, this.tilesById);
    step.landed = true;
    motion.walk = null;
    // moveEntity appends, so the actor is the top of the destination stack.
    // Recorded rather than searched for: the hint is what keeps locating an
    // actor a cell read, and it is exactly known here.
    const stack = getStack(this.map, step.to.x, step.to.y, step.to.z);
    motion.lastSeen = {
      ...step.to,
      stackIndex: stack.length - 1,
      placed: stack[stack.length - 1]!,
    };
    return carryMs;
  }

  /**
   * Take the next step the player is asking for, if the board allows it.
   *
   * Run both from the frame loop — so a held key chains step after step — and
   * straight off the key event in {@link setInput}, so the first one does not
   * wait for the next frame.
   *
   * @param elapsedMs how far into this step the frame that started it already
   *   is; see {@link landPredictedStep}.
   */
  private predictStep(elapsedMs = 0) {
    if (this.held.directions.length === 0) return;

    const motion = this.motions.get(this.selfId);
    if (!motion || motion.walk || motion.fall || motion.slide) return;
    if (this.pending.length >= MAX_PREDICTED_STEPS) return;

    const def = this.tilesById[PLAYER_TILE_ID];
    if (!def) return;
    const loc = this.locate(this.selfId, motion);
    if (!loc) return;

    const choice = chooseStep(
      this.map,
      loc,
      this.held,
      def,
      this.tilesById,
      (to) => this.destinationTaken(to),
    );
    if (!choice) return;

    this.face(loc, choice.facing);
    if (!choice.step) return;

    const seq = this.nextStepSeq++;
    motion.walk = {
      from: { x: loc.x, y: loc.y, z: loc.z },
      to: choice.step.to,
      direction: choice.step.direction,
      elapsedMs,
      // Our own body, so its pace is the one the server will time us by.
      durationMs: resolveWalkDurationMs(def),
    };
    this.pending.push({
      seq,
      to: choice.step.to,
      direction: choice.step.direction,
      landed: false,
      waitedMs: 0,
    });
    this.send({
      type: "step",
      seq,
      direction: choice.step.direction,
      preferDescend: Boolean(this.held.preferDescend),
    });
  }

  /**
   * Turn, locally and on the wire.
   *
   * Sent only when the facing actually changes. A held key asks for the same
   * one every frame, and the server has no more use for the ninetieth copy of
   * "still facing east" than it had for the held-direction stream this replaced.
   */
  private face(loc: Coord & { stackIndex: number }, direction: Direction) {
    this.map = setEntityDirection(
      this.map,
      loc.x,
      loc.y,
      loc.z,
      loc.stackIndex,
      direction,
    );
    if (this.facing === direction) return;
    this.facing = direction;
    this.send({ type: "face", direction });
  }

  /**
   * Is another actor already walking into this cell?
   *
   * The same question the simulation asks, answered from the same evidence: a
   * walk is not in the map until it lands, so the only sign of one is the event
   * that announced it. Asked here so that two players stepping into one cell is
   * a step this client never draws, rather than one the server takes back.
   */
  private destinationTaken(to: Coord): boolean {
    for (const [id, motion] of this.motions) {
      if (id === this.selfId) continue;
      const other = motion.walk?.to;
      if (other && other.x === to.x && other.y === to.y && other.z === to.z) {
        return true;
      }
    }
    return false;
  }

  /**
   * Rebuild the drawn board: what the server says, plus what we have not been
   * answered about yet.
   *
   * Replayed from the server's board every time rather than patched in place,
   * because a guess cannot be edited out of a board it was mixed into. The
   * replay is at most a handful of single-tile moves, and the map is
   * copy-on-write, so this touches the two chunks each step spans and nothing
   * else.
   */
  private rebuildPredicted() {
    const at = locateActor(
      this.serverMap,
      this.selfId,
      this.serverSeen ?? undefined,
    );
    this.serverSeen = at;

    if (!at) {
      // Not on the authoritative board at all — before the first patch that
      // carries us, or between a despawn and a respawn. Nothing to predict from.
      this.pending = [];
      this.map = this.serverMap;
      return;
    }

    this.dropConfirmedSteps(at);

    let map = this.serverMap;
    let loc: Coord & { stackIndex: number } = at;
    for (const step of this.pending) {
      // The step in flight is still being drawn out of the cell below it, which
      // is where the board has to keep holding the actor.
      if (!step.landed) break;
      if (!actorStillAt(map, this.selfId, loc)) {
        this.abandonPrediction();
        return;
      }
      map = moveEntity(map, loc, step.to, step.direction, this.tilesById);
      const stack = getStack(map, step.to.x, step.to.y, step.to.z);
      loc = { ...step.to, stackIndex: stack.length - 1 };
    }

    if (this.facing) {
      map = setEntityDirection(
        map,
        loc.x,
        loc.y,
        loc.z,
        loc.stackIndex,
        this.facing,
      );
    }
    this.map = map;
  }

  /**
   * Retire the steps the server has caught up with.
   *
   * A step is confirmed when the authoritative board has the actor standing on
   * its destination — the patch that commits it *is* the acknowledgement, so
   * nothing extra travels for the overwhelmingly common case of a step simply
   * being allowed.
   *
   * Strictly from the front, never by searching. Walking east and back west
   * again puts the starting cell in the queue twice, and a search would read
   * "still standing where you began" as proof that both had happened.
   */
  private dropConfirmedSteps(at: Coord) {
    while (this.pending.length > 0) {
      const step = this.pending[0]!;
      if (step.to.x !== at.x || step.to.y !== at.y || step.to.z !== at.z) return;
      this.pending.shift();
      // The server got there before the lerp did, which only happens on a link
      // fast enough for the round trip to beat the walk. Drop the animation
      // rather than let it drag a tile that has already arrived.
      if (!step.landed) {
        const motion = this.motions.get(this.selfId);
        if (motion) motion.walk = null;
      }
    }
  }

  /**
   * Undo a refused step, and everything drawn after it.
   *
   * The later steps go whatever the board says about them: each was chosen from
   * the cell the refused one would have reached, so with that cell taken away
   * none of them was ever a step from anywhere the actor stood.
   */
  private rollBackFrom(seq: number) {
    const at = this.pending.findIndex((step) => step.seq === seq);
    if (at < 0) return;
    this.pending.length = at;
    const motion = this.motions.get(this.selfId);
    if (motion) motion.walk = null;
    this.rebuildPredicted();
  }

  /** Drop every guess and stand where the server says. */
  private abandonPrediction() {
    if (this.pending.length === 0) return;
    this.pending = [];
    const motion = this.motions.get(this.selfId);
    if (motion) motion.walk = null;
    this.map = this.serverMap;
  }

  /**
   * Hold one cell to {@link MAX_CHATS_PER_CELL} bubbles.
   *
   * Bubbles at a coordinate stack upward, so an unbounded column would climb the
   * screen and bury the world. The oldest goes the moment a fourth lands rather
   * than being allowed to serve out its five seconds — what a reader wants from
   * a busy cell is the newest line, not the one that got there first.
   *
   * Insertion order is age order, so the first match is the oldest.
   */
  private evictOldestAtCell(at: { x: number; y: number; z: number }) {
    const here = this.chats.filter(
      (chat) => chat.x === at.x && chat.y === at.y && chat.z === at.z,
    );
    if (here.length <= MAX_CHATS_PER_CELL) return;
    const doomed = new Set(here.slice(0, here.length - MAX_CHATS_PER_CELL));
    this.chats = this.chats.filter((chat) => !doomed.has(chat));
  }

  /**
   * Age the bubbles out.
   *
   * Timed off the render loop's own delta, exactly like the motions above, so
   * the server announces a message once and never has to think about it again —
   * no five-second timer holding an idle world awake. The cost is that a
   * backgrounded tab holds its bubbles the same way it holds a half-finished
   * walk, which is the behaviour those already have.
   */
  private expireChats(dtMs: number) {
    if (this.chats.length === 0) return;
    let expired = false;
    for (const chat of this.chats) {
      chat.elapsedMs += dtMs;
      if (chat.elapsedMs >= CHAT_LIFETIME_MS) expired = true;
    }
    // Rebuilt only when something actually went, so a screen full of live
    // bubbles does not allocate a new array every frame.
    if (expired) {
      this.chats = this.chats.filter(
        (chat) => chat.elapsedMs < CHAT_LIFETIME_MS,
      );
    }
  }

  /**
   * Say something.
   *
   * No local echo. The author is on their own level, so the server's copy comes
   * back to them like anyone else's — one code path, and the bubble they see is
   * the bubble everyone else sees, cap and stripping included. Same trade the
   * rest of this class makes: a round trip of latency for never being wrong.
   */
  say(text: string) {
    const trimmed = text.trim().slice(0, MAX_CHAT_LENGTH);
    if (trimmed.length === 0) return;
    this.send({ type: "say", text: trimmed });
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
    if (found) {
      this.releaseArrivedWalk(motion, found);
      this.releaseLandedFall(motion, found);
    }
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

  /**
   * End a fall once the map has put the actor down on its landing.
   *
   * A walk is released by the actor leaving the cell it started in, but a
   * landing has no such signal: falling within a level commits without moving
   * the actor's cell at all. Elevation is the thing that actually changed, so
   * that is what is compared — the fall is over when the surface the map has
   * the actor standing on is no higher than the landing it was aimed at.
   *
   * Only ever asked once the client's own animation has reached the landing
   * (`feetAbs === landingAbs`). Mid-fall the map is not a reliable answer: an
   * actor passing through an odd height is placed a unit low, which for a short
   * drop already reads as the landing elevation.
   */
  private releaseLandedFall(motion: RemoteMotion, at: ActorLocation) {
    const fall = motion.fall;
    if (!fall || fall.feetAbs > fall.landingAbs) return;
    const footAbs = standingAbs(
      this.map,
      at.x,
      at.y,
      at.z,
      at.stackIndex,
      this.tilesById,
    );
    if (footAbs <= fall.landingAbs) motion.fall = null;
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
      tileId: loc.placed.tileId,
      x: loc.x,
      y: loc.y,
      z: loc.z,
      stackIndex: loc.stackIndex,
      direction: actorDirection(loc),
      walk: motion.walk,
      fall: motion.fall,
      walkProgress: motion.walk
        ? Math.min(1, motion.walk.elapsedMs / motion.walk.durationMs)
        : 0,
      // Unclamped for the same reason the simulation leaves it unclamped: a
      // fall runs unit after unit, and holding at 1 between them stutters.
      fallProgress: motion.fall
        ? motion.fall.elapsedMs / FALL_MS_PER_HEIGHT
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
      chats: this.chats,
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
    // And no while a step is still unconfirmed, for the same reason one cell
    // further back: the server gates interaction on the actor being idle, and
    // an actor this client has already walked is one the server is still
    // walking. Offering the affordance in that window would have the tap
    // silently refused at the other end.
    if (this.pending.length > 0) return false;
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
   * Take what the player is holding. Nothing is sent from here.
   *
   * Held directions used to *be* the message, and the server decided what they
   * meant. Now they are kept and acted on locally, and only the steps they
   * produce travel — so the wire carries one small frame per cell walked instead
   * of one per key event, and the first one goes out with the step already
   * drawn.
   *
   * Stepping immediately rather than waiting for the next frame: 16ms is small
   * next to the round trip just removed, but it is the first 16ms of the press
   * and it is free to not spend.
   */
  setInput(input: GameInput) {
    this.held = {
      directions: [...input.directions],
      faceOnly: input.faceOnly,
      preferDescend: input.preferDescend,
    };
    this.predictStep();
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
    // The viewer's own body, which is always a player's — this stands in for
    // one that has not arrived yet, not for one that turned out to be a deer.
    tileId: PLAYER_TILE_ID,
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
