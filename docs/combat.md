# Combat

- `STRIKE_DURATION_MS` (`app/game/constants.ts`) must stay below the shortest gap between two blows, `MIN_ATTACK_TICKS` (`app/game/combat.ts`). A blow's lean has to finish before the next blow starts.
- `rollAttack` (`app/game/combat.ts`) draws its dice in a fixed order and count whatever the outcome: miss, dodge, damage band, guard, then one draw per authored status. `swingOdds` in `combatMetrics.ts` mirrors that order. Changing the order or skipping a draw conditionally desyncs the two; the draw-count assertions in `combat.test.ts` catch it.
- `outranksSwing` (`app/game/strike.ts`) lets a dodge beat a swing landing on the same tick only when the dodge's `elapsedMs` is exactly zero. This relies on leans being aged before any swing is resolved in the tick.
- `advanceStatuses` (`app/game/statuses.ts`) runs three phases in order: wind down remaining time, fire due periods, drop expired statuses. Its cadence accumulator is drained in a `while` loop, not reset, because `GameSession.update` can advance up to ten ticks in one call and a status owes every period in that span.
- `MAX_ARMOR_DEF` equals `MAX_WEAPON_DAMAGE` (`app/lib/item.ts`) because the two are subtracted from each other. Changing one alone changes whether armour can fully cancel the heaviest authored blow.
- To retune how much a kill is worth, change `XP_PER_DAMAGE` (`app/game/experience.ts`), not `XP_FOR_FIRST_LEVEL` (`app/lib/mastery.ts`). Stored experience is read against the levelling curve, so changing the curve re-levels every saved player.
