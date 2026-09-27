# Terrain, movement and sight

- `settlePlates` (`app/game/pressurePlates.ts`) and `settleSignals` (`app/game/signals.ts`) each run one settle pass per call, not a loop to a fixed point. Plates or receivers wired to trigger each other oscillate once per tick instead of hanging a tick; a cascade resolves over the following ticks.
- A queued step must be takeable in the same tick the previous step commits (`GameSession.requestStep`). Otherwise every cell costs an extra tick and the server falls behind the client's prediction.
- `GameSession.advanceMotion` ends a walk with `reached` (`app/game/ticks.ts`), not a plain `>=`. `TICK_MS` is not exact, so twelve ticks add up to 399.99999999999994ms, and a 400ms step (a player wading in water, or the cat) would commit a tick after `RemoteSession` lands its prediction of the same step on the frame clock.
