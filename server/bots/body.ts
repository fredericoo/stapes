import { TICK_MS } from "../../app/game/constants";
import { bodyNameFor } from "../../app/game/displayName";
import type { GameSnapshot } from "../../app/game/GameSession";
import { HeldDirections } from "../../app/game/heldDirections";
import { WalkTo, type WalkView } from "../../app/game/walkTo";
import { minutesOfDayAt, type MinutesOfDay } from "../../app/lib/clock";
import { getStack } from "../../app/lib/mapData";
import { listStandingSurfaces, standingAbs } from "../../app/game/movement";
import { fitsAtElevation } from "../../app/lib/validation";
import {
  MIN_LEVEL,
  type Coord,
  type Direction,
  type MapFile,
  type TileDef,
} from "../../app/lib/types";
import { tilesByIdFromList } from "../../app/lib/validation";
import { RemoteSession } from "../../app/net/RemoteSession";
import type { BotSocket } from "./transport";
import { buildBotView, type BotView } from "./view";
import { describeCall, type BotAction } from "./tools";
import { noRouteNotice } from "../../app/game/notices";

/**
 * One bot's body: a real client of the world, with a controller on top of it.
 *
 * A `RemoteSession` and nothing else is what a browser holds, so a bot that
 * holds one can do exactly what a person can and no more — the server validates
 * its frames on the same path, having no idea which kind of client sent them.
 * There is no server change and no protocol change behind any of this; a bot
 * joins the way a tab joins.
 *
 * What is added on top is only steering. {@link HeldDirections} is the one list
 * every input device presses, {@link WalkTo} presses it towards a destination
 * once a frame, and the event log below turns what the session says into the
 * sentences the model reads. All three are the client's own code, unmodified.
 *
 * ## Two clocks, and the slow one is the model
 *
 * {@link tick} is the fast clock: it advances the session's prediction and hands
 * the walk controller the next leg. {@link apply} is the slow one, driven by a
 * decision that took as long as a provider took to answer. That split is the
 * point — a latency spike costs a bot its reaction time rather than freezing it
 * mid-stride, because the walk it is already on keeps being walked.
 */
export class BotBody {
  private readonly session: RemoteSession;
  private readonly input: HeldDirections;
  private readonly walkTo: WalkTo;
  private readonly tilesById: Record<string, TileDef>;
  private readonly events: string[] = [];
  /** Damage numbers already reported, so a floating one is not reported twice. */
  private readonly seenDamage = new Set<string>();
  /** The same for chat bubbles, which hang around for seconds after they land. */
  private readonly seenChats = new Set<string>();
  /** Ticked time since the world last said hello. See {@link isSettled}. */
  private sinceHelloMs = 0;
  /** Whether the last frame found this body dead, so a return can be noticed. */
  private wasDead = false;
  /** Ticked time since the last `rebirth`. Starts spent, so the first is free. */
  private sinceRebirthAskMs = REBIRTH_ASK_INTERVAL_MS;

  constructor(socket: BotSocket, tiles: TileDef[]) {
    this.tilesById = tilesByIdFromList(tiles);
    // The one cast in this feature. `RemoteSession` is written against the
    // browser's `WebSocket` because that is what a tab hands it; a bot hands it
    // Bun's, or the test harness's socket pair, and the four members it actually
    // touches — `send`, `readyState`, and the two listener calls — are the whole
    // of {@link BotSocket}. Narrowing the constructor instead would be a change
    // to shipped client code for the sake of a process that runs beside it.
    this.session = new RemoteSession(socket as unknown as WebSocket, tiles);
    this.input = new HeldDirections((held) => this.session.setInput(held));
    this.walkTo = new WalkTo(this.input);
  }

  isReady(): boolean {
    return this.session.isReady();
  }

  /**
   * Has the world finished arriving?
   *
   * **A bot must not act on the frame it joins, and this is why.** `hello` gives
   * a joiner the chunks its view can reach, and the ticks after it carry the
   * rest — see `app/net/interest`. While that is still going, a patch can
   * momentarily leave this body off the board, which makes the client throw away
   * the step it is holding a guess about (`RemoteSession`'s
   * `abandonPrediction`). The step is thrown away *locally*; the server has
   * already been told about it and walks it anyway. With a direction still
   * pressed the client then issues the same step a second time, and the body
   * ends up one cell past wherever it was going.
   *
   * A person never sees this: nobody clicks in the same millisecond the world
   * paints. A bot does exactly that, every time, so it waits — and a walk that
   * overshoots by one is otherwise a systematic error, not a rare one.
   *
   * Reset when a body comes back from the dead, because a rebirth is answered
   * with a whole fresh `hello` and the same stream follows it.
   */
  isSettled(): boolean {
    return this.session.isReady() && this.sinceHelloMs >= BOT_SETTLE_MS;
  }

  isDead(): boolean {
    return this.session.isDead();
  }

  /**
   * Ask for a body again. The only thing a dead session may say.
   *
   * Asked at most once a second, however often it is called. The decision loop
   * comes back around every frame while a bot is dead, and twenty identical
   * requests a second is a bot shouting at a server that has already heard it —
   * the reply is a whole `hello`, which takes as long as it takes.
   */
  rebirth() {
    if (this.sinceRebirthAskMs < REBIRTH_ASK_INTERVAL_MS) return;
    this.sinceRebirthAskMs = 0;
    this.session.rebirth();
  }

  dispose() {
    this.session.dispose();
  }

  /**
   * Advance one frame: the session's prediction, then the walk in progress.
   *
   * Everything the world said during that frame is drained into the event log
   * here rather than at decision time, because a notice is only offered once and
   * a decision can be a second away. The `walkTo` notices go in beside them: the
   * only sentence in the game composed on the client is "there is no way there",
   * and it is exactly the one a model that named an unreachable cell has to hear.
   */
  tick(dtMs: number) {
    this.session.update(dtMs);
    const snapshot = this.session.getSnapshot();
    this.walkTo.tick(this.walkView(snapshot));
    this.noteSettling(dtMs);
    this.events.push(...this.session.drainNotices());
    this.events.push(...this.walkTo.drainNotices());
    this.noteDamage(snapshot);
    this.noteChats(snapshot);
  }

  /**
   * Do what the model asked, and answer with what the world said about it.
   *
   * **Only the immediate half is knowable here**, and it is worth having.
   * `WalkTo.start` runs `findPath` synchronously, so a route that does not exist
   * is refused before this returns; a step is chosen by the same `canWalk` the
   * server validates it with, so a step that goes nowhere is known too. What is
   * not knowable is how any of it *ends* — arriving, falling, being answered —
   * and that reaches the model as an event on a later decision.
   *
   * **A refusal answers on its own.** "You set off for (40, 40). There is no way
   * there from here" says two contradictory things, and the second is the true
   * one — so when the world refused, the refusal is the whole answer. The event
   * log still gets both, in the order they happened, because that is the record
   * `./memory` carries forward and it should show what was asked as well as what
   * came of it.
   *
   * The confirmation is `describeCall`'s wording rather than one written here,
   * because `./memory` writes the same request down a second time and the two
   * must not read as two different acts.
   */
  apply(action: BotAction): string {
    const asked = describeCall(action);
    const refusals = this.perform(action);
    this.events.push(asked, ...refusals);
    return refusals.length > 0 ? refusals.join(" ") : asked;
  }

  /** Do it, and say whatever the world had to say about it straight away. */
  private perform(action: BotAction): string[] {
    if (action.tool === "say") {
      this.session.say(action.text);
      return [];
    }
    if (action.tool === "step") return this.performStep(action.direction);
    return this.performWalkTo(action.x, action.y);
  }

  /**
   * Press one direction once, and say whether the body moved.
   *
   * A press and an immediate release, which is a single step: the pipeline
   * chains a *held* direction into the next step by itself, and a direction left
   * pressed would be a body walking that way until the next decision. Going
   * through the same list a key goes through is what makes this the ordinary
   * step rather than a second kind of movement.
   *
   * Whether a step began is read off the prediction the press just made, which
   * is the client asking `canWalk` — the same question the server answers with.
   * Two different things leave the body standing: nothing to step onto that way,
   * and a step already under way, which `predictStep` declines to interrupt.
   * The sentence names neither, because from here they are the same fact and
   * inventing a cause for a body that did not move would be worse than not
   * having one.
   */
  private performStep(direction: Direction): string[] {
    this.walkTo.cancel();
    const walking = this.session.getSnapshot().self.walk !== null;
    this.input.press(direction);
    this.input.release(direction);
    const stepped = !walking && this.session.getSnapshot().self.walk !== null;
    return stepped ? [] : [STEP_REFUSED];
  }

  /**
   * Set off for a cell, and say so if there is no way to it.
   *
   * Drained straight after starting, so what comes back belongs to this call.
   * `tick` drains the same queue and does run during a decision — the frame
   * clock is an interval and the decision is awaited beside it — but it cannot
   * run *between* these two lines, which have nothing to await, so nothing else
   * can put a sentence in the queue or take this one out of it.
   */
  private performWalkTo(x: number, y: number): string[] {
    const snapshot = this.session.getSnapshot();
    const view = this.walkView(snapshot);
    const destination = groundAt(view, x, y);
    if (!destination) return [noRouteNotice("unreachable")];
    this.walkTo.startAt(destination, view);
    return this.walkTo.drainNotices();
  }

  /**
   * What the model is shown, and the events it has not been shown yet.
   *
   * Drains the log, so a sentence is read exactly once. Everything about what is
   * visible is decided by {@link buildBotView}, which is a pure function of what
   * is passed here — this method's only job is to hold the snapshot still while
   * both halves of it are built from it.
   */
  view(): BotView {
    const events = [...this.events];
    this.events.length = 0;
    return buildBotView({
      map: this.session.getMap(),
      tilesById: this.tilesById,
      snapshot: this.session.getSnapshot(),
      events,
    });
  }

  /**
   * What time it is in the world, for stamping a line in `./memory`.
   *
   * Computed from the wall clock rather than read off the session, and the
   * session is the surprise: `RemoteSession.minutesOfDay` is the reading the
   * last `hello` carried and it never moves again — a browser advances it
   * itself, from that anchor, once a frame. A bot asking it every decision would
   * stamp every line it ever writes with the same minute.
   *
   * `minutesOfDayAt` is the world's clock by definition: `GameServer` computes
   * the hour it sends in `hello` the same way, from the same wall clock, and the
   * runner is deployed in the same container as the world. So this agrees with
   * the server exactly, with nothing on the wire and no clock to tick.
   */
  minutesOfDay(): MinutesOfDay {
    return minutesOfDayAt(Date.now());
  }

  /** What to call this bot in a log line. The same handle everybody else sees. */
  name(): string {
    const self = this.session.getSnapshot().self;
    return bodyNameFor({ actorId: self.id, tileId: self.tileId }, this.tilesById);
  }

  /** Wind the settle clock, restarting it whenever a fresh world arrives. */
  private noteSettling(dtMs: number) {
    this.sinceRebirthAskMs += dtMs;
    const dead = this.session.isDead();
    if (this.wasDead && !dead) this.sinceHelloMs = 0;
    this.wasDead = dead;
    if (this.session.isReady()) this.sinceHelloMs += dtMs;
  }

  private walkView(snapshot: GameSnapshot): WalkView {
    const self = snapshot.self;
    return {
      map: snapshot.map,
      at: { x: self.x, y: self.y, z: self.z, stackIndex: self.stackIndex },
      // The cell a step already under way will land in. The controller owes the
      // *next* leg while this one is still being walked, so telling it only where
      // the body currently stands would make it re-decide the leg in flight.
      stepping: self.walk ? self.walk.to : null,
      def: this.tilesById[self.tileId] ?? MISSING_TILE,
      tilesById: this.tilesById,
    };
  }

  /**
   * Every blow that landed since this was last asked.
   *
   * **Who swung is not on the wire.** A `DamageNumber` carries who took it and
   * how much, which is what the number floating over a body needs and no more.
   * So the sentence says what is knowable — that this body took four, or that
   * the deer did — and the model works out the rest from who it is fighting and
   * who is standing next to it. Reporting an attacker would mean inventing one.
   */
  private noteDamage(snapshot: GameSnapshot) {
    for (const blow of snapshot.damage) {
      if (this.seenDamage.has(blow.id)) continue;
      this.seenDamage.add(blow.id);
      const mine = blow.targetId === snapshot.self.id;
      const who = mine
        ? "You"
        : bodyNameFor(
            {
              actorId: blow.targetId,
              tileId:
                snapshot.actors.find((a) => a.id === blow.targetId)?.tileId ?? "",
            },
            this.tilesById,
          );
      this.events.push(
        blow.outcome === "miss"
          ? `${who} ${mine ? "were" : "was"} missed.`
          : `${who} took ${blow.amount} damage.`,
      );
    }
    // A number lives a few seconds and then stops being in the snapshot, so the
    // set is trimmed to what is still floating. Without this it grows for the
    // life of the process, which for a bot that never logs out is the life of
    // the deployment.
    forget(this.seenDamage, snapshot.damage);
  }

  private noteChats(snapshot: GameSnapshot) {
    for (const chat of snapshot.chats) {
      if (this.seenChats.has(chat.id)) continue;
      this.seenChats.add(chat.id);
      if (chat.actorId === snapshot.self.id) continue;
      const name = bodyNameFor(
        { actorId: chat.actorId, tileId: chat.tileId },
        this.tilesById,
      );
      this.events.push(`${name} said: ${chat.text}`);
    }
    forget(this.seenChats, snapshot.chats);
  }
}

/** Drop remembered ids for things that have expired off the snapshot. */
function forget(seen: Set<string>, live: readonly { id: string }[]) {
  if (seen.size <= live.length) return;
  const alive = new Set(live.map((entry) => entry.id));
  for (const id of seen) if (!alive.has(id)) seen.delete(id);
}

/**
 * The cell a body would stand in, having gone to that coordinate.
 *
 * **A coordinate is not a pointer**, and reading it as one is what this
 * replaces. The click this shares its controller with resolves a *pick* — the
 * thing on top of a column — and refusing to walk onto a tree is the right
 * answer to somebody who clicked the tree. A model naming `(x, y)` has clicked
 * nothing: it read the coordinate off the ruler down the edge of a grid, and it
 * means the ground there. Resolved as a pick it meant whatever was highest in
 * that column, which around the spawn is the tree canopy a level above the
 * street — so every `walk_to` in that part of the map was refused before the
 * search was ever consulted, about ordinary grass the bot was standing next to.
 *
 * So the column is asked what a body may stand on, not what is on top of it.
 * Nearest to the walker's own feet wins, because a coordinate says where on the
 * plan and never which storey — and of the floors stacked at one `(x, y)`, the
 * one it means is the one it is already on. `fitsAtElevation` is what keeps a
 * surface with no headroom out of the answer, the same question the grid's `#`
 * asks. @see ../../app/game/walkTo startAt
 */
function groundAt(view: WalkView, x: number, y: number): Coord | null {
  const feet = standingAbs(
    view.map,
    view.at.x,
    view.at.y,
    view.at.z,
    view.at.stackIndex,
    view.tilesById,
  );
  let best: { abs: number; z: number } | null = null;
  for (const surface of listStandingSurfaces(view.map, x, y, view.tilesById)) {
    if (!fitsAtElevation(view.map, x, y, surface.abs, view.def, view.tilesById).ok) {
      continue;
    }
    if (best && Math.abs(surface.abs - feet) >= Math.abs(best.abs - feet)) continue;
    best = surface;
  }
  return best ? { x, y, z: best.z } : null;
}

/**
 * Stand-in for a walker whose own tile is not in the catalogue.
 *
 * Only reachable if the map holds a tile id the catalogue does not, which is a
 * bug somewhere else — but the fit checks a route runs need *some* body, and
 * crashing the runner is a worse answer than routing as something one unit tall.
 */
const MISSING_TILE = { height: 1 } as TileDef;

/**
 * How long after a `hello` a bot waits before its first decision.
 *
 * Fifteen of the world's own ticks — half a second — measured rather than
 * derived: it is how long the joiner's chunk stream takes to stop rearranging
 * the board under a body that has only just been put on it. See
 * {@link BotBody.isSettled} for what goes wrong without it. It costs one
 * decision's worth of standing still per join and nothing else.
 */
export const BOT_SETTLE_MS = TICK_MS * 15;

/** How often a dead bot may ask for a body back. See {@link BotBody.rebirth}. */
const REBIRTH_ASK_INTERVAL_MS = 1_000;

/**
 * What a step that did not happen is answered with.
 *
 * No cause, because two of them look identical from here — see {@link
 * BotBody.performStep} — and neither is a sentence the game says anywhere else.
 */
const STEP_REFUSED = "You did not move.";
