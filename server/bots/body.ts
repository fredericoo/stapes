import { TICK_MS } from "../../app/game/constants";
import { bodyNameFor } from "../../app/game/displayName";
import type { GameSnapshot } from "../../app/game/GameSession";
import { HeldDirections } from "../../app/game/heldDirections";
import { WalkTo, type WalkView } from "../../app/game/walkTo";
import { getStack } from "../../app/lib/mapData";
import { MIN_LEVEL, type Coord, type MapFile, type TileDef } from "../../app/lib/types";
import { tilesByIdFromList } from "../../app/lib/validation";
import { RemoteSession } from "../../app/net/RemoteSession";
import type { BotSocket } from "./transport";
import { buildBotView, type BotView } from "./view";
import type { BotAction } from "./tools";

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
   * Do what the model asked, and write down that it was asked.
   *
   * The outcome is not knowable here: with one round trip per decision nothing
   * comes back inline, and a refusal arrives as a notice on some later frame. So
   * what goes into the log is the request, and the refusal — if there is one —
   * lands beside it in the same list. Together they are the only way a model
   * learns whether anything it did worked.
   */
  apply(action: BotAction) {
    if (action.tool === "say") {
      this.session.say(action.text);
      this.events.push(`You said: ${action.text}`);
      return;
    }
    if (action.tool === "step") {
      // A press and an immediate release, which is a single step: the pipeline
      // chains a *held* direction into the next step by itself, and a direction
      // left pressed would be a body walking that way until the next decision.
      // Going through the same list a key goes through is what makes this the
      // ordinary step rather than a second kind of movement.
      this.walkTo.cancel();
      this.input.press(action.direction);
      this.input.release(action.direction);
      this.events.push(`You stepped ${action.direction}.`);
      return;
    }
    const snapshot = this.session.getSnapshot();
    const view = this.walkView(snapshot);
    const on = pickAt(view.map, snapshot.self.z, action.x, action.y);
    this.walkTo.start(on, view);
    this.events.push(`You set off for (${action.x}, ${action.y}).`);
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
 * The stack slot a coordinate names, as a pointer would have named it.
 *
 * `WalkTo.start` is written against a *pick* — the tile somebody pointed at —
 * because a click is what it was built for, and the cell a body ends up standing
 * in is a different one whenever the thing pointed at fills its level. A bot
 * names a column instead, so this is the pick it would have made: the topmost
 * placement of the topmost stack in that column, at or below the level the bot
 * is standing on.
 *
 * **Bodies are stepped over.** Nothing stands on top of a body, so naming one
 * would have `standingCellOn` find no surface and report the cell unreachable —
 * about a cell whose *ground* is perfectly reachable and merely occupied. Naming
 * the ground instead lets the route search answer the question that was actually
 * asked, and refuse it with a sentence about there being no way through.
 *
 * A column with nothing in it at all still gets a slot handed back, and it is
 * ignored: `standingCellOn` reads an empty column at the walker's own level as a
 * hole and answers with where a body entering it would come to rest. That is the
 * tutorial's first hole, and it is the one case where the pick is not the
 * question.
 */
function pickAt(
  map: MapFile,
  fromZ: number,
  x: number,
  y: number,
): Coord & { stackIndex: number } {
  // One level above the walker as well, because a body standing on a full-level
  // block is stored on the level below the one it appears to be on — the same
  // slack a pointer is given.
  for (let z = fromZ + 1; z >= MIN_LEVEL; z--) {
    const stack = getStack(map, x, y, z);
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]!.owner !== undefined) continue;
      return { x, y, z, stackIndex: i };
    }
  }
  return { x, y, z: fromZ, stackIndex: 0 };
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
