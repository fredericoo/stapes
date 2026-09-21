import { describe, expect, it } from "vitest";
import statusesJson from "../../data/statuses.json";
import tilesJson from "../../data/tiles.json";
import {
  type BattlerDef,
  type FightingStats,
  fightingStats,
  resolveBattler,
} from "../lib/battler";
import { isRanged, resolveWeapon, type WeaponItem } from "../lib/item";
import { experienceMultiplier, type Mastery, rating } from "../lib/mastery";
import { COMBAT_STATUS_ID, statusesById } from "../lib/status";
import { normalizeTiles } from "../lib/types";
import { MIN_ATTACK_TICKS, rollAttack, swingIntervalMs } from "./combat";
import { TICK_MS } from "./constants";
import {
  Duel,
  type DuelEvent,
  type DuelResult,
  MAX_DUEL_TICKS,
  runDuel,
  type Side,
} from "./duel";
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
 * How long a body has to wait for its first swing, here.
 *
 * Nothing, and deliberately not what `./duel` seats its fighters on: a fight
 * opens with an approach — half an interval before the first blow, see
 * `./combat`'s {@link SWING_WINDUP_SHARE} — and {@link damagePerSecond} is not a
 * fight. It swings at a dummy for twenty seconds to measure a *rate*, and the
 * windup is a shift in the start rather than a change in the rate: folding it in
 * would dock every weapon one opening blow's worth of a figure that is supposed
 * to be about the long run.
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
 *
 * **Through `swingIntervalMs` rather than `attackIntervalMs(spd)`**, which is
 * the whole of what "the swing rate" means now. This used to read `spd` alone
 * and was right to, back when falling short of a weapon's requirements was taken
 * out of `spd` — but the shortfall is a share of the *rate* and now rides on
 * `haste`, along with Agility. Reading `spd` alone measured a weapon nobody is
 * holding: it charged an unearned weapon for its accuracy and let it swing at
 * full speed.
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
      cooldown = swingIntervalMs(attacker);
      total += rollAttack(attacker, dummy, rng).damage;
    }
  }

  return total / fights / seconds;
}

/**
 * Run a fight until somebody swings, and hand back what that tick came to.
 *
 * The approach, spent: a duel's first blow lands half an interval in rather than
 * on the first tick, and almost nothing here is a test about that wait. Bounded
 * by `MAX_DUEL_TICKS` so a pair that cannot reach each other fails as a test
 * rather than as a hung one.
 */
function tickUntilSwing(duel: Duel): readonly DuelEvent[] {
  for (let tick = 0; tick < MAX_DUEL_TICKS; tick++) {
    const events = duel.tick();
    if (events.some((event) => event.kind === "swing")) return events;
  }
  throw new Error("nobody swung");
}

const fists = (body: BattlerDef) => fightingStats(body, body.naturalWeapon);
const armed = (body: BattlerDef, weaponId: string) =>
  fightingStats(body, weaponOf(weaponId));

describe("learning a weapon", () => {
  const SWORD = "rusty-sword";
  const required = weaponOf(SWORD).requirements?.sharp ?? 0;

  it("asks something of the wielder at all", () => {
    // The rest of this file is meaningless if the starter sword is free.
    expect(required).toBeGreaterThan(0);
  });

  /**
   * **The climb never reverses, and no single point of it is a cliff.**
   *
   * Handling costs a flat slice per point short, so the way to a requirement is
   * a ramp: every point a player puts in buys back the same share of the
   * weapon's accuracy and swing rate. What comes out the far end is not perfectly
   * even — the hit chance and the swing interval are both curves — but nothing
   * on it is a step you have to reach the top of before the weapon starts
   * working.
   *
   * **That is the change, and it is the whole of what this pass was for.** Under
   * the old cubed share the last point before the gate was worth several times
   * every point before it put together, which made a requirement something to
   * wait behind rather than something to reach for. See `../lib/battler`'s
   * {@link HANDLING_PER_POINT_SHORT}.
   */
  it("never goes backwards on the way to the requirement", () => {
    const curve: number[] = [];
    for (let sharp = 0; sharp <= required; sharp++) {
      curve.push(damagePerSecond(armed(playerAt("sharp", sharp), SWORD)));
    }

    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    }

    // No cliff: no one point is worth more than half of the whole climb.
    const climb = curve.at(-1)! - curve[0]!;
    const steps = curve.slice(1).map((dps, i) => dps - curve[i]!);
    for (const step of steps) expect(step).toBeLessThan(climb / 2);
  });

  /**
   * **An unearned weapon is a handicap, not a brick.** It is still worse than
   * your own hands — that is what makes the requirement mean something — but the
   * gap is aim and pace rather than force, and it is half what it used to be.
   * The blade does what it says on it from the first swing.
   */
  it("leaves an unlearnt sword hitting for everything it is authored to hit for", () => {
    const blade = weaponOf(SWORD);
    const novice = armed(playerAt("sharp", 0), SWORD);
    const trained = armed(playerAt("sharp", required), SWORD);

    expect(novice.damage).toBe(blade.damage);
    // What the novice is short of is aim and pace, and nothing else.
    expect(novice.hitChance).toBeLessThan(trained.hitChance);
    expect(novice.haste).toBeLessThan(trained.haste);
  });

  /**
   * The lesson the whole mastery system exists to teach, in one comparison: a
   * weapon you have not learnt is **worse than your own hands**. Not merely less
   * good than it could be — actually worse than not drawing it.
   */
  it("leaves an unlearnt sword worse than bare fists", () => {
    const novice = playerAt("sharp", 0);
    expect(damagePerSecond(armed(novice, SWORD))).toBeLessThan(
      damagePerSecond(fists(novice)),
    );
  });

  it("makes the same sword clearly better once its requirement is met", () => {
    const trained = playerAt("sharp", required);
    expect(damagePerSecond(armed(trained, SWORD))).toBeGreaterThan(
      damagePerSecond(fists(trained)),
    );
  });

  /**
   * **Past the requirement the weapon stops improving and the wielder does not.**
   * The two axes, in one comparison: handling caps the moment the requirement is
   * met, so the rate never moves again for the weapon's sake — but skill keeps
   * paying damage and accuracy for the whole rest of the scale, which is what
   * makes a hundred-Sharp hero with a starter sword something other than a
   * novice with a starter sword.
   *
   * **And this is where the grind now lives.** Nothing takes experience away
   * from a weapon you have outgrown, so a player may take Sharp anywhere they
   * like on a rusty sword; what makes that slow is `experienceMultiplier`, which
   * pays nothing for fights beneath their Rating.
   */
  it("keeps paying the wielder past the requirement, but not the weapon", () => {
    const met = armed(playerAt("sharp", required), SWORD);
    const double = armed(playerAt("sharp", required * 2), SWORD);
    const tenfold = armed(playerAt("sharp", required * 10), SWORD);

    expect(damagePerSecond(double)).toBeGreaterThan(damagePerSecond(met));
    expect(damagePerSecond(tenfold)).toBeGreaterThan(damagePerSecond(double));

    // The weapon itself is done the moment its requirement is met.
    expect(double.haste).toBe(met.haste);
    expect(tenfold.haste).toBe(met.haste);
  });
});

/**
 * Reaching one rung early is a choice; reaching two is a mistake.
 *
 * ## The two promises, and why they are one test
 *
 * A weapon ladder is only a ladder if both of these hold at once:
 *
 * - **Two points short of the next rung, that rung is already worth carrying.**
 *   A requirement you have to stand and wait behind is a wall, and the whole
 *   point of the shortfall being a handicap rather than a refusal is that
 *   reaching is allowed.
 * - **Two rungs up is still a mistake.** Otherwise there is no ladder: a fresh
 *   player walks to the best weapon in the world and swings it.
 *
 * They pull against each other, and neither the handling curve nor the authored
 * damage can deliver them alone — see `../lib/battler`'s {@link MIN_HANDLING},
 * where the arithmetic of the window between them is written down. That is
 * exactly why it is asserted here, against `data/tiles.json`, rather than as two
 * separate unit tests that both pass while the world is unplayable.
 *
 * ## Toughness is handed over rather than earned
 *
 * Heavy weapons ask for Toughness alongside their own mastery, and Toughness is
 * the one mastery nobody trains on purpose — it arrives from being hit. Leaving
 * it at the authored 5 would measure "has not been in many fights" rather than
 * "is short of this axe", so the body under test is given whatever Toughness the
 * family asks for and only the weapon mastery is moved.
 */
describe("the weapon ladder", () => {
  /**
   * Every family, bottom rung first, and only the rungs.
   *
   * The greatsword is deliberately absent: it asks Sharp 22 in a ladder that
   * steps 15 to 33, which makes it a heavy alternative to the knight's sword
   * rather than a tier of its own. Nothing here promises anything about it.
   */
  const LADDERS: { mastery: Mastery; rungs: string[] }[] = [
    { mastery: "sharp", rungs: ["rusty-sword", "iron-sword", "knights-sword", "tempered-longsword"] },
    { mastery: "sharp", rungs: ["simple-axe", "broad-axe", "battleaxe"] },
    { mastery: "blunt", rungs: ["simple-hammer", "iron-mace", "war-maul"] },
    { mastery: "ranged", rungs: ["simple-bow", "hunting-bow", "war-bow"] },
  ];

  /** What a weapon asks of the mastery it trains. */
  const asks = (id: string) => weaponOf(id).requirements?.[weaponOf(id).mastery] ?? 0;

  /** A body at this level in the family's mastery, with its Toughness earned. */
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

      /**
       * The promise as it was actually made: at mastery 8 — on the bottom rung
       * of every family — the weapon two rungs up is not worth grabbing.
       */
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

/**
 * Two weapons on the same rung are a choice, not a tier.
 *
 * **The heavy families were never a choice, because speed is not a linear cost.**
 * `attackIntervalMs` runs a curve 100:1 from end to end, so a battleaxe at `spd`
 * 30 waits 4.5s between blows where a longsword at 40 waits 2.9s — half again as
 * long for a quarter less speed. Measured before this was fixed, every slow
 * weapon in the world sat at 47–78% of the sword standing on its rung, which
 * makes "axe or sword" a question with one answer at every level of the game.
 *
 * The compensation is damage, because damage is the thing a heavy weapon is
 * supposed to have. Nothing else about any of them moved: they are still slower,
 * still less accurate, still ask for Toughness the sword does not.
 *
 * **Bows sit at about two fifths of the sword, and that is a floor with a
 * ceiling under it rather than near-parity.** A bow reaches six to ten cells
 * against a sword's one and a half, and what it pays for that is accuracy: an
 * archer misses more shots than they land until the mastery is well past what
 * the bow asks. A duel that starts both bodies in contact sees only the cost, so
 * the band here is deliberately low — the reach it buys is real and is not
 * measurable from here. The upper end is what stops the bow being the only sane
 * thing to carry; the lower end is what stops it being an ornament.
 */
describe("two weapons on one rung", () => {
  /** What each rung offers, sword first — the sword is the yardstick. */
  const ROWS: [number, string[]][] = [
    [5, ["rusty-sword", "simple-hammer", "simple-bow"]],
    [10, ["iron-sword", "simple-axe"]],
    [15, ["knights-sword", "broad-axe", "iron-mace", "hunting-bow"]],
    [33, ["tempered-longsword", "battleaxe", "war-maul", "war-bow"]],
  ];

  /** A player standing on a rung: every weapon mastery there, Toughness earned. */
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

  /**
   * The band a weapon has to sit in against the sword on its rung.
   *
   * A melee weapon is near parity: whatever it trades away in speed it is given
   * back in damage, and the question "axe or sword" has to have two answers.
   *
   * A bow is held well under it, because a bow is paid in reach and charged in
   * accuracy. In contact — which is the only fight this measure runs — that is
   * all cost and no benefit, so a band at parity would be asking for a weapon
   * that shoots ten cells *and* trades blows with a longsword.
   */
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
        // And never so far past it that the sword stops being a choice either.
        expect(theirs / swords).toBeLessThan(ceiling);
      });
    }
  }
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
    const trained = playerAt("sharp", weaponOf("rusty-sword").requirements?.sharp ?? 0);
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
   *
   * **"Earned" is Sharp 15, which is what the sword asks, and it used to be read
   * here as Sharp 20.** Twenty was five levels past the gate, and it was the
   * honest number back when the rungs were flat enough that out-levelling a wolf
   * was the only way past it. Now that each rung is a real step up, the sword is
   * the answer at the moment you can hold it — which is what this test has
   * always claimed to be about. The wolf still rates ⭐28 against this body's
   * ⭐15, so it is emphatically not a fight anybody has outgrown.
   */
  it("is out of reach until the right sword is earned, and then a real fight", () => {
    const fresh = winRate(fists(bodyOf("player")), fists(wolf));
    const starter = winRate(armed(playerAt("sharp", 22), "rusty-sword"), fists(wolf));

    const earned = {
      ...bodyOf("player"),
      masteries: { ...bodyOf("player").masteries, sharp: 15, toughness: 15, agility: 15 },
    };
    const properly = winRate(armed(earned, "knights-sword"), fists(wolf));

    expect(fresh).toBeLessThan(0.05);
    // A starter blade is no longer an answer to a wolf, whatever your Sharp is.
    expect(starter).toBeLessThan(0.1);
    // The right weapon in trained hands makes it a fight you can lose rather
    // than a formality in either direction.
    //
    // **The floor moved from 0.35 to 0.25 when armour became a draw** — see
    // `./combat`'s `guardFraction`. Both sides now meet a guard that is usually
    // below its face value, and the wolf gains more from that than the player
    // does: it hits for twelve against a player wearing almost nothing, where
    // the sword was already getting through most of a wolf's three points. The
    // rung is still a rung — a fresh player loses every time and an equipped one
    // wins better than a quarter of them — it is a harder one.
    expect(properly).toBeGreaterThan(0.25);
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
   *
   * **Eight seconds rather than five**, and the bound moved because the fight
   * did: every authored blow in the world was cut to 45% of what it was and the
   * wolf now swings half as often, so a losing fight takes about three times as
   * long to lose. That was the point of the rescale — a wolf used to finish a
   * bare-handed player inside two seconds, which is not long enough to read what
   * is happening and choose to run. What is being asserted is still "fast enough
   * to be a signal", and five seconds stopped being that number.
   *
   * **Nine rather than eight**, for a smaller reason: a fight now opens with an
   * approach — half an interval before either side's first blow, see `./combat`'s
   * {@link SWING_WINDUP_SHARE} — so every fight in the game is that much longer
   * than it was. It is a shift in the start, not a change in the rate.
   */
  it("ends a fight nobody should have picked quickly", () => {
    const player = fists(bodyOf("player"));
    for (const id of ["snake", "wolf"]) {
      const result = duel(player, fists(bodyOf(id)), new Rng(3));
      expect(result.winner).toBe("b");
      expect((result.ticks * TICK_MS) / 1000).toBeLessThan(9);
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
   * Both sides start half an interval short of ready, and the opening blow is
   * still the fast one's: half of a shorter interval is shorter. That is what
   * makes speed worth having beyond the long-run rate, and what stops the
   * heaviest weapon in the game getting its first blow for nothing — see
   * `./combat`'s {@link SWING_WINDUP_SHARE}.
   */
  it("lets the faster body land the opening blow", () => {
    const quick = dummy({ spd: 100, hitChance: 1, damage: 1, variance: 0 });
    const slow = dummy({ spd: 1, hitChance: 1, damage: 1, variance: 0 });
    // Nothing at all on the first tick, whichever pair it is: a fight opens with
    // an approach, and the shortest one in the game is half of MIN_ATTACK_TICKS.
    expect(
      new Duel({ swings: [quick] }, { swings: [slow] }, new Rng(1)).tick(),
    ).toEqual([]);

    // A whole cooldown on — `MIN_ATTACK_TICKS`, the floor between two blows —
    // and only the quick one has come round at all, wherever it is sitting.
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
    // Only the combat flag every swing puts on both sides, and no venom.
    expect(duel.b.statuses.map((status) => status.defId)).toEqual([
      COMBAT_STATUS_ID,
    ]);
  });

  /**
   * A status that reads `has_status('combat')` has to see the same fight here
   * that it would in the world, so the duel flags both sides on every swing —
   * and never when statuses are off, where the flag would only be dropped.
   */
  it("puts both sides in combat on a swing, when statuses are on", () => {
    const withStatuses = new Duel(
      { swings: [dummy({ hitChance: 1 })] },
      { swings: [dummy({ hitChance: 1, maxHp: 500 })] },
      new Rng(1),
      { statusDefs },
    );
    // Through the approach, since the flag goes on with the swing rather than
    // with the fight being picked. @see `./combat`'s {@link SWING_WINDUP_SHARE}
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
