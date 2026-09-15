/**
 * What each of the renderer's windows is drawn in under `?debug=1`.
 *
 * One table, shared by the outlines in the scene (`./WorldRenderer`) and the
 * rows of the panel beside them (`./debugPanel`), because the panel *is* the
 * legend — a row in a colour the rectangle no longer wears would be a legend
 * that lies, and there would be nothing on screen to catch it.
 *
 * Nothing else in the game reads these. The play chrome has its own palette
 * (`./GameRenderer`), and deliberately does not share one with this: a hover
 * yellow that shifted because somebody re-toned a debug grid would be a real
 * change made by accident.
 */
export const DEBUG_COLORS = {
  /** The square the player can actually see. */
  play: 0xffffff,
  /** Chunk columns that exist as geometry right now. */
  mesh: 0x4ade80,
  /** How far past the view the light bake reads. */
  light: 0xfbbf24,
  /** Chunk columns this client has been sent — its subscription. */
  held: 0x60a5fa,
} as const;
