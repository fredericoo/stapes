# Combat

- `STRIKE_DURATION_MS` (`app/game/constants.ts`) must stay below the shortest gap between two blows, `MIN_ATTACK_TICKS` (`app/game/combat.ts`). A blow's lean has to finish before the next blow starts.
- `rollAttack` (`app/game/combat.ts`) draws its dice in a fixed order and count whatever the outcome: miss, dodge, damage band, guard, then one draw per authored status. `swingOdds` in `combatMetrics.ts` mirrors that order. Changing the order or skipping a draw conditionally desyncs the two; the draw-count assertions in `combat.test.ts` catch it.
- `rotationOdds` (`app/game/combatMetrics.ts`) prices a body with a weapon in each hand as `Duel` (`app/game/duel.ts`) swings it: each hand in turn, each blow followed by its own weapon's `swingIntervalMs`. Changing how `Duel` picks the next hand or sets the cooldown after a blow desyncs the Arena's per-second figures from the fight; the two-weapon test in `combatMetrics.test.ts` catches it.
- To retune how much a kill is worth, change `XP_PER_DAMAGE` (`app/game/experience.ts`), not `XP_FOR_FIRST_LEVEL` (`app/lib/mastery.ts`). Stored experience is read against the levelling curve, so changing the curve re-levels every saved player.
