# Plan: masteries

> Source: design conversation, not a PRD. The requirements are the decisions
> below; each phase states what it is demoable as.

No levels. A body is a set of masteries, and every number a fight is fought with
is derived from them. A rat and a player are the same kind of thing described by
the same fields — which is the point, and most of what makes this affordable.

---

## The rule that decides mastery vs. authored

**A mastery is a number that grows. Everything else about a body stays
authored.**

Masteries answer "how good is this at fighting". They are earned by players,
fixed on creatures, and they are the *only* input to attack, defence, health and
speed. Nothing else may set those.

What is not a mastery is anything that is a fact about the body rather than
about its competence: how far it reaches, how many floors it bothers to look up
and down, what it looks like. Those stay exactly where they are on the tile.

The dividing question is "would this improve with practice?". Reach would not —
a rat that has bitten a thousand things has the same jaw.

---

## Architectural decisions

Durable across every phase.

### The masteries

```ts
export type WeaponMastery = "fist" | "blade" | "blunt" | "ranged" | "arcane";
export type BodyMastery = "toughness" | "agility";
export type Mastery = WeaponMastery | BodyMastery;
```

`ItemMastery` in `app/lib/item.ts` already carries `blade | ranged | blunt |
magic`. Two changes: `magic` becomes `arcane`, and `fist` joins.

**`magic` and `arcane` were always one mastery wearing two names.** The original
spec had Arcane as a body mastery (magic cooldowns, magic damage) and `magic` as
the weapon mastery a staff answers to. Those are the same number: swinging a
staff is how you get better at magic, and being better at magic is what makes
the staff work. Splitting them would mean a wizard who trains one and casts with
the other. No tile on disk authors `magic` today, so the rename is free.

`fist` is new because unarmed has to answer to something — see natural weapons.

### Natural weapons — unarmed is a weapon

**Every battler carries a weapon. A rat's is its bite; a player's bare hands are
an item like any other.**

This is the load-bearing decision and it exists to preserve an axis that pure
masteries destroy. Today a rat is `atk 4, spd 68` and a snake is `atk 9, spd 45`
— fast-and-weak against slow-and-heavy. If damage, speed and accuracy all derive
from one Fist number, that distinction is unauthorable: a higher Fist gives more
damage *and* more speed, so the snake would also be the faster of the two.
`app/lib/battler.ts` already argues this exact point about collapsing stat pairs,
and it is right.

So a mastery does not *produce* a fight profile, it **scales an authored one**.
The rat's bite is authored fast and light, the snake's slow and heavy, and Fist
decides how well each animal uses what it has.

Three things fall out of it, all of them wanted:

- One code path. `resolveWeapon` and `effectiveBattler` serve players and rats
  alike, which is what `battlerOf` exists to guarantee.
- Fist gets a requirement to be measured against, so knuckles and cestus become
  a real item category rather than a gap in the rules.
- An author can hand a creature a weapon it cannot use — a goblin dragging a
  greatsword it flails with — because `q` applies to natural weapons too.

The cost: `applyWeaponStats` flips from **sum to source**. A weapon no longer
adds `atk 3` to what you already had; it *is* the damage, and the mastery scales
it. The doc comment at `app/game/equipment.ts:210` arguing "every field is a sum"
becomes wrong and is rewritten in the same change.

### Two stat blocks, and only one is authored

```ts
/** What an author writes on a tile. */
export type BattlerDef = {
  masteries: Partial<Record<Mastery, number>>;
  /** Bite, claw, fists. The same shape any held weapon has. */
  naturalWeapon: WeaponItem;
  range: number;
  sight: { up: number; down: number };
};

/** What a fight actually reads. Derived, never authored, never stored. */
export type FightingStats = {
  maxHp: number;
  /** The most one blow can do. Was `atk`. */
  damage: number;
  def: number;
  /** How reliably it finds its target; what a defender's flee is contested against. */
  accuracy: number;
  /** How much a connecting blow swings, as a share of `damage`. */
  variance: number;
  spd: number;
  /** Evasion. Deliberately unbounded — it is one side of a contest, not a chance. */
  flee: number;
  /** The chance a swing connects with anything at all. */
  hitChance: number;
  range: number;
  sight: { up: number; down: number };
};
```

`battlerOf` returns `FightingStats`, so every existing caller — the swing, the
cooldown, the health bar's maximum — keeps its shape. That is the whole reason
for the split: the single funnel at `GameSession.battlerOf` means one function
changes and the engine downstream does not notice.

`maxHp`, `atk`, `def`, `acc`, `flee` and `spd` leave the authored block. Five
creatures on disk carry them and none survive — see "Old numbers are discarded".

### The four numbers a weapon has

`damage`, `accuracy`, `variance`, `spd` — plus `def`, which is a stopgap until
armour exists.

**Accuracy and variance are separate because one number could not say both.**
`acc` originally answered three questions at once: whether a blow landed, how
true it was when it did, and how hard it was to dodge. That made it by far the
most load-bearing number on a weapon and left the obvious thing unauthorable —
something that finds its target reliably and is wildly unpredictable about what
it does when it gets there. Now `accuracy` is how reliably it lands and sits high
on most melee; `variance` is the risk dial.

### Landing: a term of its own

The original spec said accuracy carries the mastery penalty — "a novice swinging
a Double Axe hits almost nothing". It could not, as written: whiffing was the
defender's business and `acc` only widened the damage band, so at q=0.3 the
novice would connect with nearly every swing and merely roll erratically.

So landing became its own question:

```
hitChance = clampChance( accuracy/100 × min(1, q²) )
```

**Two independent failures, multiplied.** The weapon has to find its target, and
you have to be able to control it. The ratio is squared so the penalty bites
hardest low down, and capped at 1 because above q=1 there is no such thing as
more than landing — the surplus goes into speed and damage instead.

### Nothing is certain, in either direction

Every probability in a fight is held inside `[MIN_CHANCE, MAX_CHANCE]` = `[5%,
95%]`. A blow that always lands is not a fight and neither is one that never
does. It is also what lets a mastery be started at all: a weapon far beyond you
still connects sometimes, so it can still teach you.

One rule for every probability, which is why hit chance has no floor of its own —
two constants doing the same job in different places is one of them being
forgotten later.

**Dodging is a contest on a logistic curve**, not a subtraction:

```
dodgeChance = clampChance( logistic( (flee − accuracy) / CONTEST_SCALE ) )
```

Level pegging is a coin toss and every point either way bends it smoothly. It was
`flee − accuracy/2`, and the halving was a bodge to stop accuracy being the only
stat worth having — which it had to be while accuracy was also the only thing
deciding whether a blow landed. Once landing became its own question the linear
form collapsed: weapon accuracies rose, and every dodge in the game fell to about
two percent.

**Evasion is deliberately unbounded**, unlike every other percent stat. It is one
side of a contest rather than a probability, and the ceiling on the outcome
belongs to the chance band; clamping it at 100 as well put the ceiling in two
places and let the lower one win silently, which spent all of Agility by level 40.

### The attack lifecycle

```
draw all four dice → miss? → roll the damage → dodge? → subtract defence
```

**The damage is rolled before the dodge is asked about**, so a dodge knows what it
avoided — Agility is paid in proportion to the blow escaped, and by the time the
dodge resolves the blow no longer exists to be measured.
`AttackOutcome.potentialDamage` carries it.

**All four draws are taken before any is read.** The dice are seeded to be
reproducible, and a draw count that varied with the stats would make one
creature's numbers change what every creature after it rolls. Returning early
after drawing is the point of the arrangement, not a smell.

A miss and a dodge stay distinguishable: a dodge is the defender's skill and pays
them Agility, a miss is the attacker's failure and pays nobody.

### The mastery ratio, q

```
q = clamp(min over requirements of (mastery / requirement), 0, 1.25)
```

A weapon with no requirements is `q = 1` — it asks nothing and gives nothing
extra. Worst-ratio across all requirements: a Double Axe asking Blunt 35 and
Toughness 20 is held back by whichever of yours is further behind.

That is worth surfacing rather than hiding: a secondary requirement can quietly
halve `q` and the player will feel it as the weapon simply not working. Whatever
shows a weapon's requirements has to show them one by one.

| property | multiplier | q=0 | q=1.0 | q=1.25 |
|---|---|---|---|---|
| hit chance | accuracy × q², floored at 5% | 5% | accuracy | accuracy |
| attack speed | 0.55 + 0.45q | 55% | 100% | 111% |
| damage | 0.70 + 0.30q | 70% | 100% | 108% |

Applied to the weapon's own authored numbers, which is where a broadsword being
inherently slower than a knife lives.

### One ceiling, and a falloff

**Performance ceiling.** `q` caps at 1.25, so a Blunt-100 player holding a
requirement-1 club performs as though they had 1.25. No twinking, no
veteran-with-a-stick.

**Learning is a falloff, not a wall.** A weapon teaches its mastery at full rate
up to `requirement × 1.25`, then `1/x` — half at twice that, a quarter at four
times, never zero. Grinding a starter sword to 100 should be possible and absurd,
not impossible.

It was a wall, and the wall deadlocked. Experience comes from landing blows;
landing was `q²`; `q` is zero when your mastery is zero — so a weapon asking
anything of a mastery you had none of could never teach it. And a weapon asking
nothing had `trainingCeiling(0) = 0`, so it taught nothing either. **There was no
route from Blade 0 to Blade 1 anywhere in the game.** The 5% floor and the falloff
are the two halves of the fix.

**The falloff is one-directional.** A weapon far *above* you is not discounted,
because you already earn less from it by landing fewer blows. Charging twice for
the same difficulty is exactly what made the wall a deadlock.

### Body masteries are uncapped — provisionally

Toughness and Agility have no gear to train against, because there is no armour
slot: equipment is `weapon` and `bag` and nothing else. **Decision: they grind
freely for now.**

This is knowingly provisional and it reopens the exact hole the 1.25 rule closes.
A player who cannot raise Blade past their sword's ceiling can still raise
Toughness without limit, and since Toughness is 30% of Rating (below), the
long-run effect is a character whose ⭐ outruns their gear — which shrinks their
own XP multiplier and eventually starves them. It is self-limiting rather than
exploitable, which is why it is survivable, but it is not right.

The fix is armour slots, where Toughness trains against a breastplate's
requirement exactly as Blade trains against a sword's. Out of scope here; see
"Deferred".

### Rating

```
R = round(0.5 × bestWeaponMastery + 0.3 × toughness + 0.2 × agility)
```

**The fighting three only.** Breadth is free: training a second weapon costs
nothing in XP rate anywhere else, so a player can try a bow without being
punished for it in every fight they have with a sword. A flat sum would make
hyper-specialisation the only sane strategy.

The weights sum to 1, so **R is on the mastery scale** — a character with 40 in
everything rates 40. That is what lets ⭐ be R itself rather than a second number
to learn: `Rat (⭐7)` means the rat's masteries average out to 7.

**R is computed from raw masteries and never from equipment.** This is
load-bearing. If gear contributed, stripping naked would lower R, raise the
ratio `r = M/R`, and become the optimal farming strategy. Raw masteries are
monotonic and uncheatable. Gear no longer *bounds* R the way the old training
wall did — learning fades rather than stopping — but it still paces it, which is
enough: the two systems agree without creating the exploit.

### The experience curve

A mastery is a level; what is stored is the experience under it.

```
xpForLevel(L) = XP_FOR_FIRST_LEVEL × L²      (4 × L²)
levelForXp(x) = min(100, floor(√(x / 4)))
```

**Quadratic, because Rating makes the top of the scale matter more than the
bottom.** Half of R is the best weapon mastery, so on a linear curve a player's ⭐
would climb at a constant rate for ever and outrun everything the world has. Here
the *n*th point costs `2n − 1` firsts, so the ladder is something climbed rather
than a number that accrues.

The unit is a point of damage. Four of them at parity buys the first point of a
mastery, which puts a fresh player's first point of Blade about a dozen rats away
— near enough to the fight that caused it to read as cause and effect, and far
enough not to be confetti.

**A new player's masteries are seeded from the authored block as experience**, so
from the first tick every mastery is derived from one number apiece and nothing
reconciles "what you were given" against "what you have earned". Re-authoring the
`player` tile moves where new players begin and leaves everybody else where they
are, which is the honest answer — what a mastery records is that something
already happened.

Capped at 100: experience past the top of the scale is spent, not banked. A
mastery counting invisibly upward is a player wondering why nothing is happening.

### Experience

```
r = monsterRating / yourRating

multiplier(r) =
  r < 0.5   → 0
  r ≤ 1     → r⁸
  r > 1     → min(2, r²)
```

Continuous at `r = 1` — both arms give exactly 1. The hard zero below 0.5 is a
deliberate cliff rather than an asymptote: `0.5⁸` is 0.4% and a payout that small
reads as a bug, so it is stated as nothing. At `r = 0.7` you get 6%. Grinding
things beneath you is genuinely worthless, which is the point.

The upper arm is quadratic and caps at 2× around `r = 1.4`, so the meta cannot
become cheesing one impossible monster.

**Experience goes to the masteries that did the work; Rating is computed
whole.** Sandbagging one mastery to lower your R does not help, because R already
counts your best weapon rather than the one you happen to be holding.

| event | mastery | scales with |
|---|---|---|
| land a blow | the held weapon's | damage dealt |
| land a blow | agility, small share | damage dealt |
| take damage | toughness | **potential** damage |
| dodge | agility | **potential** damage |
| get missed | nothing | — |

Potential rather than actual, on both defensive rows, so armour never starves
you of Toughness. On a dodge no damage was ever rolled, so potential is the
attacker's damage ceiling — the most that blow could have been.

**A miss pays nobody, and the open question is closed.** Phase 3 was to decide
whether being missed should pay Agility, on the grounds that a fast defender is
part of why weapons miss. It is not, in this model: `hitChance` is the weapon's
accuracy times the wielder's `q²` and the defender contributes not one term to
it. Paying them would pay Agility for something Agility did not do, and it would
make standing in front of the least accurate thing in the world the best Agility
farm in it. Dodging is already the contested event, and it already pays.

### Per-target diminishing returns

Defensive experience decays per attacker: the *n*th payout from the same body is
worth `0.9ⁿ`, floored at 0.1, recovering over time once they stop hitting you.
Lives on `ActorRuntime` and is not durable — it is rebuilt like `hp` and `brain`
rather than owed continuity.

**This does not close AFK-tanking and is not claimed to.** Standing still in
front of something big is still positive Toughness; the decay only grinds it
down and stops a rat chewing your ankle from paying forever. Accepted knowingly.
The tighter fix — capping defensive XP against damage you dealt in the same
fight — needs per-fight bookkeeping the session does not have.

### Where masteries live

**Players: on the runtime, durable.** Beside `equipment` and `tags` in
`ActorRuntime`, and the third thing a world genuinely owes continuity for. Hit
points and brains are rebuilt from the tile on every load; a mastery cannot be,
because what it records is that something already happened. Written and made
durable in the same storage batch as the other two, under its own key prefix.

**Creatures: on the tile, fixed.** A rat does not get better at biting. Nothing
writes a creature's masteries at runtime, which is also why the learning falloff
has no work to do there.

### Old numbers are discarded, not migrated

Five battlers and two weapons exist on disk. **They are re-authored by hand
rather than converted**, because a conversion would be incoherent: the current
stats were authored on six independent 0–100 scales, and masteries share one
scale. Mapping `flee 45` to an Agility number and `maxHp 8` to a Toughness number
produces a rat rated mostly by its Agility, which is not what a rat is.

The most visible consequence, and it should be said plainly: **the player's 40 HP
comes down a long way.** Health derives from Toughness, and for the r-band to pay
anything at all a starting player and a rat have to be rating-comparable. A
player who is five times as durable as the only creature in the game is a player
for whom every fight in the game pays zero.

`def` goes to 0 for everyone until armour exists. Two tiles carry `def: 1` today
and nothing is lost.

---

## Scope

**In.** The mastery model and derived stats; natural weapons; `q`, the whiff
term, weapon requirements and the learning falloff; earning, Rating, the `r`
curve, diminishing returns, durability; the mastery list in the Equipment panel
and ⭐ on inspect; re-authoring the five creatures and the tile editor that
authors them.

**Out.** Armour and any slot beyond weapon and bag; `def` as a real number;
regeneration from Toughness; arcane cooldowns and magic damage; `range` moving
onto the weapon; a creature ladder wide enough to keep `r` in band.

That last one is the biggest risk in the plan and it is not a code problem. With
`r < 0.5` paying nothing and the useful band running roughly 0.7–1.4, the world
needs creatures at every rung a player passes through. There are five, and three
of them fight. **The system will be correct and the map will have nothing to
train on** until content follows. Phase 3 is where that becomes visible, and it
is worth authoring two or three creatures alongside it rather than discovering it
afterwards.

Phase 3 added the wolf and made the gap measurable rather than felt: `duel.test.ts`
now sweeps the reward curve one ⭐ at a time and fails if any rung between the
bottom and the top pays nothing. It passes, narrowly — see "What phase 3 proved,
and what it did not".

---

## Phase 1 — the model, no experience ✅ done

Demoable as: the same fights as today, with every number derived; the tile
editor shows a creature's stat block computed from its masteries.

Shipped, with three things learnt on the way:

- **The percent-stat constants had to move before anything else could.**
  `MIN_PERCENT_STAT` / `MAX_PERCENT_STAT` lived on the battler, and a body has no
  percent stats any more — a weapon's accuracy and speed are the only authored
  numbers left on that scale. (`acc` split into `accuracy` and `variance` later
  in phase 2; at this point it was still one field.) They are in `app/lib/item.ts` now, which is also
  what breaks the cycle: `battler.ts` needs `WeaponItem` for natural weapons, so
  the dependency has to run one way and `item.ts` cannot import back.
- **`app/lib/mastery.ts` exists for the same reason.** Both `item.ts` and
  `battler.ts` need the vocabulary and neither can own it.
- **The natural weapon is validated by the *exported* `weaponSchema`.** "A bite
  is a weapon like any other" has to be literally true including in what it is
  allowed to say; a second schema would be two definitions that could drift.

Shape as built:

- `Mastery` split into `WeaponMastery` (`fist | blade | blunt | ranged | arcane`)
  and `BodyMastery` (`toughness | agility`), with `Masteries` sparse and
  `masteryLevel` reading an absent key as zero.
- `BattlerDef` is masteries + natural weapon + range + sight. `FightingStats` is
  the derived block and `battlerOf` returns it, so the swing, the cooldown and
  the health bar's maximum were untouched below that one function.
- `applyWeaponStats` is gone. `weaponInHand` picks held-or-natural and
  `effectiveBattler` derives from it — replacement, not sum.
- `maxHpFrom` (`BASE_HP 8` + `HP_PER_TOUGHNESS 1`) and `fleeFrom` (`FLEE_BASE 20`
  + `FLEE_PER_AGILITY 2`). `FLEE_BASE` is non-zero because dodging is read
  against *half* the attacker's accuracy: at a floor of zero nothing below
  Agility 15 would ever dodge, and a mastery that pays nothing until it is a
  third grown is one nobody can start.
- `weaponForSave` split out of `itemForSave`, since `interactionsForSave` now
  writes a weapon inside the battler block. Masteries left at zero are dropped on
  save, matching how `masteryLevel` reads them.
- The five creatures re-authored on one shared scale, `q` deliberately absent.

The ladder it produced, for reference when the wolf is added:

| | rat | player | cat | snake |
|---|---|---|---|---|
| max HP | 12 | 16 | 15 | 20 |
| damage | 3 | 2 | 4 | 6 |
| speed | 70 | 55 | 62 | 30 |
| ⭐ | 6 | 7 | 9 | 12 |

**The player dropped from 40 HP to 16**, which the design predicted and which is
the point: at 40 they were five times as durable as the only creature in the
game, and every fight in it would have paid zero.

### What phase 1 proved

The rat and the snake are still tellable apart — fast-and-light against
slow-and-heavy — which was the one thing that would have killed natural weapons
had it failed. `brain.test.ts` asserts it through the real derivation rather than
off the authored block, since none of those three numbers is typed any more.

### Editor

`WeaponFields` is shared by the Item and Battle tabs, because a creature's bite
and a held sword are the same block; `StatField` came out of the copy each tab
had. The Battle tab's six inputs became seven mastery inputs, a natural-weapon
block, and a read-only **Fights as** row — the same arithmetic the simulation
runs, which is the only honest way to show numbers nobody types.

## Phase 2 — requirements, q, and missing ✅ done

Demoable as: pick up a sword you have no business holding and watch yourself
swing at air.

Shipped:

- `requirements?: Masteries` on `WeaponItem`. `masteriesSchema` moved to
  `mastery.ts` so `item.ts` could reach it — the battler block and a weapon's
  requirements are the same shape asking two different questions.
- `masteryRatio` (worst ratio, clamped to `[0, 1.25]`, `1` when nothing is
  asked) and `trainingCeiling` in `mastery.ts`. A requirement of **zero reads as
  absent**, which is what stops a round trip through the editor dividing by it.
- `acc` split into `accuracy` and `variance`, so a weapon can find its target
  reliably and still be wildly unpredictable about what it does when it gets
  there. `damageFraction` takes the spread directly instead of inferring it.
- `hitChanceFrom(q, accuracy) = clampChance(accuracy/100 × min(1, q²))`, plus the
  speed and damage floors, applied in `fightingStats` and nowhere else.
- `MIN_CHANCE` / `MAX_CHANCE` = `[5%, 95%]` on every probability in a fight, and
  `dodgeChance` became a logistic contest. `FLEE_PER_AGILITY` halved and the
  clamp on evasion came off, so Agility pays across the whole 0–100 scale
  instead of being spent by 40.
- `missed` and `potentialDamage` on `AttackOutcome`; the miss rolled *before* the
  dodge, the damage rolled *between* them; four unconditional draws.
- `DamageNumber` carries a `SwingOutcome` and became the one channel for all
  three receipts. A miss says `miss` and a dodge says `dodge`, both grey via
  `.damage-number--nothing`, in the same layer, font and rise as the numbers.
  **A placeholder for an animation and honest about it** — a whiff wants a swing
  that visibly goes wide, which is art; until then the word is what makes the
  penalty legible at all.
- `learningRate` replaced the training wall, and `MIN_HIT_CHANCE` folded into the
  shared chance band.
- `WeaponFields` authors accuracy, variance and requirements, each with a readout
  computed from the real curve. The editor has no wielder, so it cannot show a
  live `q` — the player-facing ratio is phase 4.

### The bootstrap deadlock, and how it was answered

Found while authoring, and it changed two rules.

**A weapon mastery you had none of could not be trained.** Experience comes from
landing blows; landing was `q²`; `q` is zero when your mastery is zero. So a
weapon asking anything at all could never teach the mastery it asked for. And
going round it did not work either — a weapon asking nothing had
`trainingCeiling(0) = 0`, so it taught nothing. There was **no path from Blade 0
to Blade 1 anywhere in the game.**

Both halves were fixed:

- **A floor under landing.** An outclassed weapon still connects sometimes, so
  it is poor rather than inert — and it can teach. This shipped as a dedicated
  `MIN_HIT_CHANCE` and was folded into the shared `[5%, 95%]` band later in the
  same phase, once every probability needed the same treatment.
- **The training ceiling stopped being a wall.** `learningRate` is full up to
  `requirement × 1.25` and then `1/x`: half at twice the ceiling, a quarter at
  four times, never zero. Grinding a starter sword to 100 should be possible and
  absurd, not impossible.

**The falloff is deliberately one-directional.** A weapon far *above* you is not
discounted, because you already earn less from it by landing fewer blows.
Charging twice for the same difficulty is exactly what made the wall a deadlock.

### What changed mid-phase, and why

Three rules were rewritten while phase 2 was being built, each because building
the previous one exposed a fault. The rules themselves are in "Architectural
decisions" above; what is worth keeping here is the order they fell in, because
each was invisible until the one before it landed.

1. **`acc` split into `accuracy` and `variance`.** Folding accuracy into the hit
   chance made it a third job for one number, and there was still no way to
   author "lands reliably, hits unpredictably" — the exact character a heavy
   weapon wants.
2. **Every probability got a `[5%, 95%]` band.** This absorbed the separate
   `MIN_HIT_CHANCE` floor, and it is what lets a mastery be started at all.
3. **Dodging became a logistic contest, and evasion lost its clamp.** Raising
   weapon accuracies to make hit chances sane had driven every dodge in the game
   to about two percent; fixing that with a curve then revealed that evasion
   clamped at 100, so Agility above 40 bought nothing.

The last one is the clearest example of the pattern: the first fix was correct
and produced a second bug one layer down, which only a table of actual numbers
made visible.

| Agility | 0 | 20 | 40 | 60 | 80 | 100 |
|---|---|---|---|---|---|---|
| dodges | 5% | 11% | 25% | 48% | 71% | 87% |

The authored weapons were re-pitched to match, since `accuracy` had been written
when it only widened a damage band:

| | accuracy | variance | reads as |
|---|---|---|---|
| rat bite | 78 | 15 | nips, always for the same little |
| rusty sword | 86 | 40 | dependable, 5–8 |
| snake fangs | 88 | 55 | an all-or-nothing lunge, 4–8 |

### The duel harness

`app/game/duel.test.ts` runs whole fights against the creatures actually on
disk — time-stepped, seeded, both sides drawing from one dice stream exactly as
a session does — and asserts the **orderings** the design promises rather than
the figures it currently produces. Orderings survive retuning; a win rate of
"87%" would have to be edited every time anybody touched a constant, and an
assertion that is always being edited is one nobody trusts.

It exists because every other test here checks one rule in isolation, and none
of them can tell you the only thing that finally matters: whether the numbers add
up to a game. **It found two faults in its first run**, both of them mine, both
authored by eye in phase 1 and never simulated.

- **A fresh player lost to a rat 100% of the time.** The player's fists were 2
  damage on a 48-tick swing against a rat's 3 damage on a 24-tick one. The design
  said the rat was the easy rung and the data said it was unwinnable.
- **The snake — the "slow and heavy" top rung — had the lowest damage per second
  of anything on the map**, and was the *easiest* fight. `attackIntervalMs` is
  geometric, so `spd 30` is a blow every five seconds; authoring heaviness as
  near-immobility took the creature out of the fight entirely. Speed dominates
  this curve far more than the raw numbers suggest.

Creature speeds now sit in a 50–68 band where the curve is legible, and weight is
carried by damage and hit points instead. The rusty sword was re-pitched too: at
5 damage on a 45 speed it was *slower than bare fists for one more damage*, so a
weapon the player had earned was still not worth drawing.

### The ladder, as it now simulates

| | rat | deer | player | cat | snake |
|---|---|---|---|---|---|
| hit points | 11 | 16 | 16 | 15 | 22 |
| damage | 2 | 0 | 4 | 4 | 8 |
| ticks/swing | 26 | — | 42 | 38 | 60 |
| ⭐ | 5 | 6 | 7 | 9 | 13 |

A fresh player beats a rat about two thirds of the time, is evenly matched with a
cat, and loses to a snake about two in three — the rungs the design asked for,
now demonstrated rather than asserted.

### The weapon, as authored

The rusty sword asks Blade 5, and does 8 damage at accuracy 88.

| wielder's Blade | q | lands | damage | vs bare fists |
|---|---|---|---|---|
| 0 | 0.00 | 31% | 6 | far worse |
| 5 | 1.00 | 88% | 8 | ~1.6× better |

A sword you have not learnt is worse than your own hands; meeting its requirement
makes it the best thing you own. That is the lesson in one table, and the harness
asserts both halves of it.

## Phase 3 — earning ✅ done

Demoable as: kill rats until Blade stops climbing, then notice the rats have
stopped paying.

**Everything it needed from the fight already existed.** `AttackOutcome` carries
`missed`, `dodged`, `damage` and `potentialDamage`, which is exactly the four
earning events' inputs; `learningRate` and `masteryRatio` were written and tested
in phase 2. What was missing was the storage, the Rating, and the `r` curve.

Shipped:

- **The experience curve** in `app/lib/mastery.ts` — `MasteryXp`, `xpForLevel`,
  `levelForXp`, and the seeding pair `xpFromMasteries` / `masteriesFromXp`. See
  "The experience curve" above for why it is quadratic and why a fresh player is
  seeded rather than floored.
- **`rating` and `experienceMultiplier`**, beside the curve because the reward is
  the only thing that reads a Rating and both are pure arithmetic on a block of
  masteries.
- **`app/game/experience.ts`**, holding what one swing is worth to each side.
  Its own module beside `combat.ts` and for the same reason: pure functions of
  one outcome, so every rule is testable by reading it. `attackerEarnings` and
  `defenderEarnings` know nothing about how a body is found or where its
  experience is kept.
- **`masteryXp` on `ActorRuntime`**, durable beside `equipment` and `tags` under
  its own `mast:` prefix and written in the same storage batch. Mutated in place
  rather than replaced, unlike a kit: it changes on almost every landed blow and
  nobody downstream holds a copy.
- **`GameSession.bodyOf`**, where the two halves of a body meet — the authored
  tile for everything that is a fact about it, the runtime for what it is good
  at. A resident is handed the authored block untouched, which is the whole of
  why a creature never improves: there is no runtime number to improve.
- **Per-target diminishing returns**, on the runtime, not durable, recovering one
  payout per ten quiet seconds.

### Three things learnt

**A creature's weapon masteries do nothing but set its ⭐.** Nothing on disk
authors requirements on a natural weapon, so `q = 1` for every creature always,
and Fist changes not one of a rat's fighting numbers. Only Toughness and Agility
reach the stat block. That makes a creature's Fist a pure difficulty *label* —
useful, because it is the dial that makes ⭐ agree with the fight, and dangerous,
because nothing but a duel makes a lie in it visible.

**Rating is equipment-free, so an armed player fights above their ⭐.** That is
the design working rather than failing — gear counting would make stripping naked
the optimal farm — but it means ⭐ is calibrated against bare fists, and a
sword-armed ⭐22 beats a wolf that rates 28 about a third of the time. The
creature ladder is pitched on the unarmed baseline, and a weapon is what closes
the gap, which is exactly the lesson phase 2's sword table teaches.

**Seeding is lazy, and that is what makes it free.** A player's experience is
read out of the authored block the first time anything asks for a body to fight
with — the same trick `hp` uses, and for the same reason: at the moment an actor
is created it may have no body on the board to read one from. A player who has
never fought has no stored block at all, which is correct: their masteries are
still exactly what the tile says, and the tile will say it again next time.

### The deer, which broke the ladder

Found by computing the ratings rather than by playing: **the deer rated ⭐10
against the player's ⭐9 while dealing zero damage.** It was the highest-paying
and the only risk-free target in the world, and killing one would have paid about
five times a rat.

Its ⭐ was carried almost entirely by an Agility of 40, authored in phase 2 for
how hard it is to *hit* — back when nothing read a creature's masteries except
its own stat block. Rating gave that number a second job it was never written
for.

Re-authored to Agility 24, so it rates ⭐7: below the rat, and below everything
else that can fight back. It keeps most of its evasion — a deer's real defence is
its legs, not its dodge — and `duel.test.ts` now asserts the general rule rather
than the instance: **nothing harmless may rate above anything that can hurt you.**

### The wolf

Above the snake at ⭐28, and the first creature a player cannot simply walk away
from. `walkDurationMs` 140 against the rat's 150 and the snake's 320.

| | rat | deer | player | cat | snake | wolf |
|---|---|---|---|---|---|---|
| hit points | 11 | 16 | 16 | 15 | 22 | 30 |
| damage | 2 | 0 | 4 | 4 | 8 | 6 |
| ticks/swing | 26 | — | 42 | 38 | 60 | 29 |
| ⭐ | 8 | 7 | 9 | 12 | 14 | 28 |

It is the clearest case for natural weapons: rat fast and light, snake slow and
heavy, **wolf fast and heavy**. One Fist number could not have said that — it
would have made the harder-hitting animal the slower one by construction.

Its pack converges on prey rather than clustering, and the mechanism is one
transition's position in the list: `in_los` on the nearest player is reachable
`from: "any"` and sits *above* the pack rules, so the moment a follower can see
what its leader is running at, it stops following and starts hunting. There is no
loitering half, unlike the rat's flock — a pack that stops once it is near its
neighbour never arrives anywhere.

**Wolves cannot call each other, and the brain is authored around that.** `heard`
matches only what a *player* said: `GameSession.hear` is the server's to call and
is deliberately not wired to `recordSpeech`, because a deer's yelp setting off
every brain in earshot is a world's worth of behaviour rather than a side effect.
The `hunting` state still howls on entry, which is flavour until that changes.

Three of them are placed in the clearing at the forest edge past the snakes,
which is what makes it a rung rather than a tile nobody has met.

### What phase 3 proved, and what it did not

A sweep of the reward curve one ⭐ at a time from a fresh player to the top of the
world says **there is no rung where nothing pays** — that assertion is in
`duel.test.ts`, and it is the one that catches a content gap before a play
session does. Above the wolf there is nothing, which is stated there too.

One hole is knowingly open:

- **The ⭐18–24 stretch is the wolf or nothing.** The snake has stopped paying and
  the wolf is a hard fight. That reads as a gate rather than a wall and is
  probably fine, but it is the narrowest part of the ladder and the first place a
  fifth creature belongs.

And one that looked like a hole and is not. **Feeding yourself to the hardest
thing in the world pays Toughness** — defensive experience is paid on potential
damage, so dying to a wolf is worth about two deaths per early point. That is
only an exploit while death is cheap, and it is not going to be: **the game is
going to be permadeath**, which prices the strategy at the whole character. Left
exactly as it is, deliberately.

## Phase 4 — the panels

Demoable as: an Equipment panel that shows what you are good at, and a rat you
can size up before you swing.

- Mastery list under the equipment slots: only those above zero, ordered by
  level descending, a progress bar each. Masteries ride beside
  `GameSnapshot.equipment`, which is already owner-private — what you are good at
  is yours, the same as what is in your bag.
- ⭐R beside the name on inspect.
- **The live `q` per requirement, on the item you are holding.** The editor
  cannot show this because it has no wielder, and without it the single most
  surprising rule in the system — that the worst ratio decides — is invisible to
  the player. A weapon held back by a Toughness requirement it never trains just
  reads as broken.

---

## Deferred

- **Armour slots**, and with them a real `def` and a ceiling for Toughness. The
  single largest thing this design is currently leaning on not existing.
- **`range` moves onto the weapon.** It is on the battler today, and once a
  natural weapon exists that is the honest home for it — a bow's reach is the
  bow's. Left alone in phase 1 because nothing needs it yet and moving it touches
  every authored creature on the way past.
- **Regeneration from Toughness**, and **arcane cooldowns and magic damage** —
  both named in the original design, neither with a mechanism to attach to yet.
