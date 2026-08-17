import { describe, expect, it } from "vitest";
import tilesJson from "../../data/tiles.json";
import {
  type BattlerDef,
  type FightingStats,
  fightingStats,
  resolveBattler,
} from "../lib/battler";
import { resolveWeapon, type WeaponItem } from "../lib/item";
import { experienceMultiplier, type Mastery, rating } from "../lib/mastery";
import { normalizeTiles } from "../lib/types";
import { attackIntervalMs, rollAttack } from "./combat";
import { TICK_MS } from "./constants";
import { Rng } from "./rng";

/**
 * Fights, simulated, against the creatures actually on disk.
 *
 * Every other test here asserts one rule in isolation — what `q` does to damage,
 * what a miss is worth. None of them can tell you the thing that actually
 * matters: **whether the numbers add up to a game.** A curve can be individually
 * correct at every point and still produce a rat that kills you, or a sword that
 * is never worth drawing.
 *
 * So this runs whole duels, many times, and asserts the *orderings* the design
 * promises. Orderings rather than figures on purpose: "a mastered sword beats an
 * unmastered one" survives retuning, where "the player wins 87% of the time"
 * would have to be edited every time anybody touched a constant, and an
 * assertion that is always being edited is an assertion nobody trusts.
 *
 * It reads `data/tiles.json` rather than fixtures, so re-authoring a creature
 * into an unwinnable fight fails here rather than in somebody's play session.
 */

const tiles = normalizeTiles(tilesJson as unknown[]);
const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));

function bodyOf(id: string): BattlerDef {
  const battler = resolveBattler(byId[id]!);
  if (!battler) throw new Error(`${id} is not a battler`);
  return battler;
}

function weaponOf(id: string): WeaponItem {
  const weapon = resolveWeapon(byId[id]!);
  if (!weapon) throw new Error(`${id} is not a weapon`);
  return weapon;
}

/** The player as authored, with one mastery moved to see what it buys. */
function playerAt(mastery: Mastery, level: number): BattlerDef {
  const player = bodyOf("player");
  return { ...player, masteries: { ...player.masteries, [mastery]: level } };
}

type DuelResult = {
  /** Which side was left standing, or null if neither ran out of time first. */
  winner: "a" | "b" | null;
  ticks: number;
  /** What the winner had left, as a fraction of their maximum. */
  survivorHealth: number;
};

/**
 * How long a body has to wait for its first swing.
 *
 * Both sides start ready, so the faster one lands first — which is what makes
 * speed worth having beyond the long-run rate.
 */
const READY = 0;

/**
 * Run one fight to the end.
 *
 * Time-stepped rather than turn-based, because the real session is: cooldowns
 * come off `attackIntervalMs` and are spent against the same tick the world
 * runs on, so a creature that swings twice as often really does get twice the
 * blows. A turn-based approximation would quietly erase speed.
 *
 * Both sides draw from one dice stream, exactly as they do in a session.
 */
function duel(
  a: FightingStats,
  b: FightingStats,
  rng: Rng,
  maxTicks = 20_000,
): DuelResult {
  let aHp = a.maxHp;
  let bHp = b.maxHp;
  let aCooldown = READY;
  let bCooldown = READY;

  for (let tick = 1; tick <= maxTicks; tick++) {
    aCooldown -= TICK_MS;
    bCooldown -= TICK_MS;

    if (aCooldown <= 0) {
      aCooldown = attackIntervalMs(a.spd);
      bHp -= rollAttack(a, b, rng).damage;
      if (bHp <= 0) {
        return { winner: "a", ticks: tick, survivorHealth: aHp / a.maxHp };
      }
    }

    if (bCooldown <= 0) {
      bCooldown = attackIntervalMs(b.spd);
      aHp -= rollAttack(b, a, rng).damage;
      if (aHp <= 0) {
        return { winner: "b", ticks: tick, survivorHealth: bHp / b.maxHp };
      }
    }
  }

  return { winner: null, ticks: maxTicks, survivorHealth: 0 };
}

/** How often the first side wins, over enough fights for the answer to settle. */
function winRate(a: FightingStats, b: FightingStats, fights = 200): number {
  let wins = 0;
  for (let seed = 0; seed < fights; seed++) {
    if (duel(a, b, new Rng(seed)).winner === "a") wins++;
  }
  return wins / fights;
}

/**
 * Damage per second against a defenceless target, which is the cleanest measure
 * of what a weapon is worth: it folds landing, the damage band and the swing
 * rate into one number without a defender's luck in it.
 */
function damagePerSecond(attacker: FightingStats, fights = 400): number {
  const dummy: FightingStats = {
    ...attacker,
    maxHp: Number.MAX_SAFE_INTEGER,
    def: 0,
    flee: 0,
  };

  const seconds = 20;
  const ticks = Math.round((seconds * 1000) / TICK_MS);
  let total = 0;

  for (let seed = 0; seed < fights; seed++) {
    const rng = new Rng(seed);
    let cooldown = READY;
    for (let tick = 0; tick < ticks; tick++) {
      cooldown -= TICK_MS;
      if (cooldown > 0) continue;
      cooldown = attackIntervalMs(attacker.spd);
      total += rollAttack(attacker, dummy, rng).damage;
    }
  }

  return total / fights / seconds;
}

const fists = (body: BattlerDef) => fightingStats(body, body.naturalWeapon);
const armed = (body: BattlerDef, weaponId: string) =>
  fightingStats(body, weaponOf(weaponId));

describe("learning a weapon", () => {
  const SWORD = "rusty-sword";
  const required = weaponOf(SWORD).requirements?.blade ?? 0;

  it("asks something of the wielder at all", () => {
    // The rest of this file is meaningless if the starter sword is free.
    expect(required).toBeGreaterThan(0);
  });

  /**
   * The progression, as a curve rather than as two points. Every step of Blade
   * is worth something until the requirement is met — a plateau in the middle
   * would mean levels the player earns and cannot feel.
   */
  it("pays for every point of mastery up to the requirement", () => {
    const curve = [];
    for (let blade = 0; blade <= required; blade++) {
      curve.push(damagePerSecond(armed(playerAt("blade", blade), SWORD)));
    }

    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThan(curve[i - 1]!);
    }
  });

  /**
   * The lesson the whole mastery system exists to teach, in one comparison: a
   * weapon you have not learnt is **worse than your own hands**. Not merely less
   * good than it could be — actually worse than not drawing it.
   */
  it("leaves an unlearnt sword worse than bare fists", () => {
    const novice = playerAt("blade", 0);
    expect(damagePerSecond(armed(novice, SWORD))).toBeLessThan(
      damagePerSecond(fists(novice)),
    );
  });

  it("makes the same sword clearly better once its requirement is met", () => {
    const trained = playerAt("blade", required);
    expect(damagePerSecond(armed(trained, SWORD))).toBeGreaterThan(
      damagePerSecond(fists(trained)),
    );
  });

  /**
   * Past the requirement the weapon keeps improving, but far less — the ratio is
   * capped at 1.25, and the point of the cap is that the next weapon is where
   * the growth is, not this one.
   */
  it("gives diminishing returns past the requirement", () => {
    const met = damagePerSecond(armed(playerAt("blade", required), SWORD));
    const double = damagePerSecond(armed(playerAt("blade", required * 2), SWORD));
    const tenfold = damagePerSecond(armed(playerAt("blade", required * 10), SWORD));

    expect(double).toBeGreaterThan(met);
    expect(tenfold).toBe(double);
  });
});

describe("the authored ladder", () => {
  const player = bodyOf("player");

  /**
   * The rungs, in the order the world puts them in. A fresh player should beat a
   * rat comfortably, struggle against a cat, and lose to a snake — if any of
   * these inverts, the map has creatures in the wrong places.
   */
  it("runs from a rat the player beats to a snake that beats them", () => {
    const me = fists(player);
    const versusRat = winRate(me, fists(bodyOf("rat")));
    const versusCat = winRate(me, fists(bodyOf("cat")));
    const versusSnake = winRate(me, fists(bodyOf("snake")));

    expect(versusRat).toBeGreaterThan(versusCat);
    expect(versusCat).toBeGreaterThan(versusSnake);
  });

  it("gives a fresh player the rat and denies them the snake", () => {
    expect(winRate(fists(player), fists(bodyOf("rat")))).toBeGreaterThan(0.7);
    expect(winRate(fists(player), fists(bodyOf("snake")))).toBeLessThan(0.4);
  });

  /**
   * A deer runs away and has nothing to hit you with, so it must never be able
   * to win a fight it is cornered into — that is what makes it prey rather than
   * a weak enemy.
   */
  it("leaves the deer unable to win however long it is cornered", () => {
    expect(winRate(fists(bodyOf("deer")), fists(player))).toBe(0);
  });

  /** Learning the sword is what turns the snake from a death into a fight. */
  it("turns the snake winnable once the sword is learnt", () => {
    const trained = playerAt("blade", weaponOf("rusty-sword").requirements?.blade ?? 0);
    const snake = fists(bodyOf("snake"));

    expect(winRate(armed(trained, "rusty-sword"), snake)).toBeGreaterThan(
      winRate(fists(bodyOf("player")), snake),
    );
  });

  /** Nothing on the ladder should be a stalemate neither side can end. */
  it("always reaches a conclusion", () => {
    for (const id of ["rat", "cat", "snake"]) {
      const result = duel(fists(player), fists(bodyOf(id)), new Rng(1));
      expect(result.winner).not.toBeNull();
    }
  });
});

/**
 * What each rung is worth, which is the other half of a ladder.
 *
 * A world can have creatures at every difficulty and still be a dead end: if
 * nothing on it pays at the ⭐ a player is standing on, they have no way up. The
 * rungs are asserted above; this is about the gaps between them.
 */
describe("the ladder pays for climbing it", () => {
  const ratingOf = (id: string) => rating(bodyOf(id).masteries);
  const CREATURES = ["rat", "deer", "cat", "snake", "wolf"];

  /**
   * The hole this closed. A deer deals no damage and cannot be cornered into
   * winning, so if it ever rates above something that fights back, hunting deer
   * is the safest and best-paid thing in the world and everybody does it.
   *
   * The fix was to re-author the deer rather than to special-case it: its ⭐ was
   * carried almost entirely by an Agility authored for how hard it is to *hit*,
   * back when nothing read a creature's masteries except its own stat block.
   */
  it("never rates the harmless deer above anything that can hurt you", () => {
    for (const id of CREATURES) {
      if (id === "deer") continue;
      expect(ratingOf("deer")).toBeLessThan(ratingOf(id));
    }
  });

  /** And so a rat, which bites back, is worth more than a deer, which does not. */
  it("pays a fresh player more for a rat than for a deer", () => {
    const me = ratingOf("player");
    expect(experienceMultiplier(ratingOf("rat"), me)).toBeGreaterThan(
      experienceMultiplier(ratingOf("deer"), me),
    );
  });

  /**
   * **No rung a player passes through is unpaid.** Swept one ⭐ at a time from
   * where a fresh player starts to the top of what the world has, because the
   * gaps are what a table of five creatures cannot show you: every rung is fine
   * on its own and the hole is between two of them.
   *
   * Half rate is the bar. Below that a fight is worth having only for what it
   * drops, and the design has nothing to drop yet.
   */
  it("leaves nothing to fight at no ⭐ between the bottom and the top", () => {
    const top = Math.max(...CREATURES.map(ratingOf));
    for (let stars = ratingOf("player"); stars <= top; stars++) {
      const best = Math.max(
        ...CREATURES.map((id) => experienceMultiplier(ratingOf(id), stars)),
      );
      expect(best).toBeGreaterThan(0.5);
    }
  });

  /**
   * And the top of the ladder is the top: past the best thing in the world there
   * is nothing left to earn from, which is a content problem rather than a bug
   * and is worth having stated somewhere that fails when it stops being true.
   */
  it("runs out above the best thing in the world", () => {
    const top = Math.max(...CREATURES.map(ratingOf));
    const best = Math.max(
      ...CREATURES.map((id) => experienceMultiplier(ratingOf(id), top * 2)),
    );
    expect(best).toBeLessThan(0.5);
  });
});

/**
 * The wolf: the rung above the snake, and the case natural weapons exist for.
 */
describe("the wolf", () => {
  const wolf = bodyOf("wolf");

  /**
   * **Fast *and* heavy**, which is the pair one Fist number could not have said.
   * Derive damage and speed from a single mastery and the harder-hitting animal
   * is the slower one by construction — so a wolf would have been unauthorable,
   * and the animal in that slot would have had to be a bigger snake.
   */
  it("swings faster than the snake and hits harder than the rat", () => {
    expect(fists(wolf).spd).toBeGreaterThan(fists(bodyOf("snake")).spd);
    expect(fists(wolf).damage).toBeGreaterThan(fists(bodyOf("rat")).damage);
  });

  /** It stands above everything else, which is what makes it the next rung. */
  it("rates above every other creature in the world", () => {
    for (const id of ["rat", "deer", "cat", "snake"]) {
      expect(rating(wolf.masteries)).toBeGreaterThan(rating(bodyOf(id).masteries));
    }
  });

  /**
   * What makes it a rung rather than a bigger snake: **it closes.** The snake
   * coils and waits, and walking away from a wolf is the first thing on the
   * ladder that does not work.
   */
  it("is the fastest thing on the map on its feet", () => {
    const walkMs = (id: string) => byId[id]!.walkDurationMs ?? Infinity;
    for (const id of ["rat", "deer", "cat", "snake"]) {
      expect(walkMs("wolf")).toBeLessThan(walkMs(id));
    }
  });

  /** A wall for a fresh player, and a fight for somebody who has earned one. */
  it("is out of reach until the sword is learnt and then merely hard", () => {
    const fresh = winRate(fists(bodyOf("player")), fists(wolf));
    const veteran = playerAt("blade", 22);
    const armedRate = winRate(armed(veteran, "rusty-sword"), fists(wolf));

    expect(fresh).toBeLessThan(0.1);
    expect(armedRate).toBeGreaterThan(fresh);
    expect(armedRate).toBeLessThan(0.6);
  });
});

describe("what a fight feels like", () => {
  /**
   * Fights have to be long enough to be a decision and short enough to be a
   * fight. The original tuning note for `MIN_ATTACK_TICKS` is that a player must
   * be able to read what is happening to them and choose to run.
   */
  it("lasts long enough to react to and not so long it drags", () => {
    const player = fists(bodyOf("player"));
    for (const id of ["rat", "cat", "snake"]) {
      const seconds =
        (duel(player, fists(bodyOf(id)), new Rng(3)).ticks * TICK_MS) / 1000;
      expect(seconds).toBeGreaterThan(2);
      expect(seconds).toBeLessThan(90);
    }
  });
});
