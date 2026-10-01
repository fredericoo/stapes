import { coveredBySomething, type ObjectRef } from "../app/game/affordances";
import { PLAYER_TILE_ID } from "../app/game/constants";
import type { Equipment } from "../app/game/equipment";
import { resolveWalkDurationMs } from "../app/game/movement";
import { hasLineOfSight } from "../app/game/sight";
import type { ActorSnapshot, GameSnapshot } from "../app/game/GameSession";
import {
  cellGoal,
  NAVIGATION_MAX_NODES,
  planRoute,
  type NavGoal,
  type NavLeg,
  type NavWorld,
} from "../app/game/navigation";
import type { BattlerDef } from "../app/lib/battler";
import { resolveDialog } from "../app/lib/dialog";
import { isRanged, resolveItem, resolveWeapon, type Reach } from "../app/lib/item";
import { getStack } from "../app/lib/mapData";
import type { StatusDef } from "../app/lib/status";
import type { Coord, TileDef } from "../app/lib/types";
import type { RemoteSession } from "../app/net/RemoteSession";
import { MAX_CHAT_LENGTH } from "../app/net/chat";
import {
  canHurt,
  choosePrey,
  creaturesAround,
  healingFood,
  isThreat,
  reach,
  steps,
} from "./combat";
import { nextDressing } from "./dress";
import { Economy, type Deal } from "./economy";
import { bodyOf, rangedReach } from "./gear";
import { between, DEFAULT_TEMPERAMENT, type Temperament } from "./temperament";
import {
  describeGoal,
  exploreErrand,
  landmarkKey,
  nextErrand,
  refKey,
  type Act,
  type Errand,
  type Goal,
  type Market,
  whereIs,
} from "./goals";
import { exploredKey, Knowledge } from "./knowledge";
import { Landmarks, SAME_PLACE_CELLS } from "./memory";
import { Pilot } from "./Pilot";
import { nextTalk } from "./shops";
import {
  NOTHING_TO_DO,
  type AskReason,
  type Decision,
  type Planner,
  type Situation,
} from "./planner";
import { Recollection } from "./recollection";

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

/**
 * A dressing the server keeps refusing is sent this many times before the
 * thing is left alone for `DRESS_REFUSED_MS`.
 */
export const DRESS_ATTEMPTS = 3;

export const DRESS_REFUSED_MS = 60_000;

/** A loose thing this close, in sight, and worth having is walked to and picked up. */
export const LOOT_CELLS = 8;

/** Looking for loose things reads every cell around the bot, so it is done this often. */
export const LOOT_SCAN_MS = 1_000;

export const LOOT_GIVE_UP_MS = 8_000;

/** A thing the bot could not pick up, most often for want of room, is left this long. */
export const LOOT_FORGET_MS = 5 * 60_000;

/** A conversation the server has not answered in this long is given up. */
export const TALK_GIVE_UP_MS = 5_000;

/** A choice the conversation has not moved past is pressed again after this long. */
export const TALK_RETRY_MS = 1_200;

/**
 * Kiting routes keep off the cells beside the foe, which the board has no
 * body on, by charging this much for each.
 */
export const BESIDE_FOE_PENALTY = 25;

/**
 * Bots hear each other, so two of them answering everything could talk
 * forever. A bot says at most `SAY_LIMIT` things in any `SAY_WINDOW_MS`.
 */
export const SAY_LIMIT = 4;

export const SAY_WINDOW_MS = 60_000;

export type BotBody = Pick<
  RemoteSession,
  | "getSnapshot"
  | "setInput"
  | "interact"
  | "setTarget"
  | "setAttackMode"
  | "isDead"
  | "rebirth"
  | "drainNotices"
  | "moveItem"
  | "consume"
  | "selfSnapshot"
  | "getMap"
  | "talk"
  | "pickUp"
  | "drop"
  | "say"
>;

export type BotOptions = {
  readonly log?: (line: string) => void;
  readonly random?: () => number;
  readonly temperament?: Temperament;
  /** The fleet's memory; a bot given none remembers only for itself, until it stops. */
  readonly landmarks?: Landmarks;
};

type Course =
  | { readonly kind: "idle" }
  | {
      readonly kind: "travel";
      readonly errand: Errand;
      readonly pilot: Pilot;
      /** Legs left when this stretch ends and the bot stops to decide again. */
      readonly stopAtRemaining: number;
      readonly wandering: boolean;
    }
  | { readonly kind: "press"; readonly ref: ObjectRef; readonly sinceMs: number }
  | {
      readonly kind: "talk";
      readonly deal: Deal;
      readonly at: Coord;
      readonly sinceMs: number;
      readonly opened: boolean;
      /** The counter last answered, and when, so a choice is not sent every decision. */
      readonly answered: { readonly pc: string; readonly atMs: number } | null;
      /** The transcript's length when the trade was sent; a longer one is the reply. */
      readonly tradeSent: { readonly lines: number; readonly atMs: number } | null;
    }
  | {
      readonly kind: "gather";
      readonly ref: ObjectRef;
      readonly sinceMs: number;
      readonly pulling: boolean;
    }
  | { readonly kind: "rest"; readonly untilMs: number }
  | { readonly kind: "pause"; readonly untilMs: number };

type Looting = {
  readonly ref: ObjectRef;
  readonly tileId: string;
  readonly pilot: Pilot | null;
  readonly sinceMs: number;
};

/**
 * One bot: a socket's worth of player driven by goals. Goals come from a
 * `Planner`, slowly; everything between two decisions — routes, presses,
 * fighting back, getting up again — is decided here, every frame, without it.
 */
export class Bot {
  private goal: Goal | null = null;
  private course: Course = { kind: "idle" };
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
  private foe: { id: string; sinceMs: number; provoked: boolean } | null = null;
  private chase: { pilot: Pilot; toward: string; plannedMs: number } | null = null;
  private flight: { pilot: Pilot; untilMs: number } | null = null;
  private preySkipped = new Map<string, number>();
  private lastEatMs = -Infinity;
  private reactAtMs: number | null = null;
  private deadSinceMs: number | null = null;
  private lastDressMs = -Infinity;
  private lastDressing: { key: string; times: number } | null = null;
  private dressRefused = new Map<string, number>();
  private looting: Looting | null = null;
  private lootSkipped = new Map<string, number>();
  private lastLootScanMs = -Infinity;
  private pulls = 0;
  private nowMs = 0;
  private readonly log: (line: string) => void;
  private readonly random: () => number;
  private readonly temperament: Temperament;
  private readonly economy: Economy;
  private readonly landmarks: Landmarks;
  private peaceful = false;
  private readonly memory = new Recollection();
  private heard = new Set<string>();
  private saidAtMs: number[] = [];

  constructor(
    private readonly body: BotBody,
    private readonly planner: Planner,
    private readonly tilesById: Record<string, TileDef>,
    private readonly statusDefs: Record<string, StatusDef>,
    options: BotOptions = {},
  ) {
    this.log = options.log ?? (() => {});
    this.random = options.random ?? Math.random;
    this.temperament = options.temperament ?? DEFAULT_TEMPERAMENT;
    this.landmarks = options.landmarks ?? new Landmarks(":memory:");
    this.economy = new Economy(tilesById, statusDefs, this.temperament.style);
  }

  get currentGoal(): Goal | null {
    return this.goal;
  }

  /**
   * Keeps whichever route the bot is on held correctly, every frame. A held
   * direction keeps stepping until it is changed, so steering only when the
   * bot decides let a step shorter than the gap between decisions, as on a
   * road, carry it a cell past its route.
   */
  steer(nowMs: number) {
    const pilot =
      this.flight?.pilot ??
      this.chase?.pilot ??
      this.looting?.pilot ??
      (this.course.kind === "travel" ? this.course.pilot : null);
    if (!pilot || this.body.isDead()) return;
    const self = this.body.selfSnapshot();
    if (self) pilot.drive(this.body, self, this.body.getMap(), nowMs);
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
    this.hear(snapshot);
    const self = snapshot.self;
    const hurt = this.lastHp !== null && self.hp !== null && self.hp < this.lastHp;
    this.lastHp = self.hp;
    this.remember(snapshot);
    this.dress(snapshot, nowMs);
    this.eat(snapshot, nowMs);
    this.maybeAsk(snapshot, nowMs);
    if (this.evade(snapshot, nowMs)) return;
    if (this.fight(snapshot, nowMs, hurt)) return;
    if (this.loot(snapshot, nowMs)) return;
    this.pursue(snapshot, nowMs);
  }

  private whileDead(nowMs: number) {
    if (this.deadSinceMs === null) {
      this.deadSinceMs = nowMs;
      this.course = { kind: "idle" };
      this.foe = null;
      this.chase = null;
      this.flight = null;
      this.looting = null;
      this.happen("you died and will come back where you last set your respawn");
      this.ask("died", null);
    }
    if (nowMs - this.deadSinceMs >= REBIRTH_AFTER_MS) this.body.rebirth();
  }

  /**
   * Remembers what other players said since the last frame. A bubble lasts
   * `CHAT_LIFETIME_MS`, far longer than a frame, so one seen before is skipped
   * by its id. The bot's own lines come back from the server too, and
   * creatures' speech is not a player talking.
   */
  private hear(snapshot: GameSnapshot) {
    const self = snapshot.self;
    const fresh = snapshot.chats.filter(
      (chat) =>
        !this.heard.has(chat.id) && chat.actorId !== self.id && chat.tileId === PLAYER_TILE_ID,
    );
    this.heard = new Set(snapshot.chats.map((chat) => chat.id));
    for (const chat of fresh) {
      this.happen(
        `${chat.name ?? "someone"} (at ${chat.x},${chat.y},${chat.z}) said: "${chat.text}"`,
        true,
      );
    }
    if (fresh.length > 0) this.ask("heard", null);
  }

  private pursue(snapshot: GameSnapshot, nowMs: number) {
    const self = snapshot.self;
    if (!this.goal) return;

    if (snapshot.extracting) {
      this.body.setInput({ directions: [] });
      if (this.course.kind === "gather" && !this.course.pulling) {
        this.course = { ...this.course, pulling: true };
      }
      return;
    }

    if (this.course.kind === "talk") {
      this.converse(snapshot, this.course, nowMs);
      return;
    }

    if (this.course.kind === "gather") {
      this.work(this.course, nowMs);
      return;
    }

    if (this.course.kind !== "press" && !this.peaceful) {
      const prey = this.preyIn(snapshot, nowMs);
      if (prey) {
        if (this.hesitating(nowMs)) return;
        this.body.setInput({ directions: [] });
        this.engage(prey.id, nowMs, false, `hunting ${nameOf(prey)}`);
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
      if (travel.wandering) {
        const { glanceMinMs, glanceMaxMs } = this.temperament;
        this.course = {
          kind: "pause",
          untilMs: nowMs + between(this.random, glanceMinMs, glanceMaxMs),
        };
        return;
      }
      if (travel.errand.explores) {
        this.explored.add(exploredKey(travel.errand.explores));
        const { loiterMinMs, loiterMaxMs } = this.temperament;
        const loiterMs = between(this.random, loiterMinMs, loiterMaxMs);
        this.course = { kind: "pause", untilMs: nowMs + loiterMs };
        return;
      }
      this.arrive(snapshot, travel.errand.act, nowMs);
      return;
    }
    if (state === "lost" || this.stuck(self, nowMs)) {
      if (travel.errand.explores) this.explored.add(exploredKey(travel.errand.explores));
      this.body.setInput({ directions: [] });
      this.course = { kind: "idle" };
      return;
    }
    if (!self.walk && !self.fall && travel.pilot.remaining <= travel.stopAtRemaining) {
      this.body.setInput({ directions: [] });
      this.course = { kind: "idle" };
    }
  }

  /**
   * Sometimes, before a new errand, the bot first wanders a few cells to one
   * side and looks about. Returns whether it set off.
   */
  private wander(knowledge: Knowledge, world: NavWorld, at: Coord, nowMs: number): boolean {
    const { wanderChance, wanderNearCells, wanderFarCells } = this.temperament;
    if (this.random() >= wanderChance) return false;
    const spots = knowledge.standingCellsAround(at, wanderNearCells, wanderFarCells);
    if (spots.length === 0) return false;
    const spot = spots[Math.floor(this.random() * spots.length)]!;
    const route = planRoute(world, at, cellGoal(spot, "on"), SHORT_ROUTE_MAX_NODES);
    if (!route.ok || route.legs.some((leg) => leg.kind === "walk" && leg.drop)) return false;
    this.travel(
      { nav: cellGoal(spot, "on"), act: null, explores: null },
      at,
      route.legs,
      nowMs,
      true,
    );
    return true;
  }

  private travel(errand: Errand, at: Coord, legs: NavLeg[], nowMs: number, wandering: boolean) {
    const { stretchMinLegs, stretchMaxLegs } = this.temperament;
    const stretch = Math.round(between(this.random, stretchMinLegs, stretchMaxLegs));
    this.lastMove = { at: cellOf(at), sinceMs: nowMs };
    this.course = {
      kind: "travel",
      errand,
      pilot: new Pilot(at, legs, this.tilesById),
      stopAtRemaining: Math.max(0, legs.length - stretch),
      wandering,
    };
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
    const holdings = {
      equipment: snapshot.equipment,
      tags: snapshot.tags,
      body: bodyOf(this.tilesById, snapshot.masteryXp),
    };
    const world = knowledge.world(self.id, this.threatPenalty(snapshot));
    const at = { x: self.x, y: self.y, z: self.z };

    const recall = {
      skipped: this.skipped,
      explored: this.explored,
      random: this.random,
      pulls: this.pulls,
    };
    const market = this.market(snapshot);
    for (let attempts = 0; attempts < EXPLORE_ATTEMPTS;) {
      const next = nextErrand(goal, knowledge, at, holdings, recall, market);
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
        if (this.wander(knowledge, world, at, nowMs)) return;
        this.travel(errand, at, route.legs, nowMs, false);
        return;
      }
      if (errand?.act) {
        this.skipped.add(skipKey(errand.act));
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
        isThreat(self, a, this.tilesById, this.temperament) &&
        reach(self, a) <= this.temperament.waryCells,
    );
    const weak =
      self.hp !== null && !!self.maxHp && self.hp / self.maxHp < this.temperament.fleeHpShare;
    const foe = this.foe && creatures.find((a) => a.id === this.foe!.id);
    if (weak && foe && canHurt(this.tilesById[foe.tileId])) dangers.push(foe);
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
        this.engage(attacker.id, nowMs, true, `${nameOf(attacker)} attacked you; fighting back`);
    }
    if (!this.foe) return false;

    const foe = creatures.find((a) => a.id === this.foe!.id);
    if (!foe) {
      const gone = snapshot.actors.find((a) => a.id === this.foe!.id);
      this.happen(gone ? `killed ${nameOf(gone)}` : "the creature you fought is gone");
      this.disengage();
      return false;
    }

    const body = bodyOf(this.tilesById, snapshot.masteryXp);
    const ranged = body && rangedReach(snapshot.equipment, this.tilesById, body.masteries);
    if (ranged) return this.kite(snapshot, foe, ranged, nowMs);

    if (reach(self, foe) <= STRIKE_REACH_CELLS) {
      this.chase = null;
      this.foe = { ...this.foe, sinceMs: nowMs };
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

  /**
   * Fights with a ranged weapon: stands and shoots while the foe is in reach
   * and in sight, and further than `kiteCells`; otherwise walks to a cell
   * that is, which backs away from a foe that closes and comes forward to
   * one out of reach. A bow cannot shoot inside its `Reach.min`, so a foe
   * that got that close is answered by stepping back when the bot is the
   * faster walker, and otherwise by the sidearm in its other hand: backing
   * away from a wolf only gives it free bites.
   */
  private kite(snapshot: GameSnapshot, foe: ActorSnapshot, weapon: Reach, nowMs: number): boolean {
    const self = snapshot.self;
    const farthest = Math.max(1, weapon.cells - 0.5);
    const nearest = Math.min(farthest, Math.max(weapon.min ?? 0, this.temperament.kiteCells));
    const distance = reach(self, foe);
    const dangerous = canHurt(this.tilesById[foe.tileId]);
    const inSight = distance <= weapon.cells && sees(snapshot, this.tilesById, foe);
    const shoots = inSight && distance >= (weapon.min ?? 0) && (distance >= nearest || !dangerous);
    const parries =
      distance <= STRIKE_REACH_CELLS &&
      holdsSidearm(snapshot.equipment, this.tilesById) &&
      !this.outpaces(foe);
    if (shoots || parries) {
      this.chase = null;
      this.foe = { id: foe.id, sinceMs: nowMs, provoked: this.foe?.provoked ?? false };
      this.body.setInput({ directions: [] });
      return true;
    }

    if (nowMs - this.foe!.sinceMs > this.temperament.chaseGiveUpMs) {
      this.preySkipped.set(foe.id, nowMs + PREY_FORGET_MS);
      this.happen(`gave up on ${nameOf(foe)}`);
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
      const threat = this.threatPenalty(snapshot);
      const world = knowledge.world(self.id, (cell) => {
        const beside = cell.z === foe.z && steps(cell, foe) <= 1 ? BESIDE_FOE_PENALTY : 0;
        return beside + (threat?.(cell) ?? 0);
      });
      const at = { x: self.x, y: self.y, z: self.z };
      const goals =
        distance < nearest
          ? retreats(knowledge, at, foe, (nearest + farthest) / 2, farthest).map((cell) =>
              cellGoal(cell, "on"),
            )
          : [];
      goals.push(shootingGoal(knowledge, foe, nearest, farthest));
      let route = planRoute(world, at, goals[0]!, SHORT_ROUTE_MAX_NODES);
      for (let i = 1; !route.ok && i < goals.length; i++) {
        route = planRoute(world, at, goals[i]!, SHORT_ROUTE_MAX_NODES);
      }
      if (!route.ok) {
        if (inSight) {
          this.body.setInput({ directions: [] });
          return true;
        }
        this.preySkipped.set(foe.id, nowMs + PREY_FORGET_MS);
        this.happen(`found nowhere to shoot ${nameOf(foe)} from`);
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

  /** Whether the bot walks faster than `foe`, so stepping back from it gains ground. */
  private outpaces(foe: ActorSnapshot): boolean {
    const foeDef = this.tilesById[foe.tileId];
    const selfDef = this.tilesById[PLAYER_TILE_ID];
    if (!foeDef || !selfDef) return false;
    return resolveWalkDurationMs(foeDef) > resolveWalkDurationMs(selfDef);
  }

  private engage(id: string, nowMs: number, provoked: boolean, why: string) {
    this.happen(why);
    this.foe = { id, sinceMs: nowMs, provoked };
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
    const { waryCells, huntSightCells, preyChoices } = this.temperament;
    const threats = creaturesAround(self, snapshot.actors, this.tilesById).filter((a) =>
      isThreat(self, a, this.tilesById, this.temperament),
    );
    const others = snapshot.actors.filter((a) => a.tileId === PLAYER_TILE_ID && a.id !== self.id);
    const near = snapshot.actors.filter(
      (a) =>
        a.z === self.z &&
        steps(self, a) <= huntSightCells &&
        threats.every((t) => steps(a, t) > waryCells) &&
        hasLineOfSight(snapshot.map, this.tilesById, self, a),
    );
    return choosePrey(self, near, this.tilesById, {
      threat: this.temperament,
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
      isThreat(self, a, this.tilesById, this.temperament),
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
   * same move is not sent again until it has had time to arrive. One it keeps
   * refusing is left alone for a while.
   */
  private dress(snapshot: GameSnapshot, nowMs: number) {
    if (nowMs - this.lastDressMs < DRESS_RETRY_MS) return;
    const body = bodyOf(this.tilesById, snapshot.masteryXp);
    if (!body) return;
    const { equipment } = snapshot;
    const saving = new Set(this.economy.savingFor(equipment, body)?.take.map((s) => s.tileId));
    const currency = this.economy.currency;
    const dressing = nextDressing(equipment, this.tilesById, {
      body,
      style: this.temperament.style,
      keeps: (tileId) => tileId === currency || saving.has(tileId) || this.economy.bought(tileId),
      spends: (tileId) => tileId === currency,
      refused: (tileId) => (this.dressRefused.get(tileId) ?? 0) > nowMs,
    });
    if (!dressing) return;

    const key = `${dressing.kind}:${dressing.tileId}`;
    const times = this.lastDressing?.key === key ? this.lastDressing.times + 1 : 1;
    this.lastDressing = { key, times };
    const self = snapshot.self;
    const sent =
      times <= DRESS_ATTEMPTS &&
      (dressing.kind === "move"
        ? this.body.moveItem(dressing.from, dressing.to)
        : this.body.drop(dressing.from, { x: self.x, y: self.y, z: self.z }));
    if (!sent) {
      this.dressRefused.set(dressing.tileId, nowMs + DRESS_REFUSED_MS);
      this.lastDressing = null;
      return;
    }
    this.lastDressMs = nowMs;
    const name = this.tilesById[dressing.tileId]?.name ?? dressing.tileId;
    this.happen(
      dressing.kind === "drop" ? `dropped ${name}` : `moved ${name} to ${dressing.to.kind}`,
    );
  }

  /** Every NPC in view is remembered where it stands, for the whole fleet. */
  private remember(snapshot: GameSnapshot) {
    for (const actor of snapshot.actors) {
      const def = this.tilesById[actor.tileId];
      if (def && resolveDialog(def)) this.landmarks.saw(actor.tileId, actor);
    }
  }

  private market(snapshot: GameSnapshot): Market {
    return { economy: this.economy, landmarks: this.landmarks, bodies: snapshot.actors };
  }

  /** What the bot does at the end of a walk, by what the walk was for. */
  private arrive(snapshot: GameSnapshot, act: Act | null, nowMs: number) {
    switch (act?.kind) {
      case undefined:
        this.course = { kind: "idle" };
        return;
      case "press":
        this.course = { kind: "press", ref: act.ref, sinceMs: nowMs };
        return;
      case "gather":
        this.course = { kind: "gather", ref: act.ref, sinceMs: nowMs, pulling: false };
        return;
      case "talk":
        this.course = {
          kind: "talk",
          deal: act.deal,
          at: act.at,
          sinceMs: nowMs,
          opened: false,
          answered: null,
          tradeSent: null,
        };
        return;
      case "visit": {
        this.skipped.add(landmarkKey(act.tileId, act.at));
        const knowledge = new Knowledge(
          snapshot.map,
          snapshot.actors,
          this.tilesById,
          this.statusDefs,
        );
        const there = knowledge
          .resources((tileId) => tileId !== "")
          .some(
            ({ ref, tileId }) => tileId === act.tileId && steps(ref, act.at) <= SAME_PLACE_CELLS,
          );
        if (!there) this.landmarks.missing(act.tileId, act.at);
        this.course = { kind: "idle" };
        return;
      }
    }
  }

  /**
   * Talks an NPC through to one trade. The NPC is found again by what it is
   * and where it stands, never by id; if it is not where the fleet remembered
   * it, that memory is dropped, and if it has wandered off in view, the bot
   * walks after it.
   */
  private converse(
    snapshot: GameSnapshot,
    course: Extract<Course, { kind: "talk" }>,
    nowMs: number,
  ) {
    const { deal } = course;
    const npcTile = deal.offer.npc;
    const dialog = this.tilesById[npcTile] && resolveDialog(this.tilesById[npcTile]);
    const conversation = snapshot.conversation;
    if (!dialog) {
      this.course = { kind: "idle" };
      return;
    }

    if (!course.opened) {
      this.body.setInput({ directions: [] });
      const self = snapshot.self;
      const npc = snapshot.actors
        .filter((a) => a.tileId === npcTile && a.z === self.z)
        .sort((a, b) => steps(self, a) - steps(self, b))[0];
      if (!npc) {
        this.happen(`no ${deal.offer.npcName} where one was seen`);
        this.landmarks.missing(npcTile, course.at);
        this.skipped.add(landmarkKey(npcTile, course.at));
        this.course = { kind: "idle" };
        return;
      }
      const ref = { x: npc.x, y: npc.y, z: npc.z, stackIndex: npc.stackIndex };
      if (this.body.talk({ kind: "open", ref })) {
        this.course = { ...course, opened: true, sinceMs: nowMs };
      } else if (nowMs - course.sinceMs > PRESS_GIVE_UP_MS) {
        this.course = { kind: "idle" };
      }
      return;
    }

    if (!conversation || conversation.tileId !== npcTile) {
      if (nowMs - course.sinceMs > TALK_GIVE_UP_MS) {
        this.happen(`${deal.offer.npcName} did not answer`);
        this.course = { kind: "idle" };
      }
      return;
    }

    if (course.tradeSent) {
      const reply = conversation.transcript[course.tradeSent.lines];
      if (!reply && nowMs - course.tradeSent.atMs < TALK_GIVE_UP_MS) return;
      this.body.talk({ kind: "close" });
      const traded = reply?.who === "note" && reply.text.startsWith("Traded");
      const what = deal.offer.give.map((side) => this.tilesById[side.tileId]?.name).join(", ");
      if (traded) {
        this.happen(`traded with ${deal.offer.npcName} for ${what} x${deal.amount}`);
        this.course = { kind: "idle" };
      } else {
        this.finish("failed", `${deal.offer.npcName} would not trade ${what}`);
      }
      return;
    }

    const pc = conversation.pc.join(".");
    if (course.answered?.pc === pc && nowMs - course.answered.atMs < TALK_RETRY_MS) return;
    const action = nextTalk(dialog, conversation, deal.offer.path, deal.amount);
    if (action.kind === "close") {
      this.body.talk(action);
      this.finish("failed", `could not find the trade in what ${deal.offer.npcName} says`);
      return;
    }
    if (!this.body.talk(action)) return;
    this.course =
      action.kind === "trade"
        ? { ...course, tradeSent: { lines: conversation.transcript.length, atMs: nowMs } }
        : { ...course, answered: { pc, atMs: nowMs } };
  }

  /**
   * Works a resource: presses it until a pull starts, stands still while it
   * runs (`pursue` holds the bot while `extracting` is set), and counts it
   * once it ends.
   */
  private work(course: Extract<Course, { kind: "gather" }>, nowMs: number) {
    if (course.pulling) {
      this.pulls++;
      this.course = { kind: "idle" };
      return;
    }
    if (this.body.interact(course.ref)) {
      this.course = { ...course, sinceMs: nowMs };
      return;
    }
    if (nowMs - course.sinceMs > PRESS_GIVE_UP_MS) {
      this.skipped.add(refKey(course.ref));
      this.course = { kind: "idle" };
    }
  }

  /**
   * Picks up loose things worth having that lie in sight nearby, before the
   * goal: what a kill drops is at the bot's feet, and a bot that walked on
   * past it would never buy anything. Returns whether that took the frame.
   */
  private loot(snapshot: GameSnapshot, nowMs: number): boolean {
    if (this.course.kind === "talk" || this.course.kind === "gather") return false;
    if (this.course.kind === "press") return false;
    const self = snapshot.self;

    if (this.looting) {
      const { ref, tileId, sinceMs } = this.looting;
      const placed = getStack(snapshot.map, ref.x, ref.y, ref.z)[ref.stackIndex];
      if (placed?.tileId !== tileId) {
        this.looting = null;
        return false;
      }
      if (this.body.pickUp(ref)) {
        this.happen(`picked up ${this.tilesById[tileId]?.name ?? tileId}`);
        this.looting = null;
        this.pendingAsk ??= { reason: "timer", outcome: null };
        return true;
      }
      if (nowMs - sinceMs > LOOT_GIVE_UP_MS) {
        this.lootSkipped.set(lootKey(ref, tileId), nowMs + LOOT_FORGET_MS);
        this.looting = null;
        this.body.setInput({ directions: [] });
        return false;
      }
      const state = this.looting.pilot?.drive(this.body, self, snapshot.map, nowMs);
      if (state === "lost") this.looting = { ...this.looting, pilot: null };
      return true;
    }

    if (nowMs - this.lastLootScanMs < LOOT_SCAN_MS) return false;
    this.lastLootScanMs = nowMs;
    const body = bodyOf(this.tilesById, snapshot.masteryXp);
    if (!body) return false;
    const found = this.lootIn(snapshot, body, nowMs);
    if (!found) return false;

    const at = { x: self.x, y: self.y, z: self.z };
    let pilot: Pilot | null = null;
    if (steps(at, found.ref) > 1) {
      const knowledge = new Knowledge(
        snapshot.map,
        snapshot.actors,
        this.tilesById,
        this.statusDefs,
      );
      const world = knowledge.world(self.id, this.threatPenalty(snapshot));
      const route = planRoute(world, at, cellGoal(found.ref, "beside"), SHORT_ROUTE_MAX_NODES);
      if (!route.ok) {
        this.lootSkipped.set(lootKey(found.ref, found.tileId), nowMs + LOOT_FORGET_MS);
        return false;
      }
      pilot = new Pilot(at, route.legs, this.tilesById);
    }
    this.course = { kind: "idle" };
    this.looting = { ...found, pilot, sinceMs: nowMs };
    return true;
  }

  /** The nearest loose thing in sight within `LOOT_CELLS` that is worth picking up. */
  private lootIn(
    snapshot: GameSnapshot,
    body: BattlerDef,
    nowMs: number,
  ): { ref: ObjectRef; tileId: string } | null {
    const self = snapshot.self;
    const wanted = this.economy.wanted(snapshot.equipment, body);
    let best: { ref: ObjectRef; tileId: string } | null = null;
    let bestSteps = Infinity;
    for (let dy = -LOOT_CELLS; dy <= LOOT_CELLS; dy++) {
      for (let dx = -LOOT_CELLS; dx <= LOOT_CELLS; dx++) {
        const away = Math.abs(dx) + Math.abs(dy);
        if (away > LOOT_CELLS || away >= bestSteps) continue;
        const cell = { x: self.x + dx, y: self.y + dy, z: self.z };
        const stack = getStack(snapshot.map, cell.x, cell.y, cell.z);
        for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex--) {
          const placed = stack[stackIndex]!;
          if (placed.owner || !wanted(placed.tileId)) continue;
          const def = this.tilesById[placed.tileId];
          if (!def || !resolveItem(def)) continue;
          if (coveredBySomething(stack, stackIndex, this.tilesById)) continue;
          const ref = { ...cell, stackIndex };
          if ((this.lootSkipped.get(lootKey(ref, placed.tileId)) ?? 0) > nowMs) continue;
          if (!sees(snapshot, this.tilesById, cell)) continue;
          best = { ref, tileId: placed.tileId };
          bestSteps = away;
          break;
        }
      }
    }
    return best;
  }

  /** What the planner is told: whether there is anything to buy, sell or gather. */
  private situation(snapshot: GameSnapshot): Situation {
    const body = bodyOf(this.tilesById, snapshot.masteryXp);
    if (!body) return NOTHING_TO_DO;
    const { equipment } = snapshot;
    const wanted = this.economy.wanted(equipment, body);
    const knowledge = new Knowledge(snapshot.map, snapshot.actors, this.tilesById, this.statusDefs);
    const seen = knowledge.resources(wanted);
    for (const { ref, tileId } of seen) this.landmarks.saw(tileId, ref);
    const self = snapshot.self;
    const remembered = knowledge
      .resourceTileIds(wanted)
      .some((tileId) => this.landmarks.where(tileId, self).length > 0);
    const market = this.market(snapshot);
    const known = (deal: Deal) => whereIs(deal.offer.npc, self, market, this.skipped) !== null;
    return {
      canBuy: this.economy.purchases(equipment, body).some(known),
      canSell: this.economy.sales(equipment, body).some(known),
      canGather: seen.length > 0 || remembered,
    };
  }

  private finish(reason: "done" | "failed", outcome: string) {
    this.happen(outcome);
    this.course =
      reason === "failed"
        ? { kind: "pause", untilMs: this.nowMs + FAILED_PAUSE_MS }
        : { kind: "idle" };
    this.goal = reason === "done" ? null : this.goal;
    this.ask(reason, outcome);
  }

  /** A line heard is in the memory the next ask reads, so it never displaces another reason. */
  private ask(reason: AskReason, outcome: string | null) {
    if (reason === "heard" && this.pendingAsk) return;
    this.pendingAsk = { reason, outcome };
  }

  private maybeAsk(snapshot: GameSnapshot, nowMs: number) {
    if (this.asking) return;
    if (!this.pendingAsk && nowMs - this.lastAskMs >= THINK_EVERY_MS) {
      this.pendingAsk = { reason: "timer", outcome: null };
    }
    const ask = this.pendingAsk;
    if (!ask) return;
    this.pendingAsk = null;
    this.asking = true;
    this.lastAskMs = nowMs;
    this.planner
      .decide(this.observe(ask.reason, ask.outcome, snapshot))
      .then((decision) => {
        if (decision) this.follow(decision);
      })
      .catch((error: unknown) => this.log(`planner failed: ${String(error)}`))
      .finally(() => {
        this.asking = false;
      });
  }

  private observe(reason: AskReason, outcome: string | null, snapshot: GameSnapshot) {
    const { self, actors } = snapshot;
    const players = actors
      .filter((a) => a.tileId === PLAYER_TILE_ID && a.id !== self.id)
      .map((a) => ({ name: nameOf(a), x: a.x, y: a.y, z: a.z }));
    return {
      reason,
      goal: this.goal,
      outcome,
      nowMs: this.nowMs,
      situation: this.situation(snapshot),
      self: { name: nameOf(self), x: self.x, y: self.y, z: self.z, hp: self.hp, maxHp: self.maxHp },
      players,
      peaceful: this.peaceful,
      recent: this.memory.recent(),
    };
  }

  private follow(decision: Decision) {
    if (decision.say) this.say(decision.say);
    if (decision.peaceful !== undefined && decision.peaceful !== this.peaceful) {
      this.peaceful = decision.peaceful;
      this.happen(decision.peaceful ? "you stopped hunting" : "you started hunting again");
      if (decision.peaceful && this.foe && !this.foe.provoked) this.disengage();
    }
    if (!decision.goal || JSON.stringify(decision.goal) === JSON.stringify(this.goal)) return;
    this.happen(`your goal is now: ${describeGoal(decision.goal)}`);
    this.goal = decision.goal;
    this.pulls = 0;
    this.skipped.clear();
    this.course = { kind: "idle" };
    this.body.setInput({ directions: [] });
  }

  /**
   * A leading slash would make the line a command, and commands can rewrite
   * the map, so whatever a player talks a bot into typing is only ever said.
   */
  private say(text: string) {
    const line = text.replace(/^\/+/, "").trim().slice(0, MAX_CHAT_LENGTH);
    if (!line) return;
    this.saidAtMs = this.saidAtMs.filter((atMs) => this.nowMs - atMs < SAY_WINDOW_MS);
    if (this.saidAtMs.length >= SAY_LIMIT) return;
    this.saidAtMs.push(this.nowMs);
    this.body.say(line);
    this.happen(`you said: "${line}"`);
  }

  private happen(line: string, heard = false) {
    this.log(line);
    this.memory.add(this.nowMs, line, heard);
  }
}

function budgetFor(errand: Errand): number {
  return errand.explores ? EXPLORE_MAX_NODES : NAVIGATION_MAX_NODES;
}

function skipKey(act: Act): string {
  switch (act.kind) {
    case "press":
    case "gather":
      return refKey(act.ref);
    case "talk":
      return landmarkKey(act.deal.offer.npc, act.at);
    case "visit":
      return landmarkKey(act.tileId, act.at);
  }
}

function sees(snapshot: GameSnapshot, tilesById: Record<string, TileDef>, to: Coord): boolean {
  return hasLineOfSight(snapshot.map, tilesById, snapshot.self, to);
}

function cellOf(at: Coord): string {
  return `${at.x},${at.y},${at.z}`;
}

/** Whether either hand holds a weapon that strikes up close. */
function holdsSidearm(equipment: Equipment, tilesById: Record<string, TileDef>): boolean {
  return (["weapon", "offhand"] as const).some((hand) => {
    const held = equipment[hand];
    const weapon = held && tilesById[held.tileId] && resolveWeapon(tilesById[held.tileId]!);
    return !!weapon && !isRanged(weapon);
  });
}

function lootKey(ref: ObjectRef, tileId: string): string {
  return `${refKey(ref)}:${tileId}`;
}

/** How far a kiting bot looks for somewhere to back away to. */
export const RETREAT_CELLS = 5;

/** Retreat spots tried, best first, before settling for any spot in the band. */
export const RETREAT_CHOICES = 3;

/**
 * Open ground counts this much a standing neighbour when choosing where to
 * back away to. Without it a bot backs straight away from its foe until a
 * wall or the edge of the map stops it, and is caught there; with it, it
 * turns along the wall towards open ground instead.
 */
export const OPENNESS_WEIGHT = 0.25;

/**
 * Where to back away to from `foe`: cells within `RETREAT_CELLS` of the bot
 * from which the foe is between `from` and `to` cells away and in sight,
 * best first by distance from the foe, open ground around them, and
 * nearness to the bot.
 */
function retreats(knowledge: Knowledge, at: Coord, foe: Coord, from: number, to: number): Coord[] {
  const ground = knowledge.standingWithin(at, RETREAT_CELLS + 2);
  const standing = new Set(ground.map(cellOf));
  const openness = (cell: Coord) => {
    let count = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (standing.has(cellOf({ x: cell.x + dx, y: cell.y + dy, z: cell.z }))) count++;
      }
    }
    return count;
  };
  return ground
    .filter((cell) => {
      const away = Math.hypot(cell.x - foe.x, cell.y - foe.y);
      if (away < from || away > to || steps(cell, at) > RETREAT_CELLS) return false;
      return hasLineOfSight(knowledge.board, knowledge.tilesById, cell, foe);
    })
    .map((cell) => ({
      cell,
      score:
        Math.hypot(cell.x - foe.x, cell.y - foe.y) +
        OPENNESS_WEIGHT * openness(cell) -
        steps(cell, at) / 2,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, RETREAT_CHOICES)
    .map(({ cell }) => cell);
}

/**
 * Cells on the foe's level between `nearest` and `farthest` from it with a
 * clear line to it: where a bot with a ranged weapon wants to stand.
 */
function shootingGoal(
  knowledge: Knowledge,
  foe: Coord,
  nearest: number,
  farthest: number,
): NavGoal {
  return {
    reached: (cell) => {
      if (cell.z !== foe.z) return false;
      const away = Math.hypot(cell.x - foe.x, cell.y - foe.y);
      if (away < nearest || away > farthest) return false;
      return hasLineOfSight(knowledge.board, knowledge.tilesById, cell, foe);
    },
    estimate: (cell) => {
      const away = Math.abs(cell.x - foe.x) + Math.abs(cell.y - foe.y);
      return away > farthest ? Math.ceil(away - farthest) : 0;
    },
  };
}

function nameOf(actor: ActorSnapshot): string {
  return actor.name ?? actor.tileId;
}
