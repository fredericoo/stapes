import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import { type BattlerDef, type FightingStats, fightingStats, resolveBattler } from "../lib/battler";
import { isRanged, resolveWeapon, type WeaponItem } from "../lib/item";
import { experienceMultiplier, type Mastery, rating } from "../lib/mastery";
import { COMBAT_STATUS_ID, statusesById } from "../lib/status";
import { normalizeTiles } from "../lib/types";
import { MIN_ATTACK_TICKS, rollAttack, swingIntervalMs } from "./combat";
import { TICK_MS } from "./constants";
import { Duel, type DuelEvent, type DuelResult, MAX_DUEL_TICKS, runDuel, type Side } from "./duel";
import { Rng } from "./rng";

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

function playerAt(mastery: Mastery, level: number): BattlerDef {
  const player = bodyOf("player");
  return { ...player, masteries: { ...player.masteries, [mastery]: level } };
}

const READY = 0;

function duel(a: FightingStats, b: FightingStats, rng: Rng, maxTicks = MAX_DUEL_TICKS): DuelResult {
  return runDuel({ swings: [a] }, { swings: [b] }, rng, { maxTicks });
}

function winRate(a: FightingStats, b: FightingStats, fights = 200): number {
  let wins = 0;
  for (let seed = 0; seed < fights; seed++) {
    if (duel(a, b, new Rng(seed)).winner === "a") wins++;
  }
  return wins / fights;
}

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
      cooldown = swingIntervalMs(attacker);
      total += rollAttack(attacker, dummy, rng).damage;
    }
  }

  return total / fights / seconds;
}

function tickUntilSwing(duel: Duel): readonly DuelEvent[] {
  for (let tick = 0; tick < MAX_DUEL_TICKS; tick++) {
    const events = duel.tick();
    if (events.some((event) => event.kind === "swing")) return events;
  }
  throw new Error("nobody swung");
}

const fists = (body: BattlerDef) => fightingStats(body, body.naturalWeapon);
const armed = (body: BattlerDef, weaponId: string) => fightingStats(body, weaponOf(weaponId));

describe("learning a weapon", () => {
  const SWORD = "rusty-sword";
  const required = weaponOf(SWORD).requirements?.sharp ?? 0;

  it("asks something of the wielder at all", () => {
    expect(required).toBeGreaterThan(0);
  });

  it("never goes backwards on the way to the requirement", () => {
    const curve: number[] = [];
    for (let sharp = 0; sharp <= required; sharp++) {
      curve.push(damagePerSecond(armed(playerAt("sharp", sharp), SWORD)));
    }

    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    }

    const climb = curve.at(-1)! - curve[0]!;
    const steps = curve.slice(1).map((dps, i) => dps - curve[i]!);
    for (const step of steps) expect(step).toBeLessThan(climb / 2);
  });

  it("leaves an unlearnt sword hitting for everything it is authored to hit for", () => {
    const blade = weaponOf(SWORD);
    const novice = armed(playerAt("sharp", 0), SWORD);
    const trained = armed(playerAt("sharp", required), SWORD);

    expect(novice.damage).toBe(blade.damage);
    expect(novice.hitChance).toBeLessThan(trained.hitChance);
    expect(novice.haste).toBeLessThan(trained.haste);
  });

  it("leaves an unlearnt sword worse than bare fists", () => {
    const novice = playerAt("sharp", 0);
    expect(damagePerSecond(armed(novice, SWORD))).toBeLessThan(damagePerSecond(fists(novice)));
  });

  it("makes the same sword clearly better once its requirement is met", () => {
    const trained = playerAt("sharp", required);
    expect(damagePerSecond(armed(trained, SWORD))).toBeGreaterThan(damagePerSecond(fists(trained)));
  });

  it("keeps paying the wielder past the requirement, but not the weapon", () => {
    const met = armed(playerAt("sharp", required), SWORD);
    const double = armed(playerAt("sharp", required * 2), SWORD);
    const tenfold = armed(playerAt("sharp", required * 10), SWORD);

    expect(damagePerSecond(double)).toBeGreaterThan(damagePerSecond(met));
    expect(damagePerSecond(tenfold)).toBeGreaterThan(damagePerSecond(double));

    expect(double.haste).toBe(met.haste);
    expect(tenfold.haste).toBe(met.haste);
  });
});

describe("the weapon ladder", () => {
  const LADDERS: { mastery: Mastery; rungs: string[] }[] = [
    {
      mastery: "sharp",
      rungs: ["rusty-sword", "iron-sword", "knights-sword", "tempered-longsword"],
    },
    { mastery: "sharp", rungs: ["simple-axe", "broad-axe", "battleaxe"] },
    { mastery: "blunt", rungs: ["simple-hammer", "iron-mace", "war-maul"] },
    { mastery: "ranged", rungs: ["simple-bow", "hunting-bow", "war-bow"] },
  ];

  const asks = (id: string) => weaponOf(id).requirements?.[weaponOf(id).mastery] ?? 0;

  function climbing(mastery: Mastery, level: number, rungs: string[]): BattlerDef {
    const toughness = Math.max(
      bodyOf("player").masteries.toughness ?? 0,
      ...rungs.map((id) => weaponOf(id).requirements?.toughness ?? 0),
    );
    const at = playerAt(mastery, level);
    return { ...at, masteries: { ...at.masteries, toughness } };
  }

  const dpsWith = (id: string, mastery: Mastery, level: number, rungs: string[]) =>
    damagePerSecond(fightingStats(climbing(mastery, level, rungs), weaponOf(id)));

  for (const { mastery, rungs } of LADDERS) {
    describe(`${rungs[0]} to ${rungs.at(-1)}`, () => {
      for (let i = 1; i < rungs.length; i++) {
        const rung = rungs[i]!;
        const below = rungs[i - 1]!;
        const short = asks(rung) - 2;

        it(`is worth picking up ${rung} at ${mastery} ${short}, two short of it`, () => {
          expect(dpsWith(rung, mastery, short, rungs)).toBeGreaterThan(
            dpsWith(below, mastery, short, rungs),
          );
        });

        it(`makes ${rung} a real step up once it is earned`, () => {
          expect(dpsWith(rung, mastery, asks(rung), rungs)).toBeGreaterThan(
            dpsWith(below, mastery, asks(rung), rungs) * 1.2,
          );
        });

        if (i + 1 < rungs.length) {
          const twoUp = rungs[i + 1]!;
          it(`still leaves ${twoUp} a mistake at ${mastery} ${short}`, () => {
            expect(dpsWith(twoUp, mastery, short, rungs)).toBeLessThan(
              dpsWith(below, mastery, short, rungs),
            );
          });
        }
      }

      if (rungs.length >= 3) {
        it(`leaves ${rungs[2]} a mistake at ${mastery} 8`, () => {
          expect(dpsWith(rungs[2]!, mastery, 8, rungs)).toBeLessThan(
            dpsWith(rungs[0]!, mastery, 8, rungs),
          );
        });
      }
    });
  }
});

describe("two weapons on one rung", () => {
  const ROWS: [number, string[]][] = [
    [5, ["rusty-sword", "simple-hammer", "simple-bow"]],
    [10, ["iron-sword", "simple-axe"]],
    [15, ["knights-sword", "broad-axe", "iron-mace", "hunting-bow"]],
    [33, ["tempered-longsword", "battleaxe", "war-maul", "war-bow"]],
  ];

  function onRung(level: number, id: string): BattlerDef {
    const player = bodyOf("player");
    return {
      ...player,
      masteries: {
        ...player.masteries,
        fist: level,
        sharp: level,
        blunt: level,
        ranged: level,
        toughness: Math.max(
          player.masteries.toughness ?? 0,
          weaponOf(id).requirements?.toughness ?? 0,
        ),
      },
    };
  }

  const bandFor = (id: string): [number, number] =>
    isRanged(weaponOf(id)) ? [0.3, 0.55] : [0.9, 1.15];

  for (const [rung, ids] of ROWS) {
    const sword = ids[0]!;
    for (const id of ids.slice(1)) {
      it(`prices ${id} against ${sword} at ${rung}`, () => {
        const theirs = damagePerSecond(armed(onRung(rung, id), id));
        const swords = damagePerSecond(armed(onRung(rung, sword), sword));
        const [floor, ceiling] = bandFor(id);

        expect(theirs / swords).toBeGreaterThan(floor);
        expect(theirs / swords).toBeLessThan(ceiling);
      });
    }
  }
});

describe("the authored ladder", () => {
  const player = bodyOf("player");

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

  it("leaves the deer unable to win however long it is cornered", () => {
    expect(winRate(fists(bodyOf("deer")), fists(player))).toBe(0);
  });

  it("turns the snake winnable once the sword is learnt", () => {
    const trained = playerAt("sharp", weaponOf("rusty-sword").requirements?.sharp ?? 0);
    const snake = fists(bodyOf("snake"));

    expect(winRate(armed(trained, "rusty-sword"), snake)).toBeGreaterThan(
      winRate(fists(bodyOf("player")), snake),
    );
  });

  it("always reaches a conclusion", () => {
    for (const id of ["rat", "cat", "snake"]) {
      const result = duel(fists(player), fists(bodyOf(id)), new Rng(1));
      expect(result.winner).not.toBeNull();
    }
  });
});

describe("the ladder pays for climbing it", () => {
  const ratingOf = (id: string) => rating(bodyOf(id).masteries);
  const CREATURES = ["rat", "deer", "cat", "snake", "wolf"];

  it("never rates the harmless deer above anything that can hurt you", () => {
    for (const id of CREATURES) {
      if (id === "deer") continue;
      expect(ratingOf("deer")).toBeLessThan(ratingOf(id));
    }
  });

  it("pays a fresh player more for a rat than for a deer", () => {
    const me = ratingOf("player");
    expect(experienceMultiplier(ratingOf("rat"), me)).toBeGreaterThan(
      experienceMultiplier(ratingOf("deer"), me),
    );
  });

  it("leaves nothing to fight at no ⭐ between the bottom and the top", () => {
    const top = Math.max(...CREATURES.map(ratingOf));
    for (let stars = ratingOf("player"); stars <= top; stars++) {
      const best = Math.max(...CREATURES.map((id) => experienceMultiplier(ratingOf(id), stars)));
      expect(best).toBeGreaterThan(0.5);
    }
  });

  it("runs out above the best thing in the world", () => {
    const top = Math.max(...CREATURES.map(ratingOf));
    const best = Math.max(...CREATURES.map((id) => experienceMultiplier(ratingOf(id), top * 2)));
    expect(best).toBeLessThan(0.5);
  });
});

describe("the wolf", () => {
  const wolf = bodyOf("wolf");

  it("swings faster than the snake and hits harder than the rat", () => {
    expect(fists(wolf).spd).toBeGreaterThan(fists(bodyOf("snake")).spd);
    expect(fists(wolf).damage).toBeGreaterThan(fists(bodyOf("rat")).damage);
  });

  it("rates above every other creature in the world", () => {
    for (const id of ["rat", "deer", "cat", "snake"]) {
      expect(rating(wolf.masteries)).toBeGreaterThan(rating(bodyOf(id).masteries));
    }
  });

  it("is the fastest thing on the map on its feet", () => {
    const walkMs = (id: string) => byId[id]!.walkDurationMs ?? Infinity;
    for (const id of ["rat", "deer", "cat", "snake"]) {
      expect(walkMs("wolf")).toBeLessThan(walkMs(id));
    }
  });

  it("is out of reach until the right sword is earned, and then a real fight", () => {
    const fresh = winRate(fists(bodyOf("player")), fists(wolf));
    const starter = winRate(armed(playerAt("sharp", 22), "rusty-sword"), fists(wolf));

    const earned = {
      ...bodyOf("player"),
      masteries: { ...bodyOf("player").masteries, sharp: 15, toughness: 15, agility: 15 },
    };
    const properly = winRate(armed(earned, "knights-sword"), fists(wolf));

    expect(fresh).toBeLessThan(0.05);
    expect(starter).toBeLessThan(0.1);
    expect(properly).toBeGreaterThan(0.25);
    expect(properly).toBeLessThan(0.8);
  });
});

describe("what a fight feels like", () => {
  it("lasts long enough to react to and not so long it drags", () => {
    const player = fists(bodyOf("player"));
    for (const id of ["rat", "deer"]) {
      const seconds = (duel(player, fists(bodyOf(id)), new Rng(3)).ticks * TICK_MS) / 1000;
      expect(seconds).toBeGreaterThan(2);
      expect(seconds).toBeLessThan(90);
    }
  });

  it("ends a fight nobody should have picked quickly", () => {
    const player = fists(bodyOf("player"));
    for (const id of ["snake", "wolf"]) {
      const result = duel(player, fists(bodyOf(id)), new Rng(3));
      expect(result.winner).toBe("b");
      expect((result.ticks * TICK_MS) / 1000).toBeLessThan(9);
    }
  });
});

describe("the duel loop", () => {
  const statusDefs = statusesById(statusesJson as unknown[]);

  const dummy = (over: Partial<FightingStats>): FightingStats => ({
    ...fists(bodyOf("player")),
    ...over,
  });

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

  it("lets the faster body land the opening blow", () => {
    const quick = dummy({ spd: 100, hitChance: 1, damage: 1, variance: 0 });
    const slow = dummy({ spd: 1, hitChance: 1, damage: 1, variance: 0 });
    expect(new Duel({ swings: [quick] }, { swings: [slow] }, new Rng(1)).tick()).toEqual([]);

    const opening = (a: FightingStats, b: FightingStats) => {
      const duel = new Duel({ swings: [a] }, { swings: [b] }, new Rng(1));
      const swung: Side[] = [];
      for (let tick = 0; tick <= MIN_ATTACK_TICKS; tick++) {
        for (const event of duel.tick()) {
          if (event.kind === "swing") swung.push(event.by);
        }
      }
      return swung;
    };
    expect(opening(quick, slow)).toEqual(["a"]);
    expect(opening(slow, quick)).toEqual(["b"]);
  });

  it("lands both blows due on one tick, so two fighters who kill each other draw", () => {
    const lethal = dummy({ spd: 100, hitChance: 1, damage: 999, variance: 0, flee: 0 });
    let mutual = 0;
    for (let seed = 0; seed < 20; seed++) {
      const duel = new Duel({ swings: [lethal] }, { swings: [lethal] }, new Rng(seed));
      const swings = tickUntilSwing(duel).filter((event) => event.kind === "swing");
      expect(swings.map((swing) => swing.by)).toEqual(["a", "b"]);
      if (swings.some((swing) => swing.outcome.damage === 0)) continue;

      mutual++;
      expect(duel.finished).toBe(true);
      expect(duel.winner).toBeNull();
      expect(runDuel({ swings: [lethal] }, { swings: [lethal] }, new Rng(seed))).toEqual({
        winner: null,
        ticks: Math.round(duel.elapsedMs / TICK_MS),
        survivorHealth: 0,
      });
    }
    expect(mutual).toBeGreaterThan(0);
  });

  it("leaves a venomous weapon inert when nothing is authored", () => {
    const snake = fists(bodyOf("snake"));
    expect(snake.statuses.length).toBeGreaterThan(0);

    const duel = new Duel({ swings: [snake] }, { swings: [fists(bodyOf("player"))] }, new Rng(3));
    for (let tick = 0; tick < 200; tick++) duel.tick();
    expect(duel.b.statuses).toEqual([]);
  });

  it("poisons a body a snake bit, and the poison bites after the snake", () => {
    const snake = fists(bodyOf("snake"));
    const victim = dummy({ spd: 0, hitChance: 0, maxHp: 500 });

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
      expect(run.ailments.every((hp) => hp < 0)).toBe(true);
    }
  });

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
    expect(duel.b.statuses.map((status) => status.defId)).toEqual([COMBAT_STATUS_ID]);
  });

  it("puts both sides in combat on a swing, when statuses are on", () => {
    const withStatuses = new Duel(
      { swings: [dummy({ hitChance: 1 })] },
      { swings: [dummy({ hitChance: 1, maxHp: 500 })] },
      new Rng(1),
      { statusDefs },
    );
    tickUntilSwing(withStatuses);
    expect(withStatuses.a.statuses.map((s) => s.defId)).toEqual([COMBAT_STATUS_ID]);
    expect(withStatuses.b.statuses.map((s) => s.defId)).toEqual([COMBAT_STATUS_ID]);

    const without = new Duel(
      { swings: [dummy({ hitChance: 1 })] },
      { swings: [dummy({ hitChance: 1, maxHp: 500 })] },
      new Rng(1),
    );
    tickUntilSwing(without);
    expect(without.a.statuses).toEqual([]);
    expect(without.b.statuses).toEqual([]);
  });

  it("stops at maxTicks with no winner when neither side can get through", () => {
    const stone = dummy({ damage: 0, def: 99, maxHp: 50 });
    const result = runDuel({ swings: [stone] }, { swings: [stone] }, new Rng(1), {
      maxTicks: 500,
    });
    expect(result.winner).toBeNull();
    expect(result.ticks).toBe(500);
  });
});
