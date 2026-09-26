# Terrain, movement and sight

- `placeEntityOnSurface` (`app/game/mapMutations.ts`) appends onto the existing stack. Promoting the placement onto an empty level above would snap its feet down to that level's base.
- `moveColumn` (`app/game/mapMutations.ts`) writes source and destination in one `setStacks` call. A loop of `moveEntity` would, between iterations, leave a rider without the object it stands on, visible to gravity and pressure-plate passes.
- `settlePlates` (`app/game/pressurePlates.ts`) and `settleSignals` (`app/game/signals.ts`) each run one settle pass per call, not a loop to a fixed point. Plates or receivers wired to trigger each other oscillate once per tick instead of hanging a tick; a cascade resolves over the following ticks.
- A queued step must be takeable in the same tick the previous step commits (`GameSession.requestStep`). Otherwise every cell costs an extra tick and the server falls behind the client's prediction.
- `blocksSight` (`app/game/sight.ts`) returns `false` early for a cell whose solid block height is zero. Without it, an empty cell's level floor reads as a solid top and stops vertical looks through open air.
- `hasLineOfSight` (`app/game/sight.ts`) tests a crossing between levels against the ground of the lower end of the step: the column entered when looking down, the column left when looking up. Always reading the entered column stops an upward look at the floor its target stands on.
