import type { ObjectRef } from "../app/game/affordances";
import { PLAYER_TILE_ID } from "../app/game/constants";
import type { ActorSnapshot, GameSnapshot } from "../app/game/GameSession";
import { cellGoal, NAVIGATION_MAX_NODES, planRoute } from "../app/game/navigation";
import type { StatusDef } from "../app/lib/status";
import type { Coord, TileDef } from "../app/lib/types";
import type { RemoteSession } from "../app/net/RemoteSession";
import { choosePrey, creaturesAround, healingFood, isThreat, reach, steps } from "./combat";
import { nextDressing } from "./dress";
import { between, DEFAULT_TEMPERAMENT, type Temperament } from "./temperament";
import { describeGoal, exploreErrand, nextErrand, type Errand, type Goal } from "./goals";
import { exploredKey, Knowledge } from "./knowledge";
import { Pilot } from "./Pilot";
import type { AskReason, Observation, Planner, Seen } from "./planner";

export const THINK_EVERY_MS = 30_000;

export const STUCK_AFTER_MS = 4_000;

export const PRESS_GIVE_UP_MS = 3_000;

export const REBIRTH_AFTER_MS = 3_000;

/**
 * A goal with no route stays a goal with no route until the bot sees more, so
 * it waits this long before searching again rather than searching every frame.
 */
export const FAILED_PAUSE_MS = 15_000;

/**
 * Exploring searches outward for any unexplored edge, which on a large known
 * map is the most expensive search a bot makes. An edge further than this is
 * left for later rather than paid for in one frame.
 */
export const EXPLORE_MAX_NODES = 8_000;

/** Edge cells tried in one search before an explore counts as failed. */
export const EXPLORE_ATTEMPTS = 4;

/** Routes pay `THREAT_PENALTY` a cell to keep this far from a threat. */
export const THREAT_BERTH_CELLS = 4;

export const THREAT_PENALTY = 6;

export const EAT_RETRY_MS = 3_000;

/** Backing away is to a cell this far off, as far from the danger as any. */
export const FLEE_NEAR_CELLS = 8;

export const FLEE_FAR_CELLS = 18;

export const FLEE_MS = 6_000;

/** A creature this close that hurt the bot is the one it turns on. */
export const RETALIATE_CELLS = 2;

/** Bare hands and the swords a bot picks up reach this far. */
export const STRIKE_REACH_CELLS = 1.5;

/** A chase replans when its quarry has moved, but no more often than this. */
export const CHASE_REPLAN_MS = 600;

export const PREY_FORGET_MS = 120_000;

/** Another player this close to prey has it, and the bot looks elsewhere. */
export const TAKEN_CELLS = 3;

/** Route budget for a chase or a flight, which only ever go a short way. */
export const SHORT_ROUTE_MAX_NODES = 4_000;

export const DRESS_RETRY_MS = 1_000;

const SEEN_LISTED = 8;

const HAPPENINGS_KEPT = 12;

export type BotBody = Pick<
  RemoteSession,
  | "getSnapshot"
  | "setInput"
  | "interact"
  | "setTarget"
  | "setAttackMode"
  | "say"
  | "isDead"
  | "rebirth"
  | "drainNotices"
  | "moveItem"
  | "consume"
>;

type Course =
  | { readonly kind: "idle" }
  | { readonly kind: "travel"; readonly errand: Errand; readonly pilot: Pilot }
  | { readonly kind: "press"; readonly ref: ObjectRef; readonly sinceMs: number }
  | { readonly kind: "rest"; readonly untilMs: number }
  | { readonly kind: "pause"; readonly untilMs: number };

/**
 * One bot: a socket's worth of player driven by goals. Goals come from a
 * `Planner`, slowly; everything between two decisions — routes, presses,
 * fighting back, getting up again — is decided here, every frame, without it.
 */
export class Bot {
  private goal: Goal | null = null;
  private course: Course = { kind: "idle" };
  private notes = "";
  private happenings: string[] = [];
  private skipped = new Set<string>();
  private explored = new Set<string>();
  private asking = false;
  private pendingAsk: { reason: AskReason; outcome: string | null } | null = {
    reason: "start",
    outcome: null,
  };
  private lastAskMs = 0;
  private lastMove: { at: string; sinceMs: number } = { at: "", sinceMs: 0 };
  private lastHp: number | null = null;
  private foe: { id: string; sinceMs: number } | null = null;
  private chase: { pilot: Pilot; toward: string; plannedMs: number } | null = null;
  private flight: { pilot: Pilot; untilMs: number } | null = null;
  private preySkipped = new Map<string, number>();
  private lastEatMs = -Infinity;
  private reactAtMs: number | null = null;
  private deadSinceMs: number | null = null;
  private lastDressMs = -Infinity;
  private nowMs = 0;

  constructor(
    private readonly body: BotBody,
    private readonly planner: Planner,
    private readonly tilesById: Record<string, TileDef>,
    private readonly statusDefs: Record<string, StatusDef>,
    private readonly log: (line: string) => void = () => {},
    private readonly random: () => number = Math.random,
    private readonly temperament: Temperament = DEFAULT_TEMPERAMENT,
  ) {}

  get currentGoal(): Goal | null {
    return this.goal;
  }

  act(nowMs: number) {
    this.nowMs = nowMs;
    if (this.body.isDead()) {
      this.whileDead(nowMs);
      return;
    }
    this.deadSinceMs = null;

    const snapshot = this.body.getSnapshot();
    for (const notice of this.body.drainNotices()) this.happen(notice);
    const self = snapshot.self;
    const hurt = this.lastHp !== null && self.hp !== null && self.hp < this.lastHp;
    this.lastHp = self.hp;
    this.dress(snapshot, nowMs);
    this.eat(snapshot, nowMs);
    this.maybeAsk(nowMs);
    if (this.evade(snapshot, nowMs)) return;
    if (this.fight(snapshot, nowMs, hurt)) return;
    this.pursue(snapshot, nowMs);
  }

  private whileDead(nowMs: number) {
    if (this.deadSinceMs === null) {
      this.deadSinceMs = nowMs;
      this.course = { kind: "idle" };
      this.foe = null;
      this.chase = null;
      this.flight = null;
      this.happen("you died and will come back where you last set your respawn");
      this.ask("died", null);
    }
    if (nowMs - this.deadSinceMs >= REBIRTH_AFTER_MS) this.body.rebirth();
  }

  private pursue(snapshot: GameSnapshot, nowMs: number) {
    const self = snapshot.self;
    if (!this.goal) return;

    if (this.goal.goal === "hunt" && this.course.kind !== "travel") {
      const prey = this.preyIn(snapshot, nowMs);
      if (prey) {
        if (this.hesitating(nowMs)) return;
        this.engage(prey.id, nowMs, `hunting ${nameOf(prey)}`);
        return;
      }
    }

    if (this.course.kind === "rest") {
      if (nowMs >= this.course.untilMs) this.finish("done", `rested`);
      return;
    }

    if (this.course.kind === "pause") {
      if (nowMs >= this.course.untilMs) this.course = { kind: "idle" };
      return;
    }

    if (this.course.kind === "press") {
      if (this.body.interact(this.course.ref)) {
        this.course = { kind: "idle" };
      } else if (nowMs - this.course.sinceMs > PRESS_GIVE_UP_MS) {
        this.skipped.add(refKey(this.course.ref));
        this.happen(`could not use the thing at ${this.course.ref.x},${this.course.ref.y}`);
        this.course = { kind: "idle" };
      }
      return;
    }

    if (this.course.kind === "idle") {
      if (this.hesitating(nowMs)) return;
      this.chart(snapshot, nowMs);
      return;
    }

    const travel = this.course;
    const state = travel.pilot.drive(this.body, self, snapshot.map, nowMs);
    if (state === "arrived") {
      if (travel.errand.explores) {
        this.explored.add(exploredKey(travel.errand.explores));
        const { loiterMinMs, loiterMaxMs } = this.temperament;
        const loiterMs = between(this.random, loiterMinMs, loiterMaxMs);
        this.course = { kind: "pause", untilMs: nowMs + loiterMs };
        return;
      }
      this.course = travel.errand.press
        ? { kind: "press", ref: travel.errand.press, sinceMs: nowMs }
        : { kind: "idle" };
      return;
    }
    if (state === "lost" || this.stuck(self, nowMs)) {
      if (travel.errand.explores) this.explored.add(exploredKey(travel.errand.explores));
      this.body.setInput({ directions: [] });
      this.course = { kind: "idle" };
    }
  }

  /** Works out the next errand of the goal and a route to it. */
  private chart(snapshot: GameSnapshot, nowMs: number) {
    const goal = this.goal!;
    const self = snapshot.self;
    if (goal.goal === "rest") {
      this.course = { kind: "rest", untilMs: nowMs + goal.seconds * 1000 };
      return;
    }

    const knowledge = new Knowledge(snapshot.map, snapshot.actors, this.tilesById, this.statusDefs);
    const holdings = { equipment: snapshot.equipment, tags: snapshot.tags };
    const world = knowledge.world(self.id, this.threatPenalty(snapshot));
    const at = { x: self.x, y: self.y, z: self.z };

    const recall = { skipped: this.skipped, explored: this.explored, random: this.random };
    for (let attempts = 0; attempts < EXPLORE_ATTEMPTS;) {
      const next = nextErrand(goal, knowledge, at, holdings, recall);
      if (next === "done") {
        this.finish("done", `finished: ${describeGoal(goal)}`);
        return;
      }
      if (next === "rest") return;

      let errand = next === "exhausted" ? null : next;
      let route = errand ? planRoute(world, at, errand.nav, budgetFor(errand)) : null;
      if (!route?.ok && (goal.goal === "reach_level" || goal.goal === "go_to")) {
        const toward = goal.goal === "go_to" ? { x: goal.x, y: goal.y } : null;
        errand = exploreErrand(knowledge, at, toward, recall);
        route = errand ? planRoute(world, at, errand.nav, budgetFor(errand)) : null;
      }
      if (errand && route?.ok) {
        this.lastMove = { at: cellOf(self), sinceMs: nowMs };
        this.course = { kind: "travel", errand, pilot: new Pilot(at, route.legs, this.tilesById) };
        return;
      }
      if (errand?.press) {
        this.skipped.add(refKey(errand.press));
        continue;
      }
      if (!errand?.explores) break;
      this.explored.add(exploredKey(errand.explores));
      attempts++;
    }
    if (goal.goal === "explore") this.explored.clear();
    this.finish("failed", `found no way to ${describeGoal(goal)} in what you have seen`);
  }

  private stuck(self: ActorSnapshot, nowMs: number): boolean {
    const at = self.walk ? cellOf(self.walk.to) : cellOf(self);
    if (at !== this.lastMove.at) {
      this.lastMove = { at, sinceMs: nowMs };
      return false;
    }
    return nowMs - this.lastMove.sinceMs > STUCK_AFTER_MS;
  }

  /**
   * Backs away from every threat within `waryCells`, and from the creature it
   * is fighting once its own health is low. Returns whether that took the
   * frame. A fight is dropped only once there is somewhere to back away to;
   * with nowhere, the bot stays and fights.
   */
  private evade(snapshot: GameSnapshot, nowMs: number): boolean {
    const self = snapshot.self;
    const creatures = creaturesAround(self, snapshot.actors, this.tilesById);
    const dangers = creatures.filter(
      (a) =>
        isThreat(self, a, this.tilesById, this.temperament.threatRatio) &&
        reach(self, a) <= this.temperament.waryCells,
    );
    const weak =
      self.hp !== null && !!self.maxHp && self.hp / self.maxHp < this.temperament.fleeHpShare;
    const foe = this.foe && creatures.find((a) => a.id === this.foe!.id);
    if (weak && foe) dangers.push(foe);
    if (dangers.length === 0) {
      if (this.flight) {
        this.flight = null;
        this.course = { kind: "idle" };
      }
      return false;
    }

    if (this.flight && nowMs < this.flight.untilMs) {
      const state = this.flight.pilot.drive(this.body, self, snapshot.map, nowMs);
      if (state !== "underway") this.flight = null;
      return true;
    }

    const knowledge = new Knowledge(snapshot.map, snapshot.actors, this.tilesById, this.statusDefs);
    const world = knowledge.world(self.id, this.threatPenalty(snapshot));
    const at = { x: self.x, y: self.y, z: self.z };
    const away = (cell: Coord) => Math.min(...dangers.map((d) => steps(cell, d)));
    const refuges = knowledge
      .standingCellsAround(at, FLEE_NEAR_CELLS, FLEE_FAR_CELLS)
      .sort((a, b) => away(b) - away(a))
      .slice(0, EXPLORE_ATTEMPTS);
    for (const refuge of refuges) {
      const route = planRoute(world, at, cellGoal(refuge, "on"), SHORT_ROUTE_MAX_NODES);
      if (!route.ok) continue;
      if (!this.flight) this.happen(`backing away from ${dangers.map(nameOf).join(", ")}`);
      if (this.foe) this.disengage();
      this.flight = { pilot: new Pilot(at, route.legs, this.tilesById), untilMs: nowMs + FLEE_MS };
      this.course = { kind: "idle" };
      return true;
    }
    return false;
  }

  /**
   * Fights the current foe: strikes it from within reach, and walks after it
   * when it is further. Being hurt with no foe turns the bot on the nearest
   * creature, which is how a bot answers a creature that attacked first.
   */
  private fight(snapshot: GameSnapshot, nowMs: number, hurt: boolean): boolean {
    const self = snapshot.self;
    const creatures = creaturesAround(self, snapshot.actors, this.tilesById);
    if (!this.foe && hurt) {
      const attacker = creatures
        .filter((a) => reach(self, a) <= RETALIATE_CELLS)
        .sort((a, b) => reach(self, a) - reach(self, b))[0];
      if (attacker)
        this.engage(attacker.id, nowMs, `${nameOf(attacker)} attacked you; fighting back`);
    }
    if (!this.foe) return false;

    const foe = creatures.find((a) => a.id === this.foe!.id);
    if (!foe) {
      const gone = snapshot.actors.find((a) => a.id === this.foe!.id);
      this.happen(gone ? `killed ${nameOf(gone)}` : "the creature you fought is gone");
      this.disengage();
      return false;
    }

    if (reach(self, foe) <= STRIKE_REACH_CELLS) {
      this.chase = null;
      this.body.setInput({ directions: [] });
      return true;
    }

    if (nowMs - this.foe.sinceMs > this.temperament.chaseGiveUpMs) {
      this.preySkipped.set(foe.id, nowMs + PREY_FORGET_MS);
      this.happen(`gave up chasing ${nameOf(foe)}`);
      this.disengage();
      return false;
    }

    const toward = cellOf(foe);
    const stale = this.chase && this.chase.toward !== toward;
    if (!this.chase || (stale && nowMs - this.chase.plannedMs > CHASE_REPLAN_MS)) {
      const knowledge = new Knowledge(
        snapshot.map,
        snapshot.actors,
        this.tilesById,
        this.statusDefs,
      );
      const world = knowledge.world(self.id, this.threatPenalty(snapshot));
      const at = { x: self.x, y: self.y, z: self.z };
      const route = planRoute(world, at, cellGoal(foe, "beside"), SHORT_ROUTE_MAX_NODES);
      if (!route.ok) {
        this.preySkipped.set(foe.id, nowMs + PREY_FORGET_MS);
        this.happen(`found no way to reach ${nameOf(foe)}`);
        this.disengage();
        return false;
      }
      this.chase = {
        pilot: new Pilot(at, route.legs, this.tilesById),
        toward,
        plannedMs: nowMs,
      };
    }
    const state = this.chase.pilot.drive(this.body, self, snapshot.map, nowMs);
    if (state !== "underway") this.chase = null;
    return true;
  }

  private engage(id: string, nowMs: number, why: string) {
    this.happen(why);
    this.foe = { id, sinceMs: nowMs };
    this.chase = null;
    this.course = { kind: "idle" };
    this.body.setTarget(id);
    this.body.setAttackMode(true);
  }

  private disengage() {
    this.foe = null;
    this.chase = null;
    this.body.setAttackMode(false);
    this.body.setTarget(null);
    this.body.setInput({ directions: [] });
  }

  private preyIn(snapshot: GameSnapshot, nowMs: number): ActorSnapshot | null {
    const self = snapshot.self;
    const { threatRatio, waryCells, huntSightCells, preyChoices } = this.temperament;
    const threats = creaturesAround(self, snapshot.actors, this.tilesById).filter((a) =>
      isThreat(self, a, this.tilesById, threatRatio),
    );
    const others = snapshot.actors.filter((a) => a.tileId === PLAYER_TILE_ID && a.id !== self.id);
    const near = snapshot.actors.filter(
      (a) => steps(self, a) <= huntSightCells && threats.every((t) => steps(a, t) > waryCells),
    );
    return choosePrey(self, near, this.tilesById, {
      threatRatio,
      choices: preyChoices,
      random: this.random,
      skipped: (id) => (this.preySkipped.get(id) ?? 0) > nowMs,
      taken: (prey) => others.some((p) => steps(p, prey) <= TAKEN_CELLS),
    });
  }

  /**
   * A bot takes a moment before acting on a new decision, drawn afresh each
   * time, so bots that see the same thing in the same frame do not all move
   * in it. Returns whether the bot is still making up its mind.
   */
  private hesitating(nowMs: number): boolean {
    if (this.reactAtMs === null) {
      const { reactionMinMs, reactionMaxMs } = this.temperament;
      this.reactAtMs = nowMs + between(this.random, reactionMinMs, reactionMaxMs);
    }
    if (nowMs < this.reactAtMs) return true;
    this.reactAtMs = null;
    return false;
  }

  private threatPenalty(snapshot: GameSnapshot): ((cell: Coord) => number) | undefined {
    const self = snapshot.self;
    const threats = creaturesAround(self, snapshot.actors, this.tilesById).filter((a) =>
      isThreat(self, a, this.tilesById, this.temperament.threatRatio),
    );
    if (threats.length === 0) return undefined;
    return (cell) =>
      threats.some((t) => t.z === cell.z && steps(cell, t) <= THREAT_BERTH_CELLS)
        ? THREAT_PENALTY
        : 0;
  }

  private eat(snapshot: GameSnapshot, nowMs: number) {
    const self = snapshot.self;
    if (self.hp === null || !self.maxHp) return;
    if (self.hp / self.maxHp >= this.temperament.eatHpShare) return;
    if (nowMs - this.lastEatMs < EAT_RETRY_MS) return;
    const index = healingFood(snapshot.equipment, this.tilesById, this.statusDefs);
    if (index === null) return;
    const tileId = snapshot.equipment.bag?.contents?.[index]?.tileId ?? "";
    if (!this.body.consume({ kind: "slot", slot: { kind: "contents", index } })) return;
    this.lastEatMs = nowMs;
    this.happen(`ate ${this.tilesById[tileId]?.name ?? tileId}`);
  }

  /**
   * The server answers a move with the new equipment a tick later, so the
   * same move is not sent again until it has had time to arrive.
   */
  private dress(snapshot: GameSnapshot, nowMs: number) {
    if (nowMs - this.lastDressMs < DRESS_RETRY_MS) return;
    const dressing = nextDressing(snapshot.equipment, this.tilesById);
    if (!dressing || !this.body.moveItem(dressing.from, dressing.to)) return;
    this.lastDressMs = nowMs;
    const bag = snapshot.equipment.bag?.contents ?? [];
    const index = dressing.from.kind === "contents" ? dressing.from.index : -1;
    const tileId = bag[index]?.tileId ?? "";
    this.happen(`put on ${this.tilesById[tileId]?.name ?? tileId} (${dressing.to.kind})`);
  }

  private finish(reason: "done" | "failed", outcome: string) {
    this.log(outcome);
    this.course =
      reason === "failed"
        ? { kind: "pause", untilMs: this.nowMs + FAILED_PAUSE_MS }
        : { kind: "idle" };
    this.goal = reason === "done" ? null : this.goal;
    this.ask(reason, outcome);
  }

  private ask(reason: AskReason, outcome: string | null) {
    this.pendingAsk = { reason, outcome };
  }

  private maybeAsk(nowMs: number) {
    if (this.asking) return;
    if (!this.pendingAsk && nowMs - this.lastAskMs >= THINK_EVERY_MS) {
      this.pendingAsk = { reason: "timer", outcome: null };
    }
    const ask = this.pendingAsk;
    if (!ask) return;
    this.pendingAsk = null;
    this.asking = true;
    this.lastAskMs = nowMs;
    const observation = this.observe(ask.reason, ask.outcome);
    this.happenings = [];
    this.planner
      .decide(observation)
      .then((decision) => {
        if (!decision) return;
        if (decision.notes !== undefined) this.notes = decision.notes;
        if (decision.say) this.body.say(decision.say);
        const changed = JSON.stringify(decision.goal) !== JSON.stringify(this.goal);
        if (!changed) return;
        this.log(`goal: ${describeGoal(decision.goal)}`);
        this.goal = decision.goal;
        this.skipped.clear();
        this.course = { kind: "idle" };
        this.body.setInput({ directions: [] });
      })
      .catch((error: unknown) => this.log(`planner failed: ${String(error)}`))
      .finally(() => {
        this.asking = false;
      });
  }

  private observe(reason: AskReason, outcome: string | null): Observation {
    const snapshot = this.body.getSnapshot();
    const self = snapshot.self;
    const knowledge = new Knowledge(snapshot.map, snapshot.actors, this.tilesById, this.statusDefs);
    const near = <T extends Seen>(items: T[]) =>
      items.sort((a, b) => distance(self, a) - distance(self, b)).slice(0, SEEN_LISTED);
    const bag = snapshot.equipment.bag?.contents ?? [];
    const worn = Object.values(snapshot.equipment).filter((item) => item !== null);
    return {
      reason,
      goal: this.goal,
      outcome,
      self: { x: self.x, y: self.y, z: self.z, hp: self.hp, maxHp: self.maxHp },
      carrying: [...worn, ...bag].map((item) => this.tilesById[item.tileId]?.name ?? item.tileId),
      tags: snapshot.tags,
      signs: near(knowledge.signs().map(({ at, text }) => ({ ...at, text }))),
      rewards: near(
        knowledge.rewardsOnOffer(snapshot.tags).map(({ ref, name }) => ({ ...ref, text: name })),
      ),
      ways: near(
        knowledge.ways().map(({ at, to, name }) => ({ ...at, text: `${name} (to level ${to.z})` })),
      ),
      creatures: near(
        snapshot.actors
          .filter((a) => a.id !== self.id)
          .map((a) => ({ x: a.x, y: a.y, z: a.z, text: nameOf(a) })),
      ),
      happenings: [...this.happenings],
      notes: this.notes,
    };
  }

  private happen(line: string) {
    this.log(line);
    this.happenings.push(line);
    if (this.happenings.length > HAPPENINGS_KEPT) this.happenings.shift();
  }
}

function budgetFor(errand: Errand): number {
  return errand.explores ? EXPLORE_MAX_NODES : NAVIGATION_MAX_NODES;
}

function refKey(ref: ObjectRef): string {
  return `${ref.x},${ref.y},${ref.z},${ref.stackIndex}`;
}

function cellOf(at: Coord): string {
  return `${at.x},${at.y},${at.z}`;
}

function distance(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) * 4;
}

function nameOf(actor: ActorSnapshot): string {
  return actor.name ?? actor.tileId;
}
