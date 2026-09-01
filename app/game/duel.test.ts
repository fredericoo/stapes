import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import {
  type BattlerDef,
  type FightingStats,
  fightingStats,
  resolveBattler,
} from "../lib/battler";
import { resolveWeapon, type WeaponItem } from "../lib/item";
import { experienceMultiplier, type Mastery, rating } from "../lib/mastery";
import { statusesById } from "../lib/status";
import { normalizeTiles } from "../lib/types";
import { attackIntervalMs, MIN_ATTACK_TICKS, rollAttack } from "./combat";
import { TICK_MS } from "./constants";
import { Duel, type DuelResult, MAX_DUEL_TICKS, runDuel } from "./duel";
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

/**
 * How long a body has to wait for its first swing.
 *
 * Both sides start ready, so the faster one lands first — which is what makes
 * speed worth having beyond the long-run rate. `./duel` seats its fighters on
 * the same terms; this is here for {@link damagePerSecond}, which swings at a
 * dummy rather than fighting anybody.
 */
const READY = 0;

/**
 * One fight to the end, in the terms the rest of this file is written in.
 *
 * The loop itself is `./duel`, which is production code: an assertion about
 * whether the numbers add up to a game is worth nothing if the fight it ran was
 * a private approximation of the one the world runs. What is left here is the
 * adapter — two stat blocks in, a result out — because a test that had to say
 * `{ stats }` at every call site would be harder to read for no gain.
 *
 * **No status catalogue is passed**, which switches statuses off entirely. That
 * is deliberate rather than an omission: what these tests measure is what the
 * masteries and the weapons are worth, and a snake's venom is a separate axis
 * that would put its thumb on every scale below. It also keeps the dice where
 * they were — an inflicted status costs a draw.
 */
function duel(
  a: FightingStats,
  b: FightingStats,
  rng: Rng,
  maxTicks = MAX_DUEL_TICKS,
): DuelResult {
  return runDuel({ swings: [a] }, { swings: [b] }, rng, { maxTicks });
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
  /**
   * **The climb never reverses, and it is deliberately not smooth.** Readiness
   * is the cube of what you brought, so the bottom of a requirement is nearly
   * flat — a couple of points into a five-point sword is still a sword you
   * cannot use, and the figures round to nothing. What matters is that no point
   * ever costs you anything and that the last one before the gate is worth a
   * great deal, which is what makes meeting it a moment rather than a gradient.
   */
  it("never goes backwards on the way to the requirement", () => {
    const curve = [];
    for (let blade = 0; blade <= required; blade++) {
      curve.push(damagePerSecond(armed(playerAt("blade", blade), SWORD)));
    }

    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    }
    // And the gate itself is a cliff rather than a step: the last point before
    // it is worth several times every point before that put together.
    expect(curve[required]!).toBeGreaterThan(curve[required - 1]! * 5);
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
  /**
   * **Past the requirement the weapon stops improving and the wielder does not.**
   * The two axes, in one comparison: readiness caps the moment the requirement
   * is met, so speed never moves again — but skill keeps paying damage and
   * accuracy for the whole rest of the scale, which is what makes a
   * hundred-Blade hero with a starter sword something other than a novice with
   * a starter sword.
   */
  it("keeps paying the wielder past the requirement, but not the weapon", () => {
    const met = armed(playerAt("blade", required), SWORD);
    const double = armed(playerAt("blade", required * 2), SWORD);
    const tenfold = armed(playerAt("blade", required * 10), SWORD);

    expect(damagePerSecond(double)).toBeGreaterThan(damagePerSecond(met));
    expect(damagePerSecond(tenfold)).toBeGreaterThan(damagePerSecond(double));

    // The weapon itself is done the moment its requirement is met.
    expect(double.spd).toBe(met.spd);
    expect(tenfold.spd).toBe(met.spd);
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

  /**
   * **A wall for a fresh player, and a fight for somebody who has earned the
   * right weapon.**
   *
   * The rung this names moved, and it moved on purpose. A rusty sword used to be
   * enough; it is not any more, because Toughness now buys defence and a wolf
   * carries three points of it — which eats most of what a starter blade can do
   * however well you swing it. What answers a wolf is the Knight's Sword, and
   * needing it is the whole point: defence is what makes a better weapon
   * necessary rather than merely nicer.
   *
   * Held from both ends, because either one alone is a worse game: a wolf a
   * fresh player can beat is not a rung, and one a properly-equipped player
   * cannot is a wall.
   */
  it("is out of reach until the right sword is earned, and then a real fight", () => {
    const fresh = winRate(fists(bodyOf("player")), fists(wolf));
    const starter = winRate(armed(playerAt("blade", 22), "rusty-sword"), fists(wolf));

    const earned = {
      ...bodyOf("player"),
      masteries: { ...bodyOf("player").masteries, blade: 20, toughness: 20, agility: 20 },
    };
    const properly = winRate(armed(earned, "knights-sword"), fists(wolf));

    expect(fresh).toBeLessThan(0.05);
    // A starter blade is no longer an answer to a wolf, whatever your Blade is.
    expect(starter).toBeLessThan(0.1);
    // The right weapon in trained hands makes it a coin-toss rather than a
    // formality in either direction.
    expect(properly).toBeGreaterThan(0.35);
    expect(properly).toBeLessThan(0.8);
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
    // **The creatures a fresh player is meant to take on.** The list is shorter
    // than it was, and deliberately: a wolf now carries enough defence to end a
    // bare-handed player in under a second, and a snake is not far behind. That
    // is the ladder working — see the wolf's own tests — but it means "long
    // enough to read and choose to run" is a promise about the fights you are
    // *supposed* to be in, not about every fight you can pick.
    for (const id of ["rat", "deer"]) {
      const seconds =
        (duel(player, fists(bodyOf(id)), new Rng(3)).ticks * TICK_MS) / 1000;
      expect(seconds).toBeGreaterThan(2);
      expect(seconds).toBeLessThan(90);
    }
  });

  /**
   * The other half of that, stated rather than left as a gap: the things above
   * your station kill you fast, and *that* is the signal to run. A ladder whose
   * every rung took the same time to lose to would have nothing to read.
   */
  it("ends a fight nobody should have picked quickly", () => {
    const player = fists(bodyOf("player"));
    for (const id of ["snake", "wolf"]) {
      const result = duel(player, fists(bodyOf(id)), new Rng(3));
      expect(result.winner).toBe("b");
      expect((result.ticks * TICK_MS) / 1000).toBeLessThan(5);
    }
  });
});

/**
 * The loop itself, rather than what the world's numbers add up to.
 *
 * Everything above reads `duel()` as a black box and asserts an ordering. These
 * assert the box: that the same seed replays the same fight, that the tick's
 * order is the session's, and that a status is a thing the fight can be lost to
 * rather than a decoration on the log.
 */
describe("the duel loop", () => {
  const statusDefs = statusesById(statusesJson as unknown[]);

  const dummy = (over: Partial<FightingStats>): FightingStats => ({
    ...fists(bodyOf("player")),
    ...over,
  });

  /**
   * The reason the dice are seeded at all: a fight somebody watched and wants to
   * ask about has to be the same fight when they run it again.
   */
  it("replays a fight blow for blow on the same seed", () => {
    const a = fists(bodyOf("player"));
    const b = fists(bodyOf("wolf"));
    const once = runDuel({ swings: [a] }, { swings: [b] }, new Rng(7));
    const twice = runDuel({ swings: [a] }, { swings: [b] }, new Rng(7));
    expect(twice).toEqual(once);
  });

  it("gives a different fight on a different seed", () => {
    const a = fists(bodyOf("player"));
    const b = fists(bodyOf("wolf"));
    const results = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map(
        (seed) => runDuel({ swings: [a] }, { swings: [b] }, new Rng(seed)).ticks,
      ),
    );
    expect(results.size).toBeGreaterThan(1);
  });

  /**
   * Both sides start ready, which is what makes speed worth having beyond the
   * long-run rate — and what makes the opening blow the fast one's.
   */
  it("lets the faster body land the opening blow", () => {
    const quick = dummy({ spd: 100, hitChance: 1, damage: 1, variance: 0 });
    const slow = dummy({ spd: 1, hitChance: 1, damage: 1, variance: 0 });
    const duel = new Duel({ swings: [quick] }, { swings: [slow] }, new Rng(1));
    const swings = duel.tick().filter((event) => event.kind === "swing");
    expect(swings.map((event) => event.by)).toEqual(["a", "b"]);

    const second = new Duel({ swings: [slow] }, { swings: [quick] }, new Rng(1));
    second.tick();
    // A whole cooldown on — `MIN_ATTACK_TICKS`, the floor between two blows —
    // and only the quick one has come round again, wherever it is sitting.
    const next: string[] = [];
    for (let tick = 0; tick < MIN_ATTACK_TICKS; tick++) {
      for (const event of second.tick()) {
        if (event.kind === "swing") next.push(event.by);
      }
    }
    expect(next).toEqual(["b"]);
  });

  /**
   * A body taken off the board does not swing back, which is the one thing a
   * tick's order decides that a player can actually feel.
   */
  it("takes the killing blow's target out before it can answer", () => {
    const killer = dummy({ spd: 100, hitChance: 1, damage: 999, variance: 0 });
    const victim = dummy({ spd: 100, hitChance: 1, damage: 999, variance: 0, flee: 0 });
    // Enough fights that the defender's one-in-twenty escape cannot carry the
    // assertion — see `MIN_CHANCE`.
    for (let seed = 0; seed < 50; seed++) {
      const duel = new Duel({ swings: [killer] }, { swings: [victim] }, new Rng(seed));
      const events = duel.tick();
      const answered = events.some(
        (event) => event.kind === "swing" && event.by === "b",
      );
      if (duel.winner !== "a") continue;
      expect(answered).toBe(false);
    }
  });

  /** No catalogue means no statuses, and — just as load-bearing — no draws. */
  it("leaves a venomous weapon inert when nothing is authored", () => {
    const snake = fists(bodyOf("snake"));
    expect(snake.statuses.length).toBeGreaterThan(0);

    const duel = new Duel(
      { swings: [snake] },
      { swings: [fists(bodyOf("player"))] },
      new Rng(3),
    );
    for (let tick = 0; tick < 200; tick++) duel.tick();
    expect(duel.b.statuses).toEqual([]);
  });

  /**
   * The other half of the same switch: with the catalogue in, a bite leaves
   * something behind, and what it leaves behind costs hit points on its own
   * clock.
   */
  it("poisons a body a snake bit, and the poison bites after the snake", () => {
    const snake = fists(bodyOf("snake"));
    const victim = dummy({ spd: 0, hitChance: 0, maxHp: 500 });

    // Long enough for a 10% venom to take at the snake's rate, over enough
    // seeds that the assertion is about the mechanism and not about one roll.
    const poisoned = [0, 1, 2, 3, 4].map((seed) => {
      const duel = new Duel({ swings: [snake] }, { swings: [victim] }, new Rng(seed), {
        statusDefs,
      });
      const ailments: number[] = [];
      for (let tick = 0; tick < 3_000; tick++) {
        for (const event of duel.tick()) {
          if (event.kind === "ailment") ailments.push(event.hp);
        }
      }
      return { ailments, statuses: duel.b.statuses };
    });

    const bitten = poisoned.filter((run) => run.ailments.length > 0);
    expect(bitten.length).toBeGreaterThan(0);
    for (const run of bitten) {
      // Harm, not help: every payout signed the way `advanceStatuses` hands it
      // over, and every one of them attributed to the status that owed it.
      expect(run.ailments.every((hp) => hp < 0)).toBe(true);
    }
  });

  /** A status that names nothing in the catalogue is skipped, never a throw. */
  it("survives a weapon whose status the catalogue has never heard of", () => {
    const attacker = dummy({
      hitChance: 1,
      statuses: [{ id: "nonesuch", chance: 100 }],
    });
    const duel = new Duel(
      { swings: [attacker] },
      { swings: [dummy({ flee: 0, maxHp: 500, hitChance: 0 })] },
      new Rng(1),
      { statusDefs },
    );
    for (let tick = 0; tick < 100; tick++) duel.tick();
    expect(duel.b.statuses).toEqual([]);
  });

  /** A fight nobody can win is called rather than hung. */
  it("calls a draw when neither side can get through", () => {
    const stone = dummy({ damage: 0, def: 99, maxHp: 50 });
    const result = runDuel({ swings: [stone] }, { swings: [stone] }, new Rng(1), {
      maxTicks: 500,
    });
    expect(result.winner).toBeNull();
    expect(result.ticks).toBe(500);
  });
});
